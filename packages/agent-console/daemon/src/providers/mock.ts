// MockProvider: registered only with AGENT_CONSOLE_MOCK=1. Persistent session, interruptible, with permissions and steering.
// Scripts by message prefix: default /perm /plan /ask /slow /error /long /exit /tools /winrun /tasks; supports steer/interrupt/resume.
import { tr } from "../util/i18n.js";
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
      { id: "accept", label: tr("perm.allow"), kind: "allow_once" },
      { id: "acceptForSession", label: tr("perm.allowSession"), kind: "allow_always" },
      { id: "decline", label: tr("perm.deny"), kind: "reject_once" },
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

// Like Cursor when its model stream dies ("http/2 stream closed … CANCEL"): it asks for permission, then ends the turn
// itself without waiting for (or withdrawing) the answer. The manager must not keep the request pending afterwards.
async function scriptPermAbandon(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  emit({
    type: "permission_request",
    requestId: "perm-" + rid(),
    title: "运行 git status",
    kind: "execute",
    detail: { command: "git status" },
    options: [
      { id: "allow-once", label: tr("perm.allow"), kind: "allow_once" },
      { id: "reject-once", label: tr("perm.deny"), kind: "reject_once" },
    ],
  });
  await sleepAbortable(200, ctx);
  emit({ type: "assistant_message", itemId: "pa", text: "Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)" });
}

async function scriptPlan(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  emit({
    type: "plan",
    itemId: "plan1",
    markdown: "## 实施计划\n\n1. 改 `src/index.ts` 入口\n2. 更新测试\n3. 跑一遍 e2e",
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
      { id: "reject", label: tr("perm.deny"), kind: "reject_once" },
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

// "/bigreply" (1.3.6 scroll e2e): one very long Markdown reply with many code blocks, far taller than the
// 120px row estimate; streamed in chunks ("/bigreply slow" streams it over ~6 s)
async function scriptBigReply(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const slow = ctx.input.text.includes("slow");
  const parts: string[] = [];
  for (let i = 1; i <= 14; i++) {
    parts.push(`### 第 ${i} 部分\n\n- 要点 ${i}.a：说明一下这里的改动\n- 要点 ${i}.b：以及为什么这样改\n\n`);
    parts.push("```ts\n" + Array.from({ length: 8 }, (_, k) => `const v${i}_${k} = compute(${i}, ${k}); // line ${k}`).join("\n") + "\n```\n\n");
  }
  let acc = "";
  emit({ type: "assistant_delta", itemId: "B1", text: "" });
  for (const p of parts) {
    if (ctx.interrupted()) return;
    acc += p;
    emit({ type: "assistant_delta", itemId: "B1", text: p });
    await sleep(slow ? 220 : 5);
  }
  emit({ type: "assistant_message", itemId: "B1", text: acc });
}

// "/codestream" (1.3.7 flicker e2e): a reply whose fenced code blocks grow one line per delta, the way a real
// Agent streams code (so a block is still open while the user clicks its wrap toggle), then a second block
async function scriptCodeStream(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  let acc = "";
  const put = (p: string) => { acc += p; emit({ type: "assistant_delta", itemId: "C1", text: p }); };
  put("先看第一段代码：\n\n```ts\n");
  for (let b = 1; b <= 2; b++) {
    if (b === 2) put("```\n\n然后是第二段：\n\n```ts\n");
    for (let k = 0; k < 22; k++) {
      if (ctx.interrupted()) return;
      put(`const block${b}_line${k} = computeSomethingRatherLong(${b}, ${k}, "a fairly long string literal so wrapping matters ${"x".repeat(60)}");\n`);
      await sleep(120);
    }
  }
  put("```\n\n完毕。");
  emit({ type: "assistant_message", itemId: "C1", text: acc });
}

async function scriptExit(_ctx: Ctx): Promise<void> {
  await sleep(300);
  throw new MockCrash();
}

function pickScript(text: string): (ctx: Ctx) => Promise<void> {
  const t = text.trim();
  if (t.startsWith("/perm-abandon")) return scriptPermAbandon;
  if (t.startsWith("/perm")) return scriptPerm;
  if (t.startsWith("/plan")) return scriptPlan;
  if (t.startsWith("/ask")) return scriptAsk;
  if (t.startsWith("/slow")) return scriptSlow;
  if (t.startsWith("/error")) return scriptError;
  if (t.startsWith("/long")) return scriptLong;
  if (t.startsWith("/exit")) return scriptExit;
  if (t.startsWith("/bigreply")) return scriptBigReply;
  if (t.startsWith("/codestream")) return scriptCodeStream;
  if (t.startsWith("/serve")) return scriptServe;
  if (t.startsWith("/tools")) return scriptTools;
  if (t.startsWith("/bashhint")) return scriptBashHint;
  if (t.startsWith("/winrun")) return scriptWinRun;
  if (t.startsWith("/tasks")) return scriptTasks;
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

// "/tools" (1.3): thinking between eight tool calls (more than the six shown flat), one failure and a slow last command,
// for the folded tool summary
async function scriptTools(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const sleepA = (ms: number) => sleepAbortable(ms, ctx);
  const tool = async (id: string, kind: string, title: string, input: Record<string, unknown>, end: Record<string, unknown>, ms = 150) => {
    emit({ type: "tool_call", itemId: id, kind, title, status: "running", input } as Parameters<Ctx["emit"]>[0]);
    if (await sleepA(ms)) return true;
    emit({ type: "tool_call", itemId: id, kind, title, status: "ok", durationMs: ms, ...end } as Parameters<Ctx["emit"]>[0]);
    return false;
  };
  emit({ type: "reasoning", itemId: "tr1", text: "先看一下测试和配置。" });
  if (await tool("x1", "read", "读取 package.json", { file_path: "package.json" }, { output: "{…}" })) return;
  if (await tool("x2", "search", '搜索 "describe("', { pattern: "describe(" }, { output: "12 处匹配" })) return;
  emit({ type: "reasoning", itemId: "tr2", text: "" });
  if (await tool("x3", "read", "读取 test/app.test.ts", { file_path: "test/app.test.ts" }, { output: "…" })) return;
  if (await tool("x3b", "read", "读取 test/server.test.ts", { file_path: "test/server.test.ts" }, { output: "…" })) return;
  if (await tool("x3c", "search", '搜索 "createServer"', { pattern: "createServer" }, { output: "3 处匹配" })) return;
  emit({ type: "tool_call", itemId: "x4", kind: "bash", title: "运行 npm run lint", status: "running", input: { command: "npm run lint" } });
  if (await sleepA(200)) return;
  emit({
    type: "tool_call", itemId: "x4", kind: "bash", title: "运行 npm run lint", status: "failed", exitCode: 1, durationMs: 200,
    output: "src/app.ts:12:7  error  'unused' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)",
  });
  const oldStr = "const unused = 1;\nexport const app = 2;";
  const newStr = "export const app = 2;";
  if (await tool("x5", "edit", "编辑 src/app.ts", { file_path: "src/app.ts", old_string: oldStr, new_string: newStr },
    { detail: editDetail({ path: "src/app.ts", old: oldStr, new: newStr }) })) return;
  emit({ type: "reasoning", itemId: "tr3", text: "lint 修好了，再跑一遍完整测试。" });
  const cmd = "npm test -- --reporter=verbose --coverage --run test/app.test.ts test/server.test.ts test/client.test.ts";
  emit({ type: "tool_call", itemId: "x6", kind: "bash", title: `运行 ${cmd}`, status: "running", input: { command: cmd } });
  // Slow on purpose: the one-line "正在运行：…" row stays up for screenshots (QA: AGENT_CONSOLE_MOCK_TOOLS_MS)
  const slow = Number(process.env.AGENT_CONSOLE_MOCK_TOOLS_MS) || 2500;
  if (await sleepA(slow)) return;
  emit({ type: "tool_call", itemId: "x6", kind: "bash", title: `运行 ${cmd}`, status: "ok", output: "✓ 3 个测试文件通过", exitCode: 0, durationMs: slow });
  const reply = ctx.replyPrefix() + "lint 报错已修复，测试全部通过。";
  emit({ type: "assistant_message", itemId: "tm1", text: reply });
}

// "/winrun" (1.3): Nolan's Windows Cursor turn: short thinking between tool runs, long PowerShell commands (CJK paths),
// an approval for one of them, then more groups while the turn is live. The e2e overlap check drives it at ~600 px.
async function scriptWinRun(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const sleepA = (ms: number) => sleepAbortable(ms, ctx);
  const step = Number(process.env.AGENT_CONSOLE_MOCK_STEP_MS) || 250;
  const think = async (id: string, text: string) => {
    for (const ch of chunkText(text, 6)) {
      emit({ type: "reasoning_delta", itemId: id, text: ch });
      if (await sleepA(40)) return true;
    }
    emit({ type: "reasoning", itemId: id, text });
    return false;
  };
  const tool = async (id: string, kind: string, title: string, input: Record<string, unknown>, ms = step) => {
    emit({ type: "tool_call", itemId: id, kind, title, status: "running", input } as Parameters<Ctx["emit"]>[0]);
    if (await sleepA(ms)) return true;
    emit({ type: "tool_call", itemId: id, kind, title, status: "ok", durationMs: ms, output: "ok" } as Parameters<Ctx["emit"]>[0]);
    return false;
  };
  const dir = "D:\\workwork\\抖音快手自动上传";
  const start = `Set-Location "${dir}"; if (Test-Path ".venv\\Scripts\\pythonw.exe") { Start-Process -FilePath ".venv\\Scripts\\pythonw.exe" -ArgumentList "-m","app.main" -WorkingDirectory "${dir}"; Write-Host "已启动（源码模式）" } else { Write-Host "venv 不存在，尝试 exe"; Start-Process -FilePath "风景视频工具.exe" -WorkingDirectory "${dir}"; Write-Host "已启动（exe）" }`;
  const ps = `Get-Process pythonw -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*抖音快手自动上传*" } | Select-Object Id, Path, StartTime | Format-Table -AutoSize`;
  if (await think("w1", "先检查是否已有实例在跑。")) return;
  emit({ type: "assistant_message", itemId: "wm1", text: "先检查是否已有实例在跑，再启动应用。" });
  if (await tool("s1", "search", "搜索 pythonw", { pattern: "pythonw" })) return;
  if (await tool("s2", "search", "搜索 app.main", { pattern: "app.main" })) return;
  if (await think("w2", "看下启动脚本。")) return;
  if (await tool("s3", "search", "搜索 启动.bat", { pattern: "启动.bat" })) return;
  if (await tool("r1", "read", "读取 启动.bat", { file_path: `${dir}\\启动.bat` })) return;
  if (await think("w3", "")) return;
  if (await tool("b0", "bash", `运行 ${ps}`, { command: ps }, step * 2)) return;
  if (await think("w4", "没有实例在跑，直接启动。")) return;
  emit({ type: "tool_call", itemId: "b1", kind: "bash", title: `运行 ${start}`, status: "running", input: { command: start } });
  if (await sleepA(step)) return;
  const requestId = "perm-" + rid();
  emit({
    type: "permission_request", requestId, title: start, kind: "tool",
    detail: { command: start, cwd: dir },
    options: [
      { id: "allow-once", label: "Allow once", kind: "allow_once" },
      { id: "allow-always", label: "Allow always", kind: "allow_always" },
      { id: "reject-once", label: "Reject", kind: "reject_once" },
    ],
  });
  const ans = await ctx.waitFor(requestId);
  if (ans.cancelled || ans.optionId === "reject-once") {
    emit({ type: "tool_call", itemId: "b1", kind: "bash", title: `运行 ${start}`, status: "failed", output: "Rejected", exitCode: 1 });
    return;
  }
  emit({ type: "tool_call", itemId: "b1", kind: "bash", title: `运行 ${start}`, status: "ok", output: "已启动（源码模式）", exitCode: 0, durationMs: step });
  if (await think("w5", "改三个配置。")) return;
  for (const n of [1, 2, 3]) if (await tool(`e${n}`, "edit", `编辑 config/${n}.json`, { file_path: `${dir}\\config\\${n}.json` })) return;
  if (await think("w6", "确认进程起来了。")) return;
  if (await tool("r2", "read", "读取 logs/selftest.txt", { file_path: `${dir}\\logs\\selftest.txt` })) return;
  if (await tool("b2", "bash", `运行 ${ps}`, { command: ps }, Number(process.env.AGENT_CONSOLE_MOCK_TOOLS_MS) || step * 6)) return;
  emit({ type: "assistant_message", itemId: "wm2", text: ctx.replyPrefix() + "已启动，进程在跑。" });
}

// "/tasks" (1.3 timeline polish): an ACP-style step list (plan entries) that the Agent ticks off between tool calls,
// a code block in the reply. AGENT_CONSOLE_MOCK_TASKS_HOLD_MS keeps the turn open on the last step (screenshots).
async function scriptTasks(ctx: Ctx): Promise<void> {
  const { emit } = ctx;
  const sleepA = (ms: number) => sleepAbortable(ms, ctx);
  const steps = ["复现偶发失败", "找到竞态", "修复并加固测试"];
  const plan = (done: number, running: boolean) => emit({
    type: "plan", itemId: "tk-plan", markdown: steps.map((s) => `- ${s}`).join("\n"),
    entries: steps.map((step, i) => ({ step, status: i < done ? "completed" : i === done && running ? "in_progress" : "pending" })),
  });
  const tool = async (id: string, kind: string, title: string, input: Record<string, unknown>, end: Record<string, unknown> = {}, ms = 120) => {
    emit({ type: "tool_call", itemId: id, kind, title, status: "running", input } as Parameters<Ctx["emit"]>[0]);
    if (await sleepA(ms)) return true;
    emit({ type: "tool_call", itemId: id, kind, title, status: "ok", durationMs: ms, output: "ok", ...end } as Parameters<Ctx["emit"]>[0]);
    return false;
  };
  plan(0, true);
  if (await tool("k1", "bash", "运行 npx vitest run src/checkout --repeat 50", { command: "npx vitest run src/checkout --repeat 50" })) return;
  if (await tool("k2", "read", "读取 src/checkout/useCheckout.ts", { file_path: "src/checkout/useCheckout.ts" })) return;
  plan(1, true);
  emit({ type: "reasoning", itemId: "k-th", text: "submit() 没有等 confirmOrder。" });
  const oldStr = "  setStatus(\"pending\");\n  void confirmOrder(order.id).then(setStatus);";
  const newStr = "  setStatus(\"pending\");\n  try {\n    setStatus(await confirmOrder(order.id));\n  } catch (error) {\n    setStatus(\"failed\");\n    throw error;\n  }";
  if (await tool("k3", "edit", "编辑 src/checkout/useCheckout.ts", { file_path: "src/checkout/useCheckout.ts", old_string: oldStr, new_string: newStr },
    { detail: editDetail({ path: "src/checkout/useCheckout.ts", old: oldStr, new: newStr }) })) return;
  plan(2, true);
  if (await tool("k4", "search", '搜索 "confirmOrder"', { pattern: "confirmOrder" })) return;
  const hold = Number(process.env.AGENT_CONSOLE_MOCK_TASKS_HOLD_MS) || 0;
  if (await tool("k5", "bash", "运行 npx tsc --noEmit", { command: "npx tsc --noEmit" }, {}, Math.max(120, hold))) return;
  plan(3, false);
  const reply = ctx.replyPrefix() + [
    "**根因：** `submit()` 丢掉了确认请求的 Promise，订单确认前就返回了。",
    "",
    "```ts",
    "async function submit() {",
    "  setStatus(\"pending\");",
    "  const order = await createOrder(cart);",
    "  setStatus(await confirmOrder(order.id));",
    "}",
    "```",
    "",
    "重复跑 50 次都通过了。",
  ].join("\n");
  emit({ type: "assistant_message", itemId: "k-msg", text: reply });
}

// "/bashhint" (1.3): the Windows "no Git Bash" hint, for screenshots and e2e on any OS
async function scriptBashHint(ctx: Ctx): Promise<void> {
  ctx.emit({ type: "notice", level: "warn", code: "bash_missing", message: tr("notice.bashMissing") });
  await sleepAbortable(100, ctx);
  ctx.emit({ type: "assistant_message", itemId: "bh1", text: ctx.replyPrefix() + "（模拟）" });
}

// "/serve": a reply with local dev-server addresses (1.2 preview links) and one external link
async function scriptServe(ctx: Ctx): Promise<void> {
  const emit = (e: Parameters<Ctx["emit"]>[0]) => ctx.emit(e);
  const reply = [
    "开发服务器已经启动：http://localhost:5173/ ，接口在 127.0.0.1:5173/api.json。",
    "",
    "- 在预览里打开 [首页](http://localhost:5173/) 或 [about](http://localhost:5173/about.html)",
    "- 文档：[Vite](https://vite.dev/guide/)",
    "",
    "```",
    "  VITE v5.4.21  ready in 139 ms",
    "  ➜  Local:   http://localhost:5173/",
    "```",
  ].join("\n");
  for (const ch of chunkText(reply, 40)) {
    if (await sleepAbortable(20, ctx)) return;
    emit({ type: "assistant_delta", itemId: "sv", text: ch });
  }
  emit({ type: "assistant_message", itemId: "sv", text: reply });
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
      // AGENT_CONSOLE_MOCK_DETECT_MS: a slow "--version" probe (a cold CLI on Windows takes seconds)
      const d = Number(process.env.AGENT_CONSOLE_MOCK_DETECT_MS) || 0;
      if (d > 0) await sleep(d);
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
      // AGENT_CONSOLE_MOCK_START_MS: a slow agent start (spawn + ACP initialize/session/new on Windows takes seconds)
      const d = Number(process.env.AGENT_CONSOLE_MOCK_START_MS) || 0;
      if (d > 0) await sleep(d);
      return new MockSession(o);
    },
  };
}
