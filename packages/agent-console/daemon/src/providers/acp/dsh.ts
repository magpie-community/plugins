// dsh (DeepSeek Harness) over ACP: start it on the model the conversation uses, so it can take images.
//
// dsh decides at ACP initialize whether it accepts image blocks, from the route in its `acp` config row
// (`dsh-acp`'s supportsAcpImagePrompts), not from the session's model. That row ships as
// deepseek-official / deepseek-v4-flash, which isn't in dsh's own catalog (deepseek-flash is) and isn't a
// route Magpie writes (Magpie writes `agent-default-model` and its `magpie*` routes, not the `acp` row).
// So dsh 0.2.1-rc.5 / 0.2.2-alpha.2 answer promptCapabilities.image: false and then refuse every image
// block ("inline image prompts were not advertised by this connection"), even on a model that sees images.
//
// The launcher takes `--patch <file>` overlays, applied after the profile and home patches. We start dsh
// with one that sets the `acp` row to the conversation's route ([provider, model], the value dsh's ACP model
// option uses). dsh then advertises image input exactly when that route declares it (a Magpie model it can
// see images with is written as `input: [text, image]`) and passes the image to the model.
// A model picked later in the same session goes by path: dsh's read_image tool opens it on a model that sees images.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DSH_ACP_ARGS = ["--profile", "acp"];

export type DshRoute = { provider: string; model: string };

/** dsh's ACP model value is JSON [provider, model]; anything else isn't a route */
export function dshRoute(model: string | null | undefined): DshRoute | null {
  if (!model) return null;
  try {
    const v = JSON.parse(model) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && v[0] && v[1]) {
      return { provider: v[0], model: v[1] };
    }
  } catch {
    /* not a dsh route */
  }
  return null;
}

/** The patch list that starts dsh's ACP on this route (JSON strings are valid YAML double-quoted scalars) */
export function dshRoutePatch(route: DshRoute): string {
  return [
    "# Agent Console: the route dsh's ACP starts on, so initialize advertises image input for it",
    "- id: acp",
    "  config:",
    `    provider: ${JSON.stringify(route.provider)}`,
    `    model: ${JSON.stringify(route.model)}`,
    "",
  ].join("\n");
}

/** Arguments for `dsh`: the ACP profile, plus a --patch overlay naming the route when the model is one */
export async function dshAcpArgs(model: string | null | undefined, dir = join(tmpdir(), "agent-console-dsh")): Promise<string[]> {
  const route = dshRoute(model);
  if (!route) return [...DSH_ACP_ARGS];
  const body = dshRoutePatch(route);
  const file = join(dir, `acp-route-${createHash("sha256").update(body).digest("hex").slice(0, 16)}.yml`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, body, { mode: 0o600 });
  return [...DSH_ACP_ARGS, "--patch", file];
}

/** The route a new dsh conversation starts on, as the manager picks it: a Magpie route first, else dsh's current one */
export function dshDefaultModel(models: { id: string }[], current: string | null): string | null {
  return models.find((m) => /magpie/i.test(m.id))?.id ?? current ?? models[0]?.id ?? null;
}
