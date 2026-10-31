import { readFile, writeFile } from "node:fs/promises";
import type { ClientApp } from "@agentclientprotocol/sdk";
import { methods } from "@agentclientprotocol/sdk";
import type { RespondAnswer } from "../types.js";
import type { ProviderEvent } from "../../timeline/types.js";
import { tr } from "../../util/i18n.js";

export type PermBridge = {
  push(ev: ProviderEvent): void;
  waitFor(requestId: string): Promise<RespondAnswer>;
  /** Cursor Auto-review: no permission card, allow is chosen automatically */
  autoAcceptPermissions?: () => boolean;
};

export function registerAcpClientHandlers(app: ClientApp, bridge: PermBridge): void {
  app.onRequest(methods.client.fs.readTextFile, async (ctx) => {
    const text = await readFile(ctx.params.path, "utf8");
    return { content: text };
  });
  app.onRequest(methods.client.fs.writeTextFile, async (ctx) => {
    await writeFile(ctx.params.path, ctx.params.content, "utf8");
    return {};
  });
  app.onRequest(methods.client.session.requestPermission, async (ctx) => {
    const tc = ctx.params.toolCall;
    const options = ctx.params.options.map((o) => ({
      id: o.optionId,
      label: o.name,
      kind: o.kind,
    }));
    if (bridge.autoAcceptPermissions?.()) {
      const allow =
        options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
      if (allow) return { outcome: { outcome: "selected", optionId: allow.id } };
    }
    const requestId = "p" + Math.random().toString(36).slice(2, 10);
    bridge.push({
      type: "permission_request",
      requestId,
      title: tc.title ?? tc.name ?? tr("tool.needsApproval"),
      kind: tc.kind ?? "tool",
      detail: tc.rawInput ?? undefined,
      options,
    });
    const answer = await bridge.waitFor(requestId);
    if (answer.cancelled) return { outcome: { outcome: "cancelled" } };
    const optionId = answer.optionId ?? options[0]?.id;
    if (!optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  });
}
