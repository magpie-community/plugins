// OpenCode / magpie plugin: Magnific image and video generation as tools.
// The one export is the plugin (hosts call every exported function as one);
// the catalog and the REST client live in the modules imported here. It has
// no dependency of its own: see args.mjs for how OpenCode gets zod fields.
import { homedir } from "node:os"
import { resolve } from "node:path"
import { argsOf, zodOf } from "./args.mjs"
import { buildBody, findModel, listModels } from "./catalog.mjs"
import { PROVIDER, createClient, credentialOf, download } from "./magnific.mjs"
import { API_BASE, LOCAL_BASE, nativeFetch, providerConfig, providerModels } from "./native.mjs"

// magpie ends a tool call after 55 seconds, so one call waits at most 50
// and hands back a task id that magnific_task picks up.
const MAX_WAIT = 50
const DEFAULT_WAIT = 40

export const MagnificPlugin = async (input, options) => {
  const o = { ...(options ?? {}) }
  const clientFor = (account) => createClient({ key: credentialOf(input, account).key, base: o.apiBase, fetch: o.fetch })
  // OpenCode runs tools in the project; magpie's host runs them in its own
  // config directory, where results would be lost, so there it is the home.
  const home = () => process.env.HOME || homedir()
  const inMagpie = !!input?.magpie || input?.project?.id === "magpie"
  const outputDir = (dir, ctx) => {
    const root = inMagpie ? home() : ctx?.directory || input?.directory || home()
    return resolve(root, dir || o.outputDir || process.env.MAGNIFIC_OUTPUT_DIR || "magnific-output")
  }
  const waitOf = (seconds) => Math.min(MAX_WAIT, Math.max(0, seconds ?? DEFAULT_WAIT))

  // What the agent reads back: saved files when the task is done, else the
  // task id to ask again with.
  async function report(task, dir, ctx) {
    const { done, failed, kind, ...out } = task
    if (failed) return JSON.stringify({ ...out, note: "The generation failed; nothing was saved." }, null, 2)
    if (!done) {
      return JSON.stringify({ ...out, note: `Still running. Call magnific_task with task="${task.task}" to wait for it and save the result.` }, null, 2)
    }
    try {
      const files = await download(task, outputDir(dir, ctx), { fetch: o.fetch, signal: ctx?.abort })
      return JSON.stringify({ ...out, files, note: "Saved to files. The urls expire 30 minutes after generation." }, null, 2)
    } catch (e) {
      return JSON.stringify({ ...out, note: `${e.message}. Call magnific_task with task="${task.task}" to try the download again; the urls expire 30 minutes after generation.` }, null, 2)
    }
  }

  const z = o.jsonArgs ? null : await zodOf()
  const tool = ({ description, properties, required, execute }) => ({ description, args: argsOf(properties, required, z), execute })
  const common = {
    wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT, description: `How long to wait for the result, 0 to ${MAX_WAIT} seconds (default ${DEFAULT_WAIT}). Videos usually take longer: the call then returns a task id for magnific_task.` },
    output_dir: { type: "string", description: "Folder to save results in, absolute or relative to the project (default: magnific-output in the project, or in the home folder when there is no project)." },
    account: { type: "string", description: "Which signed-in Magnific account to use, when there are several (e.g. magnific#ab12cd)." },
  }

  // magpie lists image-only and video-only models as its drawers and video
  // makers. OpenCode's picker would offer them for chat, so there the
  // provider stays without models and the tools do the work.
  const native = inMagpie ? {
    async config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= providerConfig(o.modelBase ?? API_BASE)
    },
    provider: {
      id: PROVIDER,
      models: async (provider) => ({ ...provider?.models, ...providerModels(o.modelBase ?? API_BASE) }),
    },
  } : {}

  return {
    ...native,
    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "Magnific API key" }],
      // OpenCode has no models of this provider to load anything for.
      ...(inMagpie ? { async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) throw new Error("No Magnific API key. Sign in with `magpie plugin login magnific`.")
        const client = createClient({ key: String(auth.key).trim(), base: o.apiBase, fetch: o.fetch })
        return { baseURL: LOCAL_BASE, apiKey: PROVIDER, fetch: nativeFetch(client, { fetch: o.fetch, pollMs: o.pollMs }) }
      } } : {}),
    },

    tool: {
      magnific_models: tool({
        description:
          "List the Magnific image and video generation models, or show one model's parameters. " +
          "Call it with `model` before magnific_generate to learn that model's parameter names and allowed values.",
        properties: {
          kind: { type: "string", enum: ["image", "video"], description: "Only image or only video models." },
          search: { type: "string", description: "Words the model id or name must contain, e.g. \"kling 3\" or \"veo\"." },
          model: { type: "string", description: "A model id: returns its parameters instead of the list." },
        },
        async execute({ kind, search, model }) {
          if (model) {
            const { id, name, kind: k, params } = findModel(model)
            return JSON.stringify({ id, name, kind: k, params }, null, 2)
          }
          const list = listModels({ kind, search })
          if (!list.length) return "No model matches. Call magnific_models without search to see all of them."
          return list.map((m) => `${m.id}  [${m.kind}]  ${m.name}`).join("\n")
        },
      }),

      magnific_generate: tool({
        description:
          "Generate an image or a video with Magnific and save it to disk. Costs credits of the user's Magnific account. " +
          "`model` is an id from magnific_models, e.g. text-to-image/nano-banana-pro, text-to-image/flux-2-pro, mystic, " +
          "video/kling-v3-pro, text-to-video/veo-3-1, image-to-video/veo-3-1. Parameter names differ per model: " +
          "check them with magnific_models first. Returns the saved file paths, or a task id when it is still running.",
        properties: {
          model: { type: "string", description: "Model id from magnific_models." },
          prompt: { type: "string", description: "What to generate. Sent as the model's `prompt` parameter." },
          params: { type: "object", description: "The model's other parameters, by the names magnific_models shows (aspect_ratio, duration, image, …). Image parameters take a public URL; those that accept base64 also take a local file path." },
          ...common,
        },
        required: ["model"],
        async execute({ model: id, prompt, params, wait_seconds, output_dir, account }, ctx) {
          const model = findModel(id)
          const body = buildBody(model, prompt, params)
          const client = clientFor(account)
          let task = await client.submit(model, body, ctx?.abort)
          const wait = waitOf(wait_seconds)
          if (!task.done && !task.failed && wait > 0) {
            task = await client.wait(model, task.task.slice(model.id.length + 1), wait, ctx?.abort, o.pollMs)
          }
          return report(task, output_dir, ctx)
        },
      }),

      magnific_task: tool({
        description:
          "Check a Magnific generation started by magnific_generate, wait for it, and save the result to disk when it is done. " +
          "Call it again while the status is not COMPLETED or FAILED.",
        properties: {
          task: { type: "string", description: "The task id magnific_generate returned, in the form <model>:<task id>." },
          ...common,
        },
        required: ["task"],
        async execute({ task: handle, wait_seconds, output_dir, account }, ctx) {
          const cut = String(handle).lastIndexOf(":")
          if (cut < 1) throw new Error("`task` must be the id magnific_generate returned: <model>:<task id>")
          const model = findModel(handle.slice(0, cut))
          const task = await clientFor(account).wait(model, handle.slice(cut + 1), waitOf(wait_seconds), ctx?.abort, o.pollMs)
          return report(task, output_dir, ctx)
        },
      }),
    },
  }
}
