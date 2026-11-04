// 1.3 全部自动同意: per-Agent mode mapping, the allow-once pick, and the daemon auto-approve path (never when the mode is off).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../../daemon/src/agents/manager.js";
import { ThreadsStore } from "../../daemon/src/store/threads.js";
import { ProjectsStore } from "../../daemon/src/store/projects.js";
import { SettingsStore, parseSettingsPatch } from "../../daemon/src/store/settings.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import { initProviders } from "../../daemon/src/providers/registry.js";
import { autoApproveOption, pickAllowOnce, FULL_AUTO_NATIVE } from "../../daemon/src/providers/autoApprove.js";
import { acpConfigForEntry } from "../../daemon/src/providers/acp/specs.js";
import { createAcpProvider, cursorAcpCapabilities } from "../../daemon/src/providers/acp/provider.js";
import { catalogById } from "../../daemon/src/providers/catalog.js";
import { clampMode } from "../../daemon/src/providers/modes.js";
import { claudeArgs } from "../../daemon/src/providers/claude/cli.js";
import type { Config } from "../../daemon/src/config.js";
import type { Mode } from "../../daemon/src/providers/types.js";

process.env.AGENT_CONSOLE_MOCK = "1";

const ACP_OPTS = [
  { id: "allow-once", label: "Allow once", kind: "allow_once" },
  { id: "allow-always", label: "Allow always", kind: "allow_always" },
  { id: "reject-once", label: "Reject", kind: "reject_once" },
];

describe("pickAllowOnce", () => {
  it("prefers allow_once over allow_always (no permanent rule in the user's config)", () => {
    expect(pickAllowOnce(ACP_OPTS)?.id).toBe("allow-once");
    expect(pickAllowOnce([...ACP_OPTS].reverse())?.id).toBe("allow-once");
  });
  it("Codex / Claude / OpenCode option sets", () => {
    expect(pickAllowOnce([{ id: "accept", kind: "allow_once" }, { id: "acceptForSession", kind: "allow_always" }, { id: "decline", kind: "reject_once" }])?.id).toBe("accept");
    expect(pickAllowOnce([{ id: "allow", kind: "allow_once" }, { id: "allow_always", kind: "allow_always" }, { id: "deny", kind: "reject_once" }])?.id).toBe("allow");
    expect(pickAllowOnce([{ id: "once", kind: "allow_once" }, { id: "always", kind: "allow_always" }, { id: "reject", kind: "reject_once" }])?.id).toBe("once");
  });
  it("without kinds: an allow-looking option that is not 'always', never a reject", () => {
    expect(pickAllowOnce([{ id: "deny" }, { id: "always_allow" }, { id: "approve" }])?.id).toBe("approve");
    expect(pickAllowOnce([{ id: "reject" }, { id: "cancel" }])).toBeNull();
  });
  it("allow_always only when nothing narrower exists", () => {
    expect(pickAllowOnce([{ id: "a", kind: "allow_always" }, { id: "r", kind: "reject_once" }])?.id).toBe("a");
  });
});

describe("autoApproveOption", () => {
  const req = { kind: "execute", options: ACP_OPTS };
  it("never fires when the mode is not full-auto", () => {
    for (const m of ["default", "plan", "acceptEdits", "ask", null, undefined] as (Mode | null | undefined)[]) {
      for (const p of Object.keys(FULL_AUTO_NATIVE)) expect(autoApproveOption(m, p, req)).toBeNull();
    }
  });
  it("fires for every Agent that lets the daemon answer", () => {
    for (const p of ["claude", "codex", "cursor", "copilot", "opencode", "devin", "dsh", "mock"]) {
      expect(autoApproveOption("bypassPermissions", p, req)?.id).toBe("allow-once");
    }
  });
  it("leaves Pi extension dialogs, plan approvals and mode switches to the user", () => {
    expect(autoApproveOption("bypassPermissions", "pi", req)).toBeNull();
    expect(autoApproveOption("bypassPermissions", "claude", { kind: "plan", options: [{ id: "implement", kind: "allow_once" }] })).toBeNull();
    expect(autoApproveOption("bypassPermissions", "cursor", { kind: "switch_mode", options: ACP_OPTS })).toBeNull();
  });
});

describe("mode mapping per Agent", () => {
  const acp = (id: string) => {
    const entry = catalogById(id);
    expect(entry).toBeTruthy();
    return createAcpProvider(acpConfigForEntry(entry!, "0.0.0")!);
  };
  it("every Agent offers 全部自动同意 (bypassPermissions)", () => {
    for (const id of ["cursor", "devin", "opencode", "copilot", "pi", "dsh"]) {
      expect(acp(id).capabilities.modes, id).toContain("bypassPermissions");
    }
  });
  it("Cursor: Agent / 全部自动同意 / Plan / Ask", () => {
    expect(cursorAcpCapabilities.modes).toEqual(["default", "bypassPermissions", "plan", "ask"]);
  });
  it("OpenCode: full-auto runs in build; Copilot: allow-all; Devin: bypass", () => {
    const oc = acpConfigForEntry(catalogById("opencode")!, "0")!;
    expect(oc.modeMap?.bypassPermissions).toBe("build");
    expect(acpConfigForEntry(catalogById("copilot")!, "0")!.modeMap?.bypassPermissions).toBe("allow-all");
    expect(acpConfigForEntry(catalogById("devin")!, "0")!.modeMap?.bypassPermissions).toBe("bypass");
  });
  it("Pi has one mode, always auto; a new Pi conversation lands on it", () => {
    const pi = acp("pi");
    expect(pi.capabilities.modes).toEqual(["bypassPermissions"]);
    expect(clampMode(pi.capabilities.modes, "default")).toBe("bypassPermissions");
  });
  it("Claude: bypassPermissions goes to --permission-mode and is allowed at launch", () => {
    const a = claudeArgs({ model: null, permissionMode: "bypassPermissions", effort: null, resume: null });
    expect(a.join(" ")).toContain("--permission-mode bypassPermissions");
    expect(a).toContain("--allow-dangerously-skip-permissions");
    expect(claudeArgs({ model: null, permissionMode: "default", effort: null, resume: null })).not.toContain("--allow-dangerously-skip-permissions");
  });
  it("the first-warning flag is a valid setting; unknown keys still refused", () => {
    expect(parseSettingsPatch({ autoApproveWarned: true }).ok).toBe(true);
    expect(parseSettingsPatch({ autoApproveWarned: "yes" }).ok).toBe(false);
    expect(parseSettingsPatch({ defaultMode: "bypassPermissions" }).ok).toBe(true);
  });
});

// ---- the daemon path, with the mock Agent (/perm asks once for "npm test") ----
const cfg: Config = { port: 0, dataDir: "", token: "t", version: "0.0.0", idleExitMinutes: 60, buildStamp: "0" };
let dir: string, threads: ThreadsStore, manager: AgentManager, threadId: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(30); }
  throw new Error("waitFor timeout");
};
const events = () => threads.readEvents(threadId, 0, 50000);
const idle = () => waitFor(async () => (await threads.get(threadId))?.status === "idle", 15000);

describe("AgentManager auto-approve", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ac-auto-"));
    threads = new ThreadsStore(dir);
    const projects = new ProjectsStore(dir);
    initProviders();
    manager = new AgentManager(new Gateway(cfg), threads, projects, new SettingsStore(dir), new AttachmentStore(join(dir, "att")));
    const proj = await projects.create(dir);
    threadId = (await threads.create({ projectId: proj.id, provider: "mock" })).id;
  });
  afterEach(() => { manager.shutdown(); rmSync(dir, { recursive: true, force: true }); });

  it("mode on: the request is answered allow-once by the daemon, no card is written", async () => {
    await manager.setMode(threadId, "bypassPermissions");
    await manager.send(threadId, { text: "/perm" });
    await idle();
    const evs = await events();
    expect(evs.some((e) => e.type === "permission_request")).toBe(false);
    expect(evs.some((e) => e.type === "tool_call" && (e as { status?: string }).status === "ok")).toBe(true);
    expect(manager.runtimeInfo(threadId)?.pending ?? []).toHaveLength(0);
  }, 20000);

  it("mode off: nothing is answered for the user, the card waits", async () => {
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (await events()).some((e) => e.type === "permission_request"));
    await sleep(400);
    const evs = await events();
    expect(evs.some((e) => e.type === "permission_resolved")).toBe(false);
    expect(evs.some((e) => e.type === "tool_call" && (e as { status?: string }).status === "ok")).toBe(false);
    expect((await threads.get(threadId))?.status).toBe("running");
    await manager.interrupt(threadId);
    await idle();
  }, 20000);

  it("acceptEdits / plan are not full-auto either", async () => {
    await manager.setMode(threadId, "acceptEdits");
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (await events()).some((e) => e.type === "permission_request"));
    await sleep(300);
    expect((await events()).some((e) => e.type === "permission_resolved")).toBe(false);
    await manager.interrupt(threadId);
    await idle();
  }, 20000);

  it("a card already waiting is approved (allow once, marked auto) when the mode is switched on", async () => {
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (await events()).some((e) => e.type === "permission_request"));
    await manager.setMode(threadId, "bypassPermissions");
    await idle();
    const evs = await events();
    const res = evs.find((e) => e.type === "permission_resolved") as { optionId?: string; auto?: boolean } | undefined;
    expect(res?.optionId).toBe("accept");
    expect(res?.auto).toBe(true);
    expect(evs.some((e) => e.type === "tool_call" && (e as { status?: string }).status === "ok")).toBe(true);
  }, 20000);

  it("switching to another mode does not approve a waiting card", async () => {
    await manager.send(threadId, { text: "/perm" });
    await waitFor(async () => (await events()).some((e) => e.type === "permission_request"));
    await manager.setMode(threadId, "acceptEdits");
    await sleep(300);
    expect((await events()).some((e) => e.type === "permission_resolved")).toBe(false);
    await manager.interrupt(threadId);
    await idle();
  }, 20000);

  it("a plan approval is never auto-answered", async () => {
    await manager.setMode(threadId, "bypassPermissions");
    await manager.send(threadId, { text: "/plan" });
    await waitFor(async () => (await events()).some((e) => e.type === "permission_request"));
    await sleep(300);
    expect((await events()).some((e) => e.type === "permission_resolved")).toBe(false);
    await manager.interrupt(threadId);
    await idle();
  }, 20000);
});

describe("titleText (1.3 quotes)", () => {
  it("auto titles skip the leading quote blocks", async () => {
    const { titleText } = await import("../../daemon/src/agents/manager.js");
    expect(titleText("> [src/a.ts]\n> const x = 1;\n\n>  second\n\n这句什么意思？")).toBe("这句什么意思？");
    expect(titleText("帮我  启动\n一下")).toBe("帮我 启动 一下");
    expect(titleText("> only a quote")).toBe("only a quote");
  });
});
