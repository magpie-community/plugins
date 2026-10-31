// MockProvider: registered only with AGENT_CONSOLE_MOCK=1. Persistent session, interruptible, with permissions and steering.
// Scripts by message prefix: default /perm /plan /ask /slow /error /long /exit; supports steer/interrupt/resume.
import type { Provider, ProviderSession, DetectResult, ModelInfo,
  Mode, SendInput, RespondAnswer, SlashCommand,
} from "./types.js";
import type { ProviderEvent } from "../timeline/types.js";
import { AsyncQueue } from "../util/queue.js";
import { editDetail } from "../agents/diff.js";
import { sortSlashCommands } from "./slash.js";

export const mockCapabilities = {
  resume: true,
  interrupt: true,
  steer: true,
  images: true,
  plan: true,
  questions: true,
  cost: true,
  effort: ["low", "medium", "high"],
  modes: ["plan", "default", "acceptEdits", "bypassPermissions"] as Mode[],
};

const rid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MockCrash extends Error {
  constructor() {
    super("__mock_crash__");
  }
}

type Ctx = {
  emit: (ev: ProviderEvent) => void;
  waitFor: (requestId: string) => Promise<RespondAnswer>;
  interrupted: () => boolean;
  steerText: () => string;
  replyPrefix: () => string;
  input: SendInput;
};

export class MockSession implements ProviderSession {
  events: AsyncIterable<ProviderEvent>;
  private q = new AsyncQueue<ProviderEvent>();
  private sessionId: string;
  private turnId: string | null = null;
  private turnNum = 0;
  private interruptFlag = false;
  private closed = false;
  private pendingReq = new Map<string, (a: RespondAnswer) => void>();
  private steered: string[] = [];
  private resumed = false;

  constructor(private o: {
    threadId: string;
    cwd: string;
    model: string | null;
    mode: Mode;
    effort: string | null;
    resumeId: string | null;
  }) {
    this.sessionId = o.resumeId ?? "mock-" + rid();
    this.resumed = o.resumeId !== null;
    this.events = this.q;
    this.q.push({ type: "provider_session_id", id: this.sessionId });
  }

  private emit(ev: ProviderEvent): void {
    (ev as { turnId?: string }).turnId ??= this.turnId ?? undefined;
    this.q.push(ev);
  }

  async send(input: SendInput): Promise<void> {
    if (this.closed) throw new Error("mock session closed");
    this.turnNum++;
    this.turnId = "u_" + Date.now().toString(36) + "_" + this.turnNum;
    this.interruptFlag = false;
    this.steered = [];
    this.emit({
      type: "turn_started",
      turnId: this.turnId,
      model: this.o.model ?? "demo-fast",
      mode: this.o.mode,
      effort: this.o.effort,
    });
    void this.runTurn(input);
  }

  private async runTurn(input: SendInput): Promise<void> {
    // itemIds are globally unique (a real provider creates new itemIds each time); sessionId can't be used:
    // a resumed session keeps the same providerSessionId and would collide with the old session's itemIds.
    // Same ids would merge the new turn's events into old entries, and the new reply would "fly" into an old bubble mid-timeline.
    const p = "i" + rid() + "_";
    const ctx: Ctx = {
      emit: (ev) => {
        const e = ev as { itemId?: string };
        if (e.itemId) e.itemId = p + e.itemId;
        this.emit(ev);
      },
      waitFor: (id) => this.waitFor(id),
      interrupted: () => this.interruptFlag || this.closed,
      steerText: () => this.steered.join("；"),
      replyPrefix: () => this.resumePrefix(),
      input,
    };
    try {
      const script = pickScript(input.text);
      await script(ctx);
      if (this.interruptFlag || this.closed) {
        this.emit({ type: "turn_ended", turnId: this.turnId!, status: "interrupted", durationMs: 0 });
      } else {
        this.emit({ type: "usage", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, costUsd: 0.0123 });
        this.emit({ type: "turn_ended", turnId: this.turnId!, status: "completed", durationMs: 6000, filesChanged: 1 });
      }
    } catch (e) {
      if (e instanceof MockCrash) {
        this.q.close(); // Crash: no turn_ended; the manager appends failed
        return;
      }
      if (this.interruptFlag || this.closed) {
        this.emit({ type: "turn_ended", turnId: this.turnId!, status: "interrupted", durationMs: 0 });
      } else {
        this.emit({ type: "turn_ended", turnId: this.turnId!, status: "failed", error: String((e as Error)?.message ?? e) });
      }
    }
  }

  respond(requestId: string, answer: RespondAnswer): void {
    const resolve = this.pendingReq.get(requestId);
    if (resolve) {
      this.pendingReq.delete(requestId);
      resolve(answer);
    }
  }

  private waitFor(requestId: string): Promise<RespondAnswer> {
    return new Promise((resolve) => {
      this.pendingReq.set(requestId, resolve);
    });
  }

  async interrupt(): Promise<void> {
    this.interruptFlag = true;
    // Pending permissions/questions are cancelled directly
    for (const [id, resolve] of this.pendingReq) {
      resolve({ cancelled: true });
      this.pendingReq.delete(id);
    }
    await sleep(120); // Guarantees interrupted within <1s
  }

  async steer(input: SendInput): Promise<void> {
    this.steered.push(input.text);
  }

  async setModel(model: string | null): Promise<void> {
    this.o.model = model;
  }
  async setMode(mode: Mode): Promise<void> {
    this.o.mode = mode;
  }
  async setEffort(effort: string | null): Promise<void> {
    this.o.effort = effort;
  }

  async listCommands(): Promise<SlashCommand[]> {
    return sortSlashCommands([
      { name: "perm", description: "演示授权弹窗", kind: "command" },
      { name: "plan", description: "演示计划审批", kind: "command" },
      { name: "ask", description: "演示提问", kind: "command" },
      { name: "slow", description: "慢速多步工具", kind: "skill" },
      { name: "error", description: "模拟失败", kind: "skill" },
    ]);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, resolve] of this.pendingReq) resolve({ cancelled: true });
    this.pendingReq.clear();
    this.q.close();
  }

  // With resumeId the first reply gets a "（已续接）" prefix
  private resumePrefix(): string {
    if (this.resumed && this.turnNum === 1) return "（已续接）";
    return "";
  }
}

// ---------- scripts ----------

async function scriptDefault(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const sleepA = (ms: number) => sleepAbortable(ms, ctx);

  emit({ type: "reasoning_delta", itemId: "r1", text: "让我看看项目结构…" });
  await sleepA(500);
  emit({ type: "reasoning", itemId: "r1", text: "让我看看项目结构…需要先读几个文件。" });

  const tools = [
    { id: "t1", name: "Read", input: { file_path: ctx.input.text.includes("abs") ? "D:/x/a.ts" : "src/index.ts" } },
    { id: "t2", name: "Read", input: { file_path: "package.json" } },
  ];
  for (const t of tools) {
    emit({ type: "tool_call", itemId: t.id, kind: "read", title: `读取 ${t.input.file_path}`, status: "running", input: t.input });
    if (await sleepA(300)) return;
    emit({ type: "tool_call", itemId: t.id, kind: "read", title: `读取 ${t.input.file_path}`, status: "ok", output: "…文件内容…", durationMs: 300 });
  }

  emit({ type: "tool_call", itemId: "t3", kind: "search", title: '搜索 "TODO"', status: "running", input: { pattern: "TODO" } });
  await sleepA(200);
  emit({ type: "tool_call", itemId: "t3", kind: "search", title: '搜索 "TODO"', status: "ok", output: "3 处匹配" });

  const oldStr = "const x = 1;\nconst y = 2;\nreturn x + y;";
  const newStr = "const x = 1;\nconst y = 2;\nconst z = 3;\nreturn x + y + z;";
  emit({
    type: "tool_call", itemId: "t4", kind: "edit", title: "编辑 src/index.ts", status: "running",
    input: { file_path: "src/index.ts", old_string: oldStr, new_string: newStr },
    detail: editDetail({ path: "src/index.ts", old: oldStr, new: newStr }),
  });
  if (await sleepA(400)) return;
  emit({
    type: "tool_call", itemId: "t4", kind: "edit", title: "编辑 src/index.ts", status: "ok",
    detail: editDetail({ path: "src/index.ts", old: oldStr, new: newStr }), durationMs: 400,
  });

  emit({ type: "tool_call", itemId: "t5", kind: "bash", title: "运行 npm test", status: "running", input: { command: "npm test" } });
  for (let i = 1; i <= 20; i++) {
    if (await sleepA(60)) return;
    emit({ type: "tool_output_delta", itemId: "t5", text: `第 ${i} 行输出\n` });
  }
  emit({ type: "tool_call", itemId: "t5", kind: "bash", title: "运行 npm test", status: "ok", output: "✓ 全部通过", exitCode: 0, durationMs: 1200 });

  emit({
    type: "todo",
    items: [
      { text: "分析需求", status: "done" },
      { text: "修改代码", status: "done" },
      { text: "跑测试", status: "done" },
      { text: "写文档", status: "in_progress" },
    ],
  });
  await sleepA(300);

  const reply = ctx.replyPrefix() + mockReply(ctx);
  for (const ch of chunkText(reply, 40)) {
    if (await sleepA(30)) return;
    emit({ type: "assistant_delta", itemId: "m1", text: ch });
  }
  emit({ type: "assistant_message", itemId: "m1", text: reply });
}

async function scriptPerm(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const requestId = "perm-" + rid();
  emit({
    type: "permission_request",
    requestId,
    title: "运行 npm test",
    kind: "tool",
    detail: { command: "npm test", cwd: ".", toolName: "Bash" },
    options: [
      { id: "accept", label: "允许", kind: "allow_once" },
      { id: "acceptForSession", label: "本对话都允许", kind: "allow_always" },
      { id: "decline", label: "拒绝", kind: "reject_once" },
    ],
  });
  const ans = await ctx.waitFor(requestId);
  if (ans.cancelled || ans.optionId === "decline") {
    emit({ type: "tool_call", itemId: "p1", kind: "bash", title: "运行 npm test", status: "failed", output: "已被用户拒绝", exitCode: 1 });
    emit({ type: "assistant_message", itemId: "pm", text: "已按你的要求跳过该操作。" });
    return;
  }
  emit({ type: "tool_call", itemId: "p1", kind: "bash", title: "运行 npm test", status: "running", input: { command: "npm test" } });
  if (await sleepAbortable(500, ctx)) return;
  emit({ type: "tool_call", itemId: "p1", kind: "bash", title: "运行 npm test", status: "ok", output: "✓ 12 个测试通过", exitCode: 0, durationMs: 500 });
  emit({ type: "assistant_message", itemId: "pm", text: "测试通过了。" });
}

async function scriptPlan(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  emit({
    type: "plan",
    itemId: "plan1",
    markdown: "## 实施计划\n\n1. 改 `src/index.ts` 入口\n2. 更新测试\n3. 跑一遍 e2e",
    entries: [
      { step: "改 src/index.ts 入口", status: "pending" },
      { step: "更新测试", status: "pending" },
      { step: "跑一遍 e2e", status: "pending" },
    ],
  });
  const requestId = "perm-" + rid();
  emit({
    type: "permission_request",
    requestId,
    title: "实施这个计划？",
    kind: "plan",
    detail: { markdown: "见上方计划" },
    options: [
      { id: "implement", label: "开始实施", kind: "allow_once" },
      { id: "reject", label: "拒绝", kind: "reject_once" },
    ],
  });
  const ans = await ctx.waitFor(requestId);
  if (ans.cancelled || ans.optionId === "reject") {
    emit({ type: "assistant_message", itemId: "pm", text: "好的，请告诉我怎么改。" });
    return;
  }
  emit({ type: "tool_call", itemId: "pl1", kind: "edit", title: "编辑 src/index.ts", status: "ok" });
  await sleepAbortable(400, ctx);
  emit({ type: "assistant_message", itemId: "pm", text: "已按计划改完入口和测试。" });
}

async function scriptAsk(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const requestId = "q-" + rid();
  emit({
    type: "question",
    requestId,
    questions: [
      {
        id: "q1",
        header: "部署目标",
        question: "要部署到哪个环境？",
        options: [
          { id: "staging", label: "Staging" },
          { id: "prod", label: "生产环境" },
        ],
      },
      {
        id: "q2",
        header: "备注",
        question: "还有什么要补充的？",
        freeText: true,
      },
    ],
  });
  const ans = await ctx.waitFor(requestId);
  const env = ans.answers?.q1 ?? "（未选）";
  const note = ans.answers?.q2 ?? "";
  emit({ type: "assistant_message", itemId: "am", text: `收到：部署到 ${env}${note ? `，备注「${note}」` : ""}。` });
}

async function scriptSlow(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  for (let i = 1; i <= 6; i++) {
    const id = "s" + i;
    emit({ type: "tool_call", itemId: id, kind: "bash", title: `步骤 ${i}/6`, status: "running", input: { command: `step ${i}` } });
    if (await sleepAbortable(2000, ctx)) return;
    emit({ type: "tool_call", itemId: id, kind: "bash", title: `步骤 ${i}/6`, status: "ok", output: `步骤 ${i} 完成`, durationMs: 2000 });
  }
  emit({ type: "assistant_message", itemId: "sm", text: "6 个步骤全部跑完。" });
}

async function scriptError(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  emit({ type: "tool_call", itemId: "e1", kind: "bash", title: "运行 ./build.sh", status: "running", input: { command: "./build.sh" } });
  await sleepAbortable(800, ctx);
  throw new Error("构建失败：找不到模块 foo（模拟错误）");
}

async function scriptLong(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  emit({ type: "assistant_delta", itemId: "L1", text: "" });
  for (let i = 0; i < 5000; i++) {
    if (i % 100 === 0 && ctx.interrupted()) return;
    emit({ type: "assistant_delta", itemId: "L1", text: `块${i} ` });
    if (i % 200 === 0) await sleep(0);
  }
  emit({ type: "assistant_message", itemId: "L1", text: "（5000 个增量合并后的长文）" });
}

async function scriptExit(_ctx: Ctx): Promise<void> {
  await sleep(300);
  throw new MockCrash();
}

function pickScript(text: string): (ctx: Ctx) => Promise<void> {
  const t = text.trim();
  if (t.startsWith("/perm")) return scriptPerm;
  if (t.startsWith("/plan")) return scriptPlan;
  if (t.startsWith("/ask")) return scriptAsk;
  if (t.startsWith("/slow")) return scriptSlow;
  if (t.startsWith("/error")) return scriptError;
  if (t.startsWith("/long")) return scriptLong;
  if (t.startsWith("/exit")) return scriptExit;
  return scriptDefault;
}

async function sleepAbortable(ms: number, ctx: Ctx): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ctx.interrupted()) return true;
    await sleep(Math.min(20, Math.max(1, ms - (Date.now() - start))));
  }
  return ctx.interrupted();
}

function chunkText(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function mockReply(ctx: Ctx): string {
  const base = [
    "好的，我已经按你的要求改好了。",
    "",
    "## 改动",
    "- `src/index.ts`：把返回逻辑补成三变量求和",
    "- 新增一行常量 `z`",
    "",
    "```ts",
    "const z = 3;",
    "return x + y + z;",
    "```",
    "",
    "| 文件 | 变更 |",
    "|---|---|",
    "| src/index.ts | +2/-1 |",
    "",
    "测试全部通过。",
  ].join("\n");
  return ctx.steerText() ? base + `\n\n> 插话：${ctx.steerText()}` : base;
}

// ---------- Provider ----------

/** For tests: counts createSession calls */
export const mockProviderMetrics = { createSessionCalls: 0 };

export function createMockProvider(): Provider {
  return {
    id: "mock",
    name: "Mock（演示）",
    capabilities: mockCapabilities,
    async detect(): Promise<DetectResult> {
      return { available: true, bin: "mock", version: "demo" };
    },
    async listModels(): Promise<ModelInfo[]> {
      return [
        { id: "demo-fast", name: "演示·快", isDefault: true, efforts: ["low", "medium", "high"] },
        { id: "demo-pro", name: "演示·强", efforts: ["low", "medium", "high"] },
      ];
    },
    async createSession(o) {
      mockProviderMetrics.createSessionCalls++;
      return new MockSession(o);
    },
  };
}
