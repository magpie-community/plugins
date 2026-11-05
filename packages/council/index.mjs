// council: several of magpie's models on one question, as tools for every
// agent (magpie's MCP server /mcp/magpie/tools). Nothing to set up: the models
// are read from magpie each time, each is called on the API it speaks with what
// it can take, and accounts that are signed out, out of allowance or failing
// are left out by themselves. Helpers live in lib/: every function this module
// exports is taken as a plugin.

import { Health } from "./lib/health.mjs"
import { find, start, wait } from "./lib/jobs.mjs"
import { askJob, menuView, modelsView, reviewJob, settle, voteJob } from "./lib/tasks.mjs"
import { words } from "./lib/text.mjs"

const LIMIT_MS = 50_000 // magpie gives a tool 55 seconds

const MODELS_ARG = {
  type: "array",
  items: { type: "string" },
  description:
    "Optional. Which models: a full id (provider/model, as council_models lists them), a short name (sonnet, opus, argon: the newest of that kind), a provider (its strongest model, or quickest with fast), or all. Add auto to have council pick the rest as usual, e.g. [\"auto\", \"sonnet\"]. Leave it out and council picks them all.",
}
const EFFORT_ARG = {
  type: "string",
  enum: ["auto", "low", "medium", "high", "max"],
  description: "Optional. How hard the models think: each is asked for its own nearest reasoning level, max for its highest; auto leaves each at its default.",
}
const FILES_ARG = {
  type: "array",
  items: { type: "string" },
  description: "Optional. Images to look at: local paths, http(s) URLs or data URLs (PNG, JPEG, GIF, WebP; up to 8). Only models that see images are asked then.",
}
const COMMON = {
  models: MODELS_ARG,
  count: { type: "number", description: "Optional. How many models when council picks (default 5 for ask, 4 for vote, 1 for review)." },
  effort: EFFORT_ARG,
  fast: { type: "boolean", description: "Optional. Quick models and light reasoning instead of the strongest ones." },
  files: FILES_ARG,
  choose: {
    type: "boolean",
    description:
      "Optional. Ask nobody yet: reply with the models that can be used now, to show the user and let them choose; then call again with models. Set it when the user wants to pick the models themselves.",
  },
}

const need = (v, name) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required: a non-empty string`)
}

export const CouncilTools = async (input = {}, options = {}) => {
  const o = options && typeof options === "object" ? options : {}
  const health = new Health(input?.directory)
  const waitMs = Math.min(LIMIT_MS, Number(o.wait) > 0 ? Number(o.wait) * 1000 : 45_000)

  // wait for the job as long as the call may, then the whole answer, or what is in so far and its id
  const answer = async (job, t0, abort) => {
    await wait(job, Math.min(waitMs, LIMIT_MS - (Date.now() - t0)), abort)
    return job.done ? job.text : job.view()
  }

  return {
    tool: {
      models: {
        description:
          "Lists every model in magpie right now, by provider: the API it is called on, what it can do (reasoning levels, images, context window), whether it has been answering lately, and ★ on the one council picks for each provider by itself. It starts with a check-up: which providers are ready, and for each one that isn't, why and how to fix it. Use it when something isn't answering, or to name models; ask, vote and review pick on their own.",
        args: {
          type: "object",
          properties: {
            refresh: { type: "boolean", description: "Optional. Forget what council remembers about failures and read everything again (after fixing an account)." },
            lang: { type: "string", enum: ["en", "zh"], description: "Optional. The language of the page; the system's by default." },
          },
        },
        async execute(args) {
          const lang = args?.lang === "zh" || args?.lang === "en" ? args.lang : undefined
          return modelsView(o, health, args?.refresh === true || args?.refresh === "true", lang)
        },
      },

      ask: {
        description:
          "Asks several models in magpie the same question at once and brings back every answer, for independent views: second opinions, trade-offs, blind spots, checking a fact. No setup: with no models named it takes the strongest model of each provider that has been answering, and leaves out accounts that are signed out, out of allowance or failing. web: true gives every model fresh web search results first; files lets the models that see images look at them. Answers taking longer than about 45 seconds come later: the reply then names who is still thinking and gives an id for council_result.",
        args: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, complete: the models don't see your conversation." },
            context: { type: "string", description: "Optional. Background the models need: code, an error, requirements, a document's text." },
            web: { type: "boolean", description: "Optional. Search the web first (magpie's own web search) and give every model the results." },
            ...COMMON,
          },
          required: ["question"],
        },
        async execute(args, ctx) {
          const t0 = Date.now()
          need(args?.question, "question")
          const s = settle(args, o, { effort: "auto", count: 5 })
          if (s.choose) return menuView(o, health, s, args.question, "council_ask", s.count)
          return answer(start("ask", askJob(o, health, args, s)), t0, ctx?.abort)
        },
      },

      vote: {
        description:
          "Anonymous vote: several models in magpie each write a proposal on their own, then every proposal is shown to them without its author and in shuffled order, and each votes for the best one on its merits. Returns the tally, the winning proposal in full and who wrote what. For when there are several ways to do something and you want an independent decision. With strong models it takes a minute or more: if it isn't done in about 45 seconds the reply gives an id for council_result.",
        args: {
          type: "object",
          properties: {
            question: { type: "string", description: "What to decide, with the goal and the constraints." },
            context: { type: "string", description: "Optional. Background the models need." },
            web: { type: "boolean", description: "Optional. Search the web first and give every model the results." },
            ...COMMON,
          },
          required: ["question"],
        },
        async execute(args, ctx) {
          const t0 = Date.now()
          need(args?.question, "question")
          const s = settle(args, o, { effort: "high", count: 4 })
          if (s.choose) return menuView(o, health, s, args.question, "council_vote", s.count)
          return answer(start("vote", voteJob(o, health, args, s)), t0, ctx?.abort)
        },
      },

      review: {
        description:
          "Has another model in magpie review a diff, code, a plan or a conclusion: it lists only real problems, each with severity, where, why and how to fix, and doesn't rewrite. With no model named it takes the strongest working model from a provider other than the calling agent's, for an independent look; name several models (or set count) for a cross-review.",
        args: {
          type: "object",
          properties: {
            content: { type: "string", description: "What to review: a diff, code, a plan or a conclusion." },
            goal: { type: "string", description: "Optional. What it is meant to achieve; the review checks it against this." },
            ...COMMON,
          },
          required: ["content"],
        },
        async execute(args, ctx) {
          const t0 = Date.now()
          need(args?.content, "content")
          const s = settle(args, o, { effort: "high", count: 1 })
          if (s.choose) return menuView(o, health, s, args.content, "council_review", s.count)
          return answer(start("review", reviewJob(o, health, args, s, ctx?.agent)), t0, ctx?.abort)
        },
      },

      result: {
        description:
          "Gets the rest of an ask, vote or review that was still going, by the id its reply gave. Waits up to about 45 seconds; if it still isn't done, it says what is in so far, and you can call it again.",
        args: { type: "object", properties: { id: { type: "string", description: "The id from the earlier reply, e.g. ask-k3j9x2." } }, required: ["id"] },
        async execute(args, ctx) {
          const t0 = Date.now()
          const job = find(args?.id)
          if (!job) return `${words("zh").gone}\n${words("en").gone}`
          return answer(job, t0, ctx?.abort)
        },
      },
    },
  }
}
