import { createRequire } from 'module'; const require = createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// daemon/src/log.ts
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join as join3 } from "node:path";
function fileName(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `daemon-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`;
}
function initLog(dataDir) {
  logDir = join3(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  try {
    const keep = /* @__PURE__ */ new Set();
    const now = /* @__PURE__ */ new Date();
    for (let i = 0; i < 7; i++) {
      keep.add(fileName(new Date(now.getTime() - i * 864e5)));
    }
    for (const f of readdirSync(logDir)) {
      if (/^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(f) && !keep.has(f)) {
        rmSync(join3(logDir, f), { force: true });
      }
    }
  } catch {
  }
}
function log(level, msg, extra) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] ${msg}${extra !== void 0 ? " " + safeJson(extra) : ""}`;
  try {
    const d = /* @__PURE__ */ new Date();
    const name = fileName(d);
    if (name !== today && logDir) {
      today = name;
      logFile = join3(logDir, name);
    }
    if (logFile) appendFileSync(logFile, line + "\n", "utf8");
  } catch {
  }
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[agent-console] ${msg}`, extra !== void 0 ? extra : "");
}
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
var logDir, today, logFile;
var init_log = __esm({
  "daemon/src/log.ts"() {
    logDir = "";
    today = "";
    logFile = "";
  }
});

// daemon/src/util/paths.ts
import { realpathSync, existsSync as existsSync3 } from "node:fs";
import { posix, sep, win32 } from "node:path";
function normPath(p, platform = process.platform) {
  let r = (platform === "win32" ? win32 : posix).resolve(p);
  try {
    r = realpathSync.native(r);
  } catch {
    try {
      r = realpathSync(r);
    } catch {
    }
  }
  if (platform === "win32") {
    r = r.replace(/\//g, "\\").replace(/^\\\\\?\\(?!UNC\\)/i, "").replace(/^\\\\\?\\UNC\\/i, "\\\\").toLowerCase();
  } else {
    r = r.replace(/\\/g, "/");
    if (platform === "darwin") r = r.normalize("NFC").toLowerCase();
  }
  while (r.length > 3 && (r.endsWith("/") || r.endsWith("\\"))) r = r.slice(0, -1);
  return r;
}
function samePath(a, b) {
  return normPath(a) === normPath(b);
}
function validId(id) {
  return typeof id === "string" && ID_RE.test(id);
}
var ID_RE;
var init_paths = __esm({
  "daemon/src/util/paths.ts"() {
    ID_RE = /^[\w-]{1,80}$/;
  }
});

// daemon/src/util/queue.ts
var AsyncQueue;
var init_queue = __esm({
  "daemon/src/util/queue.ts"() {
    AsyncQueue = class {
      buf = [];
      waiters = [];
      closed = false;
      err = null;
      push(item) {
        if (this.closed) return;
        const w = this.waiters.shift();
        if (w) w({ value: item, done: false });
        else this.buf.push(item);
      }
      close() {
        if (this.closed) return;
        this.closed = true;
        while (this.waiters.length) {
          const w = this.waiters.shift();
          w({ value: void 0, done: true });
        }
      }
      fail(err) {
        if (this.closed) return;
        this.err = err;
        this.closed = true;
        while (this.waiters.length) {
          const w = this.waiters.shift();
          w({ value: void 0, done: true });
        }
      }
      get isClosed() {
        return this.closed;
      }
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (this.buf.length) return Promise.resolve({ value: this.buf.shift(), done: false });
            if (this.closed) {
              if (this.err) return Promise.reject(this.err);
              return Promise.resolve({ value: void 0, done: true });
            }
            if (this.err) return Promise.reject(this.err);
            return new Promise((res, rej) => {
              this.waiters.push((r) => {
                if (this.err) {
                  rej(this.err);
                  return;
                }
                res(r);
              });
            });
          }
        };
      }
    };
  }
});

// daemon/src/agents/diff.ts
function diffLines(oldStr = "", newStr = "", { context = CONTEXT } = {}) {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return coarseDiff(a, b);
  const ops = lcsOps(a, b);
  return buildHunks(ops, context);
}
function splitLines(s) {
  s = String(s);
  if (!s) return [];
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i2 = n - 1; i2 >= 0; i2--)
    for (let j2 = m - 1; j2 >= 0; j2--)
      dp[i2 * (m + 1) + j2] = a[i2] === b[j2] ? dp[(i2 + 1) * (m + 1) + j2 + 1] + 1 : Math.max(dp[(i2 + 1) * (m + 1) + j2], dp[i2 * (m + 1) + j2 + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", s: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      ops.push({ t: "-", s: a[i] });
      i++;
    } else {
      ops.push({ t: "+", s: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", s: a[i++] });
  while (j < m) ops.push({ t: "+", s: b[j++] });
  return ops;
}
function buildHunks(ops, context) {
  const changed = [];
  ops.forEach((op, i) => {
    if (op.t !== " ") changed.push(i);
  });
  if (!changed.length) return { hunks: [], added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === "+") added++;
    else if (op.t === "-") removed++;
  }
  const ranges = [];
  for (const idx of changed) {
    const s = Math.max(0, idx - context);
    const e = Math.min(ops.length, idx + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && s <= last.e + MERGE_GAP) last.e = Math.max(last.e, e);
    else ranges.push({ s, e });
  }
  const hunks = [];
  let oldLn = 1;
  let newLn = 1;
  const oldNos = [];
  const newNos = [];
  for (const op of ops) {
    oldNos.push(oldLn);
    newNos.push(newLn);
    if (op.t !== "+") oldLn++;
    if (op.t !== "-") newLn++;
  }
  for (const r of ranges) {
    hunks.push({
      oldStart: oldNos[r.s],
      newStart: newNos[r.s],
      lines: ops.slice(r.s, r.e).map((op) => ({ t: op.t, s: op.s }))
    });
  }
  return { hunks, added, removed };
}
function coarseDiff(a, b) {
  return {
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [...a.map((s) => ({ t: "-", s })), ...b.map((s) => ({ t: "+", s }))].slice(0, 2e3)
      }
    ],
    added: b.length,
    removed: a.length,
    truncated: true
  };
}
function editDetail(detail = {}) {
  if (Array.isArray(detail.edits) && detail.edits.length) {
    const hunks = [];
    let added = 0;
    let removed = 0;
    for (const e of detail.edits) {
      const d = diffLines(e.old_string ?? e.old ?? "", e.new_string ?? e.new ?? "");
      for (const h of d.hunks) hunks.push(h);
      added += d.added;
      removed += d.removed;
    }
    return { path: detail.path, hunks, added, removed };
  }
  if (detail.old !== void 0 || detail.new !== void 0) {
    const d = diffLines(String(detail.old ?? ""), String(detail.new ?? ""));
    return { path: detail.path, hunks: d.hunks, added: d.added, removed: d.removed };
  }
  return detail;
}
var CONTEXT, MERGE_GAP, MAX_LINES;
var init_diff = __esm({
  "daemon/src/agents/diff.ts"() {
    CONTEXT = 3;
    MERGE_GAP = 6;
    MAX_LINES = 400;
  }
});

// daemon/src/providers/slash.ts
function classifyClaudeSlashCommand(name) {
  return CLAUDE_BUILTIN_COMMANDS.has(name) ? "command" : "skill";
}
function parseSlashInput(text) {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const body = t.slice(1).trim();
  if (!body) return null;
  const sp = body.indexOf(" ");
  if (sp === -1) return { name: body, args: "", raw: t };
  return { name: body.slice(0, sp), args: body.slice(sp + 1).trim(), raw: t };
}
function mapAcpAvailableCommands(cmds) {
  return cmds.map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.input?.hint,
    kind: "skill"
  }));
}
function sortSlashCommands(list) {
  return [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "command" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
var CLAUDE_BUILTIN_COMMANDS;
var init_slash = __esm({
  "daemon/src/providers/slash.ts"() {
    CLAUDE_BUILTIN_COMMANDS = /* @__PURE__ */ new Set(["clear", "compact", "context", "usage", "init", "debug"]);
  }
});

// daemon/src/providers/mock.ts
async function scriptDefault(ctx) {
  const { emit } = ctx;
  const sleepA = (ms) => sleepAbortable(ms, ctx);
  emit({ type: "reasoning_delta", itemId: "r1", text: "\u8BA9\u6211\u770B\u770B\u9879\u76EE\u7ED3\u6784\u2026" });
  await sleepA(500);
  emit({ type: "reasoning", itemId: "r1", text: "\u8BA9\u6211\u770B\u770B\u9879\u76EE\u7ED3\u6784\u2026\u9700\u8981\u5148\u8BFB\u51E0\u4E2A\u6587\u4EF6\u3002" });
  const tools = [
    { id: "t1", name: "Read", input: { file_path: ctx.input.text.includes("abs") ? "D:/x/a.ts" : "src/index.ts" } },
    { id: "t2", name: "Read", input: { file_path: "package.json" } }
  ];
  for (const t of tools) {
    emit({ type: "tool_call", itemId: t.id, kind: "read", title: `\u8BFB\u53D6 ${t.input.file_path}`, status: "running", input: t.input });
    if (await sleepA(300)) return;
    emit({ type: "tool_call", itemId: t.id, kind: "read", title: `\u8BFB\u53D6 ${t.input.file_path}`, status: "ok", output: "\u2026\u6587\u4EF6\u5185\u5BB9\u2026", durationMs: 300 });
  }
  emit({ type: "tool_call", itemId: "t3", kind: "search", title: '\u641C\u7D22 "TODO"', status: "running", input: { pattern: "TODO" } });
  await sleepA(200);
  emit({ type: "tool_call", itemId: "t3", kind: "search", title: '\u641C\u7D22 "TODO"', status: "ok", output: "3 \u5904\u5339\u914D" });
  const oldStr = "const x = 1;\nconst y = 2;\nreturn x + y;";
  const newStr = "const x = 1;\nconst y = 2;\nconst z = 3;\nreturn x + y + z;";
  emit({
    type: "tool_call",
    itemId: "t4",
    kind: "edit",
    title: "\u7F16\u8F91 src/index.ts",
    status: "running",
    input: { file_path: "src/index.ts", old_string: oldStr, new_string: newStr },
    detail: editDetail({ path: "src/index.ts", old: oldStr, new: newStr })
  });
  if (await sleepA(400)) return;
  emit({
    type: "tool_call",
    itemId: "t4",
    kind: "edit",
    title: "\u7F16\u8F91 src/index.ts",
    status: "ok",
    detail: editDetail({ path: "src/index.ts", old: oldStr, new: newStr }),
    durationMs: 400
  });
  emit({ type: "tool_call", itemId: "t5", kind: "bash", title: "\u8FD0\u884C npm test", status: "running", input: { command: "npm test" } });
  for (let i = 1; i <= 20; i++) {
    if (await sleepA(60)) return;
    emit({ type: "tool_output_delta", itemId: "t5", text: `\u7B2C ${i} \u884C\u8F93\u51FA
` });
  }
  emit({ type: "tool_call", itemId: "t5", kind: "bash", title: "\u8FD0\u884C npm test", status: "ok", output: "\u2713 \u5168\u90E8\u901A\u8FC7", exitCode: 0, durationMs: 1200 });
  emit({
    type: "todo",
    items: [
      { text: "\u5206\u6790\u9700\u6C42", status: "done" },
      { text: "\u4FEE\u6539\u4EE3\u7801", status: "done" },
      { text: "\u8DD1\u6D4B\u8BD5", status: "done" },
      { text: "\u5199\u6587\u6863", status: "in_progress" }
    ]
  });
  await sleepA(300);
  const reply = ctx.replyPrefix() + mockReply(ctx);
  for (const ch of chunkText(reply, 40)) {
    if (await sleepA(30)) return;
    emit({ type: "assistant_delta", itemId: "m1", text: ch });
  }
  emit({ type: "assistant_message", itemId: "m1", text: reply });
}
async function scriptPerm(ctx) {
  const { emit } = ctx;
  const requestId = "perm-" + rid();
  emit({
    type: "permission_request",
    requestId,
    title: "\u8FD0\u884C npm test",
    kind: "tool",
    detail: { command: "npm test", cwd: ".", toolName: "Bash" },
    options: [
      { id: "accept", label: "\u5141\u8BB8", kind: "allow_once" },
      { id: "acceptForSession", label: "\u672C\u5BF9\u8BDD\u90FD\u5141\u8BB8", kind: "allow_always" },
      { id: "decline", label: "\u62D2\u7EDD", kind: "reject_once" }
    ]
  });
  const ans = await ctx.waitFor(requestId);
  if (ans.cancelled || ans.optionId === "decline") {
    emit({ type: "tool_call", itemId: "p1", kind: "bash", title: "\u8FD0\u884C npm test", status: "failed", output: "\u5DF2\u88AB\u7528\u6237\u62D2\u7EDD", exitCode: 1 });
    emit({ type: "assistant_message", itemId: "pm", text: "\u5DF2\u6309\u4F60\u7684\u8981\u6C42\u8DF3\u8FC7\u8BE5\u64CD\u4F5C\u3002" });
    return;
  }
  emit({ type: "tool_call", itemId: "p1", kind: "bash", title: "\u8FD0\u884C npm test", status: "running", input: { command: "npm test" } });
  if (await sleepAbortable(500, ctx)) return;
  emit({ type: "tool_call", itemId: "p1", kind: "bash", title: "\u8FD0\u884C npm test", status: "ok", output: "\u2713 12 \u4E2A\u6D4B\u8BD5\u901A\u8FC7", exitCode: 0, durationMs: 500 });
  emit({ type: "assistant_message", itemId: "pm", text: "\u6D4B\u8BD5\u901A\u8FC7\u4E86\u3002" });
}
async function scriptPlan(ctx) {
  const { emit } = ctx;
  emit({
    type: "plan",
    itemId: "plan1",
    markdown: "## \u5B9E\u65BD\u8BA1\u5212\n\n1. \u6539 `src/index.ts` \u5165\u53E3\n2. \u66F4\u65B0\u6D4B\u8BD5\n3. \u8DD1\u4E00\u904D e2e",
    entries: [
      { step: "\u6539 src/index.ts \u5165\u53E3", status: "pending" },
      { step: "\u66F4\u65B0\u6D4B\u8BD5", status: "pending" },
      { step: "\u8DD1\u4E00\u904D e2e", status: "pending" }
    ]
  });
  const requestId = "perm-" + rid();
  emit({
    type: "permission_request",
    requestId,
    title: "\u5B9E\u65BD\u8FD9\u4E2A\u8BA1\u5212\uFF1F",
    kind: "plan",
    detail: { markdown: "\u89C1\u4E0A\u65B9\u8BA1\u5212" },
    options: [
      { id: "implement", label: "\u5F00\u59CB\u5B9E\u65BD", kind: "allow_once" },
      { id: "reject", label: "\u62D2\u7EDD", kind: "reject_once" }
    ]
  });
  const ans = await ctx.waitFor(requestId);
  if (ans.cancelled || ans.optionId === "reject") {
    emit({ type: "assistant_message", itemId: "pm", text: "\u597D\u7684\uFF0C\u8BF7\u544A\u8BC9\u6211\u600E\u4E48\u6539\u3002" });
    return;
  }
  emit({ type: "tool_call", itemId: "pl1", kind: "edit", title: "\u7F16\u8F91 src/index.ts", status: "ok" });
  await sleepAbortable(400, ctx);
  emit({ type: "assistant_message", itemId: "pm", text: "\u5DF2\u6309\u8BA1\u5212\u6539\u5B8C\u5165\u53E3\u548C\u6D4B\u8BD5\u3002" });
}
async function scriptAsk(ctx) {
  const { emit } = ctx;
  const requestId = "q-" + rid();
  emit({
    type: "question",
    requestId,
    questions: [
      {
        id: "q1",
        header: "\u90E8\u7F72\u76EE\u6807",
        question: "\u8981\u90E8\u7F72\u5230\u54EA\u4E2A\u73AF\u5883\uFF1F",
        options: [
          { id: "staging", label: "Staging" },
          { id: "prod", label: "\u751F\u4EA7\u73AF\u5883" }
        ]
      },
      {
        id: "q2",
        header: "\u5907\u6CE8",
        question: "\u8FD8\u6709\u4EC0\u4E48\u8981\u8865\u5145\u7684\uFF1F",
        freeText: true
      }
    ]
  });
  const ans = await ctx.waitFor(requestId);
  const env = ans.answers?.q1 ?? "\uFF08\u672A\u9009\uFF09";
  const note = ans.answers?.q2 ?? "";
  emit({ type: "assistant_message", itemId: "am", text: `\u6536\u5230\uFF1A\u90E8\u7F72\u5230 ${env}${note ? `\uFF0C\u5907\u6CE8\u300C${note}\u300D` : ""}\u3002` });
}
async function scriptSlow(ctx) {
  const { emit } = ctx;
  for (let i = 1; i <= 6; i++) {
    const id = "s" + i;
    emit({ type: "tool_call", itemId: id, kind: "bash", title: `\u6B65\u9AA4 ${i}/6`, status: "running", input: { command: `step ${i}` } });
    if (await sleepAbortable(2e3, ctx)) return;
    emit({ type: "tool_call", itemId: id, kind: "bash", title: `\u6B65\u9AA4 ${i}/6`, status: "ok", output: `\u6B65\u9AA4 ${i} \u5B8C\u6210`, durationMs: 2e3 });
  }
  emit({ type: "assistant_message", itemId: "sm", text: "6 \u4E2A\u6B65\u9AA4\u5168\u90E8\u8DD1\u5B8C\u3002" });
}
async function scriptError(ctx) {
  const { emit } = ctx;
  emit({ type: "tool_call", itemId: "e1", kind: "bash", title: "\u8FD0\u884C ./build.sh", status: "running", input: { command: "./build.sh" } });
  await sleepAbortable(800, ctx);
  throw new Error("\u6784\u5EFA\u5931\u8D25\uFF1A\u627E\u4E0D\u5230\u6A21\u5757 foo\uFF08\u6A21\u62DF\u9519\u8BEF\uFF09");
}
async function scriptLong(ctx) {
  const { emit } = ctx;
  emit({ type: "assistant_delta", itemId: "L1", text: "" });
  for (let i = 0; i < 5e3; i++) {
    if (i % 100 === 0 && ctx.interrupted()) return;
    emit({ type: "assistant_delta", itemId: "L1", text: `\u5757${i} ` });
    if (i % 200 === 0) await sleep(0);
  }
  emit({ type: "assistant_message", itemId: "L1", text: "\uFF085000 \u4E2A\u589E\u91CF\u5408\u5E76\u540E\u7684\u957F\u6587\uFF09" });
}
async function scriptExit(_ctx) {
  await sleep(300);
  throw new MockCrash();
}
function pickScript(text) {
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
async function sleepAbortable(ms, ctx) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ctx.interrupted()) return true;
    await sleep(Math.min(20, Math.max(1, ms - (Date.now() - start))));
  }
  return ctx.interrupted();
}
function chunkText(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
function mockReply(ctx) {
  const base = [
    "\u597D\u7684\uFF0C\u6211\u5DF2\u7ECF\u6309\u4F60\u7684\u8981\u6C42\u6539\u597D\u4E86\u3002",
    "",
    "## \u6539\u52A8",
    "- `src/index.ts`\uFF1A\u628A\u8FD4\u56DE\u903B\u8F91\u8865\u6210\u4E09\u53D8\u91CF\u6C42\u548C",
    "- \u65B0\u589E\u4E00\u884C\u5E38\u91CF `z`",
    "",
    "```ts",
    "const z = 3;",
    "return x + y + z;",
    "```",
    "",
    "| \u6587\u4EF6 | \u53D8\u66F4 |",
    "|---|---|",
    "| src/index.ts | +2/-1 |",
    "",
    "\u6D4B\u8BD5\u5168\u90E8\u901A\u8FC7\u3002"
  ].join("\n");
  return ctx.steerText() ? base + `

> \u63D2\u8BDD\uFF1A${ctx.steerText()}` : base;
}
function createMockProvider() {
  return {
    id: "mock",
    name: "Mock\uFF08\u6F14\u793A\uFF09",
    capabilities: mockCapabilities,
    async detect() {
      return { available: true, bin: "mock", version: "demo" };
    },
    async listModels() {
      return [
        { id: "demo-fast", name: "\u6F14\u793A\xB7\u5FEB", isDefault: true, efforts: ["low", "medium", "high"] },
        { id: "demo-pro", name: "\u6F14\u793A\xB7\u5F3A", efforts: ["low", "medium", "high"] }
      ];
    },
    async createSession(o) {
      mockProviderMetrics.createSessionCalls++;
      return new MockSession(o);
    }
  };
}
var mockCapabilities, rid, sleep, MockCrash, MockSession, mockProviderMetrics;
var init_mock = __esm({
  "daemon/src/providers/mock.ts"() {
    init_queue();
    init_diff();
    init_slash();
    mockCapabilities = {
      resume: true,
      interrupt: true,
      steer: true,
      images: true,
      plan: true,
      questions: true,
      cost: true,
      effort: ["low", "medium", "high"],
      modes: ["plan", "default", "acceptEdits", "bypassPermissions"]
    };
    rid = () => Math.random().toString(36).slice(2, 10);
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    MockCrash = class extends Error {
      constructor() {
        super("__mock_crash__");
      }
    };
    MockSession = class {
      constructor(o) {
        this.o = o;
        this.sessionId = o.resumeId ?? "mock-" + rid();
        this.resumed = o.resumeId !== null;
        this.events = this.q;
        this.q.push({ type: "provider_session_id", id: this.sessionId });
      }
      o;
      events;
      q = new AsyncQueue();
      sessionId;
      turnId = null;
      turnNum = 0;
      interruptFlag = false;
      closed = false;
      pendingReq = /* @__PURE__ */ new Map();
      steered = [];
      resumed = false;
      emit(ev) {
        ev.turnId ??= this.turnId ?? void 0;
        this.q.push(ev);
      }
      async send(input) {
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
          effort: this.o.effort
        });
        void this.runTurn(input);
      }
      async runTurn(input) {
        const p = "i" + rid() + "_";
        const ctx = {
          emit: (ev) => {
            const e = ev;
            if (e.itemId) e.itemId = p + e.itemId;
            this.emit(ev);
          },
          waitFor: (id) => this.waitFor(id),
          interrupted: () => this.interruptFlag || this.closed,
          steerText: () => this.steered.join("\uFF1B"),
          replyPrefix: () => this.resumePrefix(),
          input
        };
        try {
          const script = pickScript(input.text);
          await script(ctx);
          if (this.interruptFlag || this.closed) {
            this.emit({ type: "turn_ended", turnId: this.turnId, status: "interrupted", durationMs: 0 });
          } else {
            this.emit({ type: "usage", inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800, costUsd: 0.0123 });
            this.emit({ type: "turn_ended", turnId: this.turnId, status: "completed", durationMs: 6e3, filesChanged: 1 });
          }
        } catch (e) {
          if (e instanceof MockCrash) {
            this.q.close();
            return;
          }
          if (this.interruptFlag || this.closed) {
            this.emit({ type: "turn_ended", turnId: this.turnId, status: "interrupted", durationMs: 0 });
          } else {
            this.emit({ type: "turn_ended", turnId: this.turnId, status: "failed", error: String(e?.message ?? e) });
          }
        }
      }
      respond(requestId, answer) {
        const resolve2 = this.pendingReq.get(requestId);
        if (resolve2) {
          this.pendingReq.delete(requestId);
          resolve2(answer);
        }
      }
      waitFor(requestId) {
        return new Promise((resolve2) => {
          this.pendingReq.set(requestId, resolve2);
        });
      }
      async interrupt() {
        this.interruptFlag = true;
        for (const [id, resolve2] of this.pendingReq) {
          resolve2({ cancelled: true });
          this.pendingReq.delete(id);
        }
        await sleep(120);
      }
      async steer(input) {
        this.steered.push(input.text);
      }
      async setModel(model) {
        this.o.model = model;
      }
      async setMode(mode) {
        this.o.mode = mode;
      }
      async setEffort(effort) {
        this.o.effort = effort;
      }
      async listCommands() {
        return sortSlashCommands([
          { name: "perm", description: "\u6F14\u793A\u6388\u6743\u5F39\u7A97", kind: "command" },
          { name: "plan", description: "\u6F14\u793A\u8BA1\u5212\u5BA1\u6279", kind: "command" },
          { name: "ask", description: "\u6F14\u793A\u63D0\u95EE", kind: "command" },
          { name: "slow", description: "\u6162\u901F\u591A\u6B65\u5DE5\u5177", kind: "skill" },
          { name: "error", description: "\u6A21\u62DF\u5931\u8D25", kind: "skill" }
        ]);
      }
      async close() {
        this.closed = true;
        for (const [, resolve2] of this.pendingReq) resolve2({ cancelled: true });
        this.pendingReq.clear();
        this.q.close();
      }
      // With resumeId the first reply gets a "（已续接）" prefix
      resumePrefix() {
        if (this.resumed && this.turnNum === 1) return "\uFF08\u5DF2\u7EED\u63A5\uFF09";
        return "";
      }
    };
    mockProviderMetrics = { createSessionCalls: 0 };
  }
});

// lib/pathscan.mjs
import { accessSync, constants, statSync as statSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path from "node:path";
function defaultExists(file, platform) {
  try {
    if (!statSync2(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function envGet(env, name) {
  if (env[name] !== void 0) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return void 0;
}
function extraBinDirs({ platform = process.platform, env = process.env, home = homedir2() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = [];
  if (platform === "win32") {
    const appData = envGet(env, "APPDATA");
    const localAppData = envGet(env, "LOCALAPPDATA");
    const programFiles = envGet(env, "ProgramFiles") || "C:\\Program Files";
    const nvmSymlink = envGet(env, "NVM_SYMLINK");
    if (home) dirs.push(p.join(home, ".local", "bin"));
    if (appData) dirs.push(p.join(appData, "npm"));
    if (nvmSymlink) dirs.push(nvmSymlink);
    dirs.push(p.join(programFiles, "nodejs"));
    if (localAppData) dirs.push(p.join(localAppData, "Programs", "nodejs"));
    if (home) {
      dirs.push(p.join(home, ".volta", "bin"));
      dirs.push(p.join(home, ".bun", "bin"));
    }
    return dirs;
  }
  if (home) {
    dirs.push(p.join(home, ".local", "bin"));
    dirs.push(p.join(home, ".npm-global", "bin"));
    dirs.push(p.join(home, ".volta", "bin"));
    dirs.push(p.join(home, ".bun", "bin"));
    dirs.push(p.join(home, ".claude", "local"));
  }
  if (platform === "darwin") dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return dirs;
}
function searchDirs({ platform = process.platform, env = process.env, home = homedir2(), extra = true } = {}) {
  const sep4 = platform === "win32" ? ";" : ":";
  const raw = String(envGet(env, "PATH") ?? "").split(sep4).map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const all = extra ? [...raw, ...extraBinDirs({ platform, env, home })] : raw;
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const d of all) {
    const key = platform === "win32" ? d.toLowerCase().replace(/[\\/]+$/, "") : d.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
function windowsExts(env) {
  const list = String(envGet(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith("."));
  if (!list.includes(".ps1")) list.push(".ps1");
  return list;
}
function findOnPath(name, { platform = process.platform, env = process.env, home = homedir2(), extra = true, exists } = {}) {
  if (!name) return [];
  const p = platform === "win32" ? path.win32 : path.posix;
  const check = exists ?? ((file) => defaultExists(file, platform));
  if (name.includes("/") || platform === "win32" && name.includes("\\")) {
    return check(name) ? [name] : [];
  }
  let names = [name];
  if (platform === "win32") {
    const exts = windowsExts(env);
    const ext = p.extname(name).toLowerCase();
    names = ext && exts.includes(ext) ? [name] : exts.map((e) => name + e);
  }
  const hits = [];
  for (const dir of searchDirs({ platform, env, home, extra })) {
    for (const n of names) {
      const file = p.join(dir, n);
      if (check(file) && !hits.includes(file)) hits.push(file);
    }
  }
  return hits;
}
function findNode(opts = {}) {
  return findOnPath("node", opts).find((file) => isNodeExecutable(file)) ?? null;
}
function isNodeExecutable(file) {
  return /^node(\.exe)?$/i.test(String(file || "").split(/[\\/]/).pop() ?? "");
}
var init_pathscan = __esm({
  "lib/pathscan.mjs"() {
  }
});

// daemon/src/util/bin.ts
import { execFileSync, spawn } from "node:child_process";
import { readFile as readFile3 } from "node:fs/promises";
import { existsSync as existsSync4 } from "node:fs";
import path2 from "node:path";
function which(name) {
  return findOnPath(name);
}
function escapeCmdCommand(cmd) {
  return cmd.replace(CMD_META, "^$1");
}
function escapeCmdArgument(arg, doubleEscape) {
  let a = String(arg);
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(CMD_META, "^$1");
  if (doubleEscape) a = a.replace(CMD_META, "^$1");
  return a;
}
function argvFor(r, args) {
  if (r.via === "cmd-shim" && r.shim) {
    const line = [escapeCmdCommand(r.shim), ...args.map((a) => escapeCmdArgument(a, true))].join(" ");
    return { cmd: r.cmd, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
  }
  return { cmd: r.cmd, args: [...r.prefixArgs, ...args] };
}
function reapOnExit() {
  for (const pid of liveTrees) {
    try {
      if (IS_WIN) execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3e3 });
      else process.kill(-pid, "SIGKILL");
    } catch {
    }
  }
  liveTrees.clear();
}
function trackTree(child) {
  if (child.pid == null) return;
  const pid = child.pid;
  liveTrees.add(pid);
  child.once("exit", () => liveTrees.delete(pid));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", reapOnExit);
  }
}
function spawnBin(r, args, opts = {}) {
  const a = argvFor(r, args);
  const { group, ...rest } = opts;
  const child = spawn(a.cmd, a.args, {
    windowsHide: true,
    ...rest,
    ...a.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {},
    ...group && !IS_WIN ? { detached: true } : {}
  });
  if (group) trackTree(child);
  return child;
}
function shimTarget(cmdText, cmdDir, deps = {}) {
  const exists = deps.exists ?? existsSync4;
  const P = deps.win ?? IS_WIN ? path2.win32 : path2;
  const cands = [];
  const re = /"([^"]+?\.(?:js|mjs|cjs|exe|cmd|bat))"/gi;
  let m;
  while (m = re.exec(cmdText)) cands.push(m[1]);
  const re2 = /(?:%~?dp0%?)?[A-Za-z]:?[\\/\w.@-]*?\.(?:js|mjs|cjs|exe)\b/gi;
  while (m = re2.exec(cmdText)) cands.push(m[0]);
  const found = [];
  for (const raw of cands) {
    let p = raw.replace(/%~?dp0%?/gi, "");
    p = p.replace(/%[A-Z_]+%/gi, "");
    p = p.trim().replace(/^[\\/]+/, "");
    if (!p || /%\w+%/.test(p) || !/\.(js|mjs|cjs|exe)$/i.test(p)) continue;
    if (!P.isAbsolute(p)) {
      if (!cmdDir) continue;
      p = P.join(cmdDir, p);
    }
    if (exists(p)) found.push(P.resolve(p));
  }
  return found.find((f) => /\.(js|mjs|cjs)$/i.test(f)) ?? found.find((f) => /\.exe$/i.test(f) && !isNodeExecutable(P.basename(f))) ?? null;
}
function findNode2() {
  if (isNodeExecutable(process.execPath)) return process.execPath;
  return findNode() ?? "node";
}
async function resolveBin(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.out;
  const out = await resolveBinUncached(name);
  cache.set(name, { out, at: Date.now() });
  return out;
}
async function resolveFirstBin(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  for (const binName of uniq) {
    const r = await resolveBin(binName);
    if (r.ok) return { ...r, binName };
  }
  const label = uniq[0] ?? "cli";
  return { ok: false, reason: `PATH \u91CC\u627E\u4E0D\u5230 ${uniq.length > 1 ? uniq.join(" \u6216 ") : label}` };
}
function clearBinCache(name) {
  if (name) cache.delete(name);
  else cache.clear();
}
function resolveBinUncached(name) {
  return resolveBinWith(name);
}
async function resolveBinWith(name, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const win = platform === "win32";
  const P = win ? path2.win32 : path2.posix;
  const exists = deps.exists ?? existsSync4;
  const hits = (deps.find ?? which)(name);
  if (!hits.length) return { ok: false, reason: `PATH \u91CC\u627E\u4E0D\u5230 ${name}` };
  const first = hits[0];
  if (!win) return { ok: true, cmd: first, prefixArgs: [], display: first, via: "path" };
  const ext = P.extname(first).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { ok: true, cmd: first, prefixArgs: [], display: first, via: "exe" };
  if (ext === ".ps1") {
    return {
      ok: true,
      cmd: "powershell.exe",
      prefixArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", first],
      display: first,
      via: "ps1"
    };
  }
  const dir = P.dirname(first);
  if (name.toLowerCase() === "npx") {
    const node = P.join(dir, "node.exe");
    const cli = P.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    if (exists(node) && exists(cli))
      return { ok: true, cmd: node, prefixArgs: [cli], display: `${node} ${cli}`, via: "npx-shim" };
  }
  const text = await (deps.readText ?? ((f) => readFile3(f, "utf8")))(first).catch(() => "");
  const target = shimTarget(text, dir, { exists, win: true });
  if (target && /\.(js|mjs|cjs)$/i.test(target)) {
    const node = (deps.node ?? findNode2)();
    return { ok: true, cmd: node, prefixArgs: [target], display: `${node} ${target}`, via: "shim-js" };
  }
  if (target && /\.exe$/i.test(target)) {
    return { ok: true, cmd: target, prefixArgs: [], display: target, via: "shim-exe" };
  }
  const comspec = deps.comspec ?? (process.env.ComSpec || "cmd.exe");
  return { ok: true, cmd: comspec, prefixArgs: [], display: first, via: "cmd-shim", shim: first };
}
function killTree(child, { graceMs = 3e3 } = {}) {
  if (!child || child.pid == null) return Promise.resolve();
  const pid = child.pid;
  if (IS_WIN) {
    return new Promise((resolvePromise) => {
      const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      tk.on("error", () => {
        try {
          child.kill();
        } catch {
        }
        resolvePromise();
      });
      tk.on("close", () => resolvePromise());
      setTimeout(resolvePromise, graceMs + 2e3);
    });
  }
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolvePromise();
      }
    };
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    const t = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
      finish();
    }, graceMs);
    t.unref?.();
    child.on("close", () => {
      clearTimeout(t);
      finish();
    });
  });
}
var IS_WIN, cache, CACHE_MS, CMD_META, liveTrees, exitHookInstalled;
var init_bin = __esm({
  "daemon/src/util/bin.ts"() {
    init_pathscan();
    IS_WIN = process.platform === "win32";
    cache = /* @__PURE__ */ new Map();
    CACHE_MS = 60 * 1e3;
    CMD_META = /([()\][%!^"`<>&|;, *?])/g;
    liveTrees = /* @__PURE__ */ new Set();
    exitHookInstalled = false;
  }
});

// daemon/src/agents/kinds.ts
function relPath(p, cwd) {
  if (!p) return "";
  const s = String(p);
  if (!cwd) return s;
  const norm = (x) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(s);
  const b = norm(cwd);
  if (a.toLowerCase().startsWith(b.toLowerCase() + "/")) return a.slice(b.length + 1);
  if (a.toLowerCase() === b.toLowerCase()) return ".";
  return s;
}
function callInfo(name, input = {}, cwd = "") {
  const t = String(name || "");
  const f = (kind, title, detail) => ({ kind, title, detail });
  const file = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
  switch (t) {
    case "Read":
      return f("read", `\u8BFB\u53D6 ${relPath(file, cwd)}`, { path: file, offset: input.offset, limit: input.limit });
    case "Edit":
      return f("edit", `\u7F16\u8F91 ${relPath(file, cwd)}`, { path: file, old: input.old_string, new: input.new_string });
    case "MultiEdit":
      return f("edit", `\u7F16\u8F91 ${relPath(file, cwd)}\uFF08${(input.edits || []).length} \u5904\uFF09`, { path: file, edits: input.edits ?? [] });
    case "Write":
      return f("write", `${input._exists ? "\u8986\u76D6" : "\u65B0\u5EFA"} ${relPath(file, cwd)}`, { path: file, content: input.content });
    case "NotebookEdit":
      return f("edit", `\u7F16\u8F91\u7B14\u8BB0\u672C ${relPath(String(input.notebook_path || file), cwd)}`, { path: input.notebook_path ?? file });
    case "Bash":
      return f("bash", `\u8FD0\u884C ${trunc(String(input.command ?? ""))}`, { command: input.command, description: input.description });
    case "BashOutput":
      return f("bash", `\u67E5\u770B\u8F93\u51FA ${String(input.bash_id ?? "")}`, { bashId: input.bash_id });
    case "KillShell":
      return f("bash", `\u7ED3\u675F\u8FDB\u7A0B ${String(input.shell_id ?? "")}`, { shellId: input.shell_id });
    case "Grep":
      return f("search", `\u641C\u7D22 "${trunc(String(input.pattern ?? ""), 40)}"`, { pattern: input.pattern, path: input.path, glob: input.glob });
    case "Glob":
    case "LS":
      return f("glob", `\u67E5\u627E ${trunc(String(input.pattern ?? input.path ?? ""), 40)}`, { pattern: input.pattern, path: input.path });
    case "WebFetch":
      return f("web", `\u6253\u5F00 ${hostOf(String(input.url ?? ""))}`, { url: input.url });
    case "WebSearch":
      return f("web", `\u641C\u7D22\u7F51\u9875 "${trunc(String(input.query ?? ""), 40)}"`, { query: input.query });
    case "TodoWrite": {
      const items = todoItems(input.todos ?? []);
      const done = items.filter((x) => x.status === "done").length;
      return f("todo", `\u66F4\u65B0\u5F85\u529E\uFF08${done}/${items.length}\uFF09`, { items });
    }
    case "Task":
    case "Agent":
      return f("task", `\u5B50\u4EFB\u52A1\uFF1A${trunc(String(input.description ?? input.prompt ?? ""), 40)}`, { description: input.description });
    default:
      break;
  }
  const m = /^mcp__([^_]+)__(.+)$/.exec(t);
  if (m) return f("mcp", `${m[1]} \xB7 ${m[2]}`, { server: m[1], tool: m[2] });
  return f("other", t || "\u5DE5\u5177", {});
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "").slice(0, 40);
  }
}
function todoItems(todos = []) {
  return todos.map((x) => ({
    text: x.content || x.text || "",
    status: x.status === "completed" ? "done" : x.status === "in_progress" ? "in_progress" : "pending"
  }));
}
var MAX_CMD, trunc;
var init_kinds = __esm({
  "daemon/src/agents/kinds.ts"() {
    MAX_CMD = 80;
    trunc = (s, n = MAX_CMD) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  }
});

// daemon/src/providers/claude/map.ts
function newMapState() {
  return { blocks: /* @__PURE__ */ new Map(), msgId: "", itemIdByBlock: /* @__PURE__ */ new Map(), typeSeq: /* @__PURE__ */ new Map(), sawInterrupt: false };
}
function itemIdFor(st, blockIdx, blkType) {
  const k = blockKind(blkType);
  const n = st.typeSeq.get(k) ?? 0;
  st.typeSeq.set(k, n + 1);
  const id = `${st.msgId}:${k}${n}`;
  st.itemIdByBlock.set(blockIdx, id);
  return id;
}
function mapSdkMessage(m, st, cwd) {
  const out = [];
  if (!m || typeof m !== "object") return out;
  const r = m;
  if (r.type === "system") {
    if (r.subtype === "init") {
      const sid = str(r.session_id) ?? "";
      if (sid) out.push({ type: "provider_session_id", id: sid });
    }
    if (r.subtype === "api_retry") {
      out.push({ type: "notice", level: "warn", message: `API \u91CD\u8BD5\u4E2D\uFF08\u7B2C ${r.attempt ?? "?"} \u6B21\uFF09` });
    }
    if (r.subtype === "compact_boundary") {
      out.push({ type: "notice", level: "info", message: "\u4E0A\u4E0B\u6587\u5DF2\u538B\u7F29" });
    }
    return out;
  }
  if (r.type === "stream_event") {
    const e = rec(m.event);
    if (e.type === "message_start") {
      const mid = str(rec(e.message).id);
      if (mid) st.msgId = mid;
      st.blocks.clear();
      st.itemIdByBlock.clear();
      st.typeSeq.clear();
      return out;
    }
    if (e.type === "content_block_start") {
      const idx = typeof e.index === "number" ? e.index : 0;
      const bt = str(rec(e.content_block).type) ?? "";
      st.blocks.set(idx, bt);
      itemIdFor(st, idx, bt);
      return out;
    }
    if (e.type === "content_block_delta") {
      const idx = typeof e.index === "number" ? e.index : 0;
      const d = rec(e.delta);
      const itemId = st.itemIdByBlock.get(idx) ?? itemIdFor(st, idx, d.type === "thinking_delta" ? "thinking" : "text");
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
        out.push({ type: "assistant_delta", itemId, text: d.text });
      } else if (d.type === "thinking_delta") {
        const t = str(d.thinking) ?? str(d.text);
        if (t) out.push({ type: "reasoning_delta", itemId, text: t });
      }
    }
    return out;
  }
  if (r.type === "assistant") {
    const mid = str(rec(r.message).id) ?? st.msgId ?? "";
    const content = rec(r.message).content;
    const parts = Array.isArray(content) ? content : [];
    const seqs = /* @__PURE__ */ new Map();
    parts.forEach((p) => {
      const blk = rec(p);
      const t = str(blk.type) ?? "";
      const k = blockKind(t);
      const n = seqs.get(k) ?? 0;
      seqs.set(k, n + 1);
      const itemId = `${mid}:${k}${n}`;
      if (blk.type === "text" && typeof blk.text === "string" && blk.text) {
        out.push({ type: "assistant_message", itemId, text: blk.text });
      } else if (blk.type === "thinking" || blk.type === "redacted_thinking") {
        const t2 = str(blk.thinking) ?? str(blk.text);
        if (t2) out.push({ type: "reasoning", itemId, text: t2 });
      } else if (blk.type === "tool_use") {
        out.push(...mapToolUse(blk, cwd));
      }
    });
    return out;
  }
  if (r.type === "user") {
    const content = rec(r.message).content;
    const parts = Array.isArray(content) ? content : [];
    for (const p of parts) {
      const blk = rec(p);
      if (blk.type === "tool_result") {
        const output = clean(contentText(blk.content));
        out.push({
          type: "tool_call",
          itemId: str(blk.tool_use_id) ?? "",
          kind: "other",
          title: "",
          status: blk.is_error ? "failed" : "ok",
          output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) : output
        });
      }
    }
    return out;
  }
  if (r.type === "result") {
    const usage = rec(r.usage);
    const num = (k) => typeof usage[k] === "number" ? usage[k] : 0;
    out.push({
      type: "usage",
      inputTokens: num("input_tokens"),
      outputTokens: num("output_tokens"),
      cacheReadTokens: num("cache_read_input_tokens"),
      costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : 0
    });
    const subtype = str(r.subtype) ?? "";
    const interrupted = st.sawInterrupt || /interrupt/i.test(subtype);
    const isError = r.is_error === true;
    out.push({
      type: "turn_ended",
      turnId: "",
      // The session fills in the current turnId
      status: interrupted ? "interrupted" : isError ? "failed" : "completed",
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : void 0,
      error: isError && !interrupted ? str(r.result) ?? subtype : void 0,
      filesChanged: typeof r.num_turns === "number" ? void 0 : void 0
    });
    st.sawInterrupt = false;
    return out;
  }
  return out;
}
function mapToolUse(blk, cwd) {
  const input = rec(blk.input);
  const name = str(blk.name) ?? "tool";
  const id = str(blk.id) ?? "";
  const info = callInfo(name, { ...input, _exists: true }, cwd);
  let detail = info.detail;
  if (info.kind === "edit" && (input.old_string !== void 0 || Array.isArray(input.edits))) {
    detail = editDetail({ path: info.detail.path, old: input.old_string, new: input.new_string, edits: input.edits });
  }
  if (info.kind === "write" && typeof input.content === "string") {
    const lines = input.content.split("\n");
    detail = { path: info.detail.path, lines: lines.slice(0, 200), totalLines: lines.length };
  }
  const out = [
    {
      type: "tool_call",
      itemId: id,
      kind: info.kind,
      title: info.title,
      status: "running",
      input,
      detail
    }
  ];
  if (name === "TodoWrite") {
    out.push({ type: "todo", items: todoItems(input.todos ?? []) });
  }
  return out;
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => str(rec(p).text) ?? "").join("");
  return "";
}
var MAX_OUTPUT, ANSI_RE, clean, blockKind, rec, str;
var init_map = __esm({
  "daemon/src/providers/claude/map.ts"() {
    init_kinds();
    init_diff();
    MAX_OUTPUT = 20 * 1024;
    ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
    clean = (s) => String(s ?? "").replace(ANSI_RE, "");
    blockKind = (t) => t === "thinking" || t === "redacted_thinking" ? "k" : t === "text" ? "t" : "x";
    rec = (v) => v && typeof v === "object" ? v : {};
    str = (v) => typeof v === "string" ? v : void 0;
  }
});

// daemon/src/util/i18n.ts
function normalizeLang(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "zh";
  if (s === "zh" || s.startsWith("zh-")) return "zh";
  return "en";
}
function setAppLocale(lang) {
  locale = normalizeLang(lang);
}
function tr(key, params) {
  let s = dict[locale][key] ?? dict.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
var locale, dict;
var init_i18n = __esm({
  "daemon/src/util/i18n.ts"() {
    locale = "zh";
    dict = {
      zh: {
        "thread.defaultTitle": "\u65B0\u5BF9\u8BDD",
        "notice.daemonRestart": "\u540E\u53F0\u5DF2\u91CD\u542F\uFF0C\u672C\u8F6E\u5DF2\u4E2D\u65AD",
        "notice.sessionStartFailed": "\u4F1A\u8BDD\u542F\u52A8\u5931\u8D25\uFF1A{detail}",
        "notice.sendFailed": "\u53D1\u9001\u5931\u8D25\uFF1A{detail}",
        "notice.effortNextTurn": "\u601D\u8003\u5F3A\u5EA6\u5DF2\u4FDD\u5B58\uFF0C\u5C06\u5728\u4E0B\u4E00\u8F6E\u751F\u6548",
        "notice.effortResetOnModel": "\u5F53\u524D\u6A21\u578B\u4E0D\u652F\u6301\u8BE5\u601D\u8003\u5F3A\u5EA6\uFF0C\u5DF2\u6062\u590D\u4E3A Default",
        "turn.agentExit": "Agent \u8FDB\u7A0B\u610F\u5916\u9000\u51FA",
        "attachment.missing": "\u9644\u4EF6\u4E0D\u5B58\u5728\u6216\u5DF2\u5931\u6548\uFF08{ref}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u4E0A\u4F20",
        "notice.acpImageByPath": "{agent} \u4E0D\u80FD\u76F4\u63A5\u770B\u56FE\u7247\uFF08\u5B83\u7684 ACP \u521D\u59CB\u5316\u672A\u58F0\u660E\u652F\u6301\u56FE\u7247\u8F93\u5165\uFF09\uFF0C\u5DF2\u6539\u4E3A\u53D1\u9001\u56FE\u7247\u7684\u6587\u4EF6\u8DEF\u5F84\uFF1A{paths}",
        "notice.acpImageByPathSwitched": "{agent} \u662F\u5728\u53E6\u4E00\u4E2A\u6A21\u578B\u4E0A\u542F\u52A8\u7684\uFF0C\u53EA\u5BF9\u90A3\u4E2A\u6A21\u578B\u63A5\u6536\u56FE\u7247\uFF0C\u8FD9\u6B21\u6539\u4E3A\u53D1\u9001\u56FE\u7247\u7684\u6587\u4EF6\u8DEF\u5F84\uFF08\u5F53\u524D\u6A21\u578B\u80FD\u770B\u56FE\u65F6\u5B83\u4F1A\u7528 read_image \u6253\u5F00\uFF09\uFF1A{paths}",
        "notice.attachmentIssue": "\u9644\u4EF6\u95EE\u9898\uFF1A{detail}",
        "export.defaultModel": "\u9ED8\u8BA4"
      },
      en: {
        "thread.defaultTitle": "New chat",
        "notice.daemonRestart": "Daemon restarted \u2014 this turn was interrupted",
        "notice.sessionStartFailed": "Session start failed: {detail}",
        "notice.sendFailed": "Send failed: {detail}",
        "notice.effortNextTurn": "Reasoning effort saved \u2014 takes effect on the next turn",
        "notice.effortResetOnModel": "This model does not support that effort level; reset to Default",
        "turn.agentExit": "Agent process exited unexpectedly",
        "attachment.missing": "Attachment missing or expired ({ref}) \u2014 upload again",
        "notice.acpImageByPath": "{agent} can't see images directly (its ACP initialize doesn't advertise image input); sent the image file path instead: {paths}",
        "notice.acpImageByPathSwitched": "{agent} was started on another model and takes image blocks only for that one, so the image went as its file path (it opens it with read_image when this model sees images): {paths}",
        "notice.attachmentIssue": "Attachment issue: {detail}",
        "export.defaultModel": "Default"
      }
    };
  }
});

// daemon/src/util/attachmentRefs.ts
var attachmentRefs_exports = {};
__export(attachmentRefs_exports, {
  bindAttachmentStore: () => bindAttachmentStore,
  resolveAttachmentRefs: () => resolveAttachmentRefs,
  resolveImagePath: () => resolveImagePath
});
import { existsSync as existsSync5 } from "node:fs";
function bindAttachmentStore(store) {
  globalAttachmentStore = store;
}
async function lookupAttachmentPath(ref) {
  const store = globalAttachmentStore;
  if (!store || !validId(ref)) return null;
  const att = await store.get(ref);
  return att?.path ?? null;
}
async function resolveAttachmentRefs(store, refs) {
  const out = [];
  for (const a of refs) {
    const att = validId(a.path) ? await store.get(a.path) : null;
    if (att) {
      out.push({ path: att.path, mime: att.mime || a.mime });
      continue;
    }
    const viaGlobal = await lookupAttachmentPath(a.path);
    if (viaGlobal) {
      out.push({ path: viaGlobal, mime: a.mime });
      continue;
    }
    if (existsSync5(a.path)) {
      out.push(a);
      continue;
    }
    throw new Error(tr("attachment.missing", { ref: a.path }));
  }
  return out;
}
async function resolveImagePath(ref) {
  if (existsSync5(ref)) return ref;
  const p = await lookupAttachmentPath(ref);
  if (p) return p;
  throw new Error(tr("attachment.missing", { ref }));
}
var globalAttachmentStore;
var init_attachmentRefs = __esm({
  "daemon/src/util/attachmentRefs.ts"() {
    init_paths();
    init_i18n();
    globalAttachmentStore = null;
  }
});

// daemon/src/util/attachmentKinds.ts
function baseMime(mime) {
  return String(mime ?? "").split(";")[0].trim().toLowerCase();
}
function attachmentKind(mime) {
  const m = baseMime(mime);
  if (MODEL_IMAGE_MIMES.has(m)) return "image";
  if (m.startsWith("text/") || TEXT_APP.has(m)) return "text";
  return "other";
}
function pathNote(kind, file) {
  return `${kind === "image" ? "Attached image" : "Attached file"}: ${file}`;
}
var MODEL_IMAGE_MIMES, TEXT_APP;
var init_attachmentKinds = __esm({
  "daemon/src/util/attachmentKinds.ts"() {
    MODEL_IMAGE_MIMES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    TEXT_APP = /* @__PURE__ */ new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript"]);
  }
});

// daemon/src/providers/claude/content.ts
import { readFile as readFile4, stat as stat3 } from "node:fs/promises";
import { basename } from "node:path";
async function buildClaudeContent(text, attachments) {
  const media = [];
  const notes = [];
  const warnings = [];
  for (const a of attachments) {
    let file;
    let size;
    try {
      file = await resolveImagePath(a.path);
      size = (await stat3(file)).size;
    } catch (e) {
      warnings.push(`${a.path}: ${String(e?.message ?? e)}`);
      continue;
    }
    const kind = attachmentKind(a.mime);
    try {
      if (kind === "image" && size <= CLAUDE_MAX_IMAGE_BYTES) {
        const data = (await readFile4(file)).toString("base64");
        media.push({ type: "image", source: { type: "base64", media_type: baseMime(a.mime), data } });
        continue;
      }
      if (kind === "text" && size <= CLAUDE_MAX_TEXT_BYTES) {
        const data = await readFile4(file, "utf8");
        media.push({ type: "document", source: { type: "text", media_type: "text/plain", data }, title: basename(file), context: file });
        continue;
      }
    } catch (e) {
      warnings.push(`${basename(file)}: ${String(e?.message ?? e)}`);
    }
    notes.push(pathNote(kind, file));
    if (kind === "other") warnings.push(`${basename(file)} (${baseMime(a.mime) || "unknown type"}) is not an image or a text file; sent its path`);
    else if (kind === "image" && size > CLAUDE_MAX_IMAGE_BYTES) warnings.push(`${basename(file)}: ${(size / 1024 / 1024).toFixed(1)} MB, over Claude's 5 MB image limit; sent its path`);
    else if (kind === "text" && size > CLAUDE_MAX_TEXT_BYTES) warnings.push(`${basename(file)}: ${(size / 1024 / 1024).toFixed(1)} MB, too large to attach inline; sent its path`);
  }
  const fullText = [text, ...notes.length ? [notes.join("\n")] : []].filter(Boolean).join("\n\n");
  return { blocks: [...media, { type: "text", text: fullText }], warnings };
}
var CLAUDE_MAX_IMAGE_BYTES, CLAUDE_MAX_TEXT_BYTES;
var init_content = __esm({
  "daemon/src/providers/claude/content.ts"() {
    init_attachmentRefs();
    init_attachmentKinds();
    CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    CLAUDE_MAX_TEXT_BYTES = 1024 * 1024;
  }
});

// daemon/src/providers/claude/session.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
function claudeExecutable(o) {
  if (!o.binCmd) return null;
  if (o.binVia === "cmd-shim" || o.binVia === "ps1") return null;
  const last = o.binPrefixArgs[o.binPrefixArgs.length - 1];
  if (last && /\.(c|m)?js$/i.test(last)) return { path: last, node: true };
  if (o.binPrefixArgs.length) return null;
  return { path: o.binCmd, node: false };
}
var EFFORTS, rid2, ClaudeSession;
var init_session = __esm({
  "daemon/src/providers/claude/session.ts"() {
    init_queue();
    init_kinds();
    init_diff();
    init_map();
    init_log();
    init_content();
    init_i18n();
    init_slash();
    EFFORTS = ["low", "medium", "high", "xhigh", "max"];
    rid2 = () => Math.random().toString(36).slice(2, 10);
    ClaudeSession = class {
      constructor(o) {
        this.o = o;
        this.sessionId = o.resumeId;
        this.events = this.q;
      }
      o;
      events;
      q = new AsyncQueue();
      input = new AsyncQueue();
      query = null;
      abort = new AbortController();
      sessionId;
      turnId = null;
      turnNum = 0;
      st = newMapState();
      pending = /* @__PURE__ */ new Map();
      needsRestart = false;
      restarting = null;
      closed = false;
      stderrTail = "";
      pumpDone = null;
      // The query is only started before the first send (a failed detection should be reported quickly)
      ensureQuery() {
        if (this.query && !this.needsRestart) return this.query;
        this.abort = new AbortController();
        this.st = newMapState();
        const options = {
          cwd: this.o.cwd,
          model: this.o.model ?? void 0,
          permissionMode: this.o.mode,
          canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
          includePartialMessages: true,
          settingSources: ["user", "project", "local"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          abortController: this.abort,
          ...this.sessionId ? { resume: this.sessionId } : {},
          stderr: (d) => {
            this.stderrTail = (this.stderrTail + d).slice(-4096);
          }
        };
        const exe = claudeExecutable(this.o);
        if (exe) {
          options.pathToClaudeCodeExecutable = exe.path;
          if (exe.node) options.executable = "node";
        }
        if (this.o.effort && EFFORTS.includes(this.o.effort)) {
          options.effort = this.o.effort;
        }
        const q = query({ prompt: this.input, options });
        this.query = q;
        this.needsRestart = false;
        this.pumpDone = this.pump(q);
        return q;
      }
      async pump(q) {
        try {
          for await (const m of q) {
            for (const ev of mapSdkMessage(m, this.st, this.o.cwd)) this.emit(ev);
          }
        } catch (e) {
          if (!this.abort.signal.aborted && !this.closed) {
            this.emit({ type: "notice", level: "error", message: "Claude \u4F1A\u8BDD\u5F02\u5E38\uFF1A" + this.errText(e) });
          }
        }
        if (!this.closed && this.query === q) {
          this.needsRestart = true;
          this.q.close();
        }
      }
      emit(ev) {
        if (ev.type === "turn_ended" && !ev.turnId) ev.turnId = this.turnId ?? "unknown";
        if (ev.type === "provider_session_id" && ev.id) this.sessionId = ev.id;
        this.q.push(ev);
      }
      errText(e) {
        const base = String(e?.message ?? e);
        return this.stderrTail ? `${base}\uFF1Bstderr: ${this.stderrTail.slice(-400)}` : base;
      }
      async send(input) {
        if (this.closed) throw new Error("\u4F1A\u8BDD\u5DF2\u5173\u95ED");
        if (this.needsRestart) await this.restart();
        const q = this.ensureQuery();
        this.turnNum++;
        this.turnId = "u_" + Date.now().toString(36) + "_" + this.turnNum;
        this.st.sawInterrupt = false;
        this.emit({
          type: "turn_started",
          turnId: this.turnId,
          model: this.o.model,
          mode: this.o.mode,
          effort: this.o.effort
        });
        const built = await buildClaudeContent(input.text, input.images ?? []);
        for (const w of built.warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
        const content = built.blocks;
        this.input.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: this.sessionId ?? ""
        });
        void q;
      }
      async restart() {
        if (this.restarting) return this.restarting;
        this.restarting = (async () => {
          this.query = null;
          try {
            this.input.close();
            this.abort.abort();
          } catch {
          }
          if (this.pumpDone) await this.pumpDone.catch(() => {
          });
          this.input = new AsyncQueue();
          try {
            this.ensureQuery();
          } finally {
            this.restarting = null;
          }
        })();
        return this.restarting;
      }
      // ---- permissions (§7.2.4) ----
      canUseTool(toolName, input, opts) {
        const requestId = "perm_" + rid2();
        const { signal } = opts;
        if (toolName === "ExitPlanMode") {
          return this.handlePlanMode(requestId, input, signal, opts.toolUseID);
        }
        if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
          return this.handleQuestion(requestId, input, signal);
        }
        const info = callInfo(toolName, { ...input, _exists: true }, this.o.cwd);
        let detail = { ...info.detail, toolName };
        if (info.kind === "edit" && (input.old_string !== void 0 || Array.isArray(input.edits))) {
          detail = { ...editDetail({ path: info.detail.path, old: input.old_string, new: input.new_string, edits: input.edits }), toolName };
        }
        this.emit({
          type: "permission_request",
          requestId,
          title: info.title,
          kind: "tool",
          detail,
          options: [
            { id: "allow", label: "\u5141\u8BB8", kind: "allow_once" },
            { id: "allow_always", label: "\u672C\u5BF9\u8BDD\u90FD\u5141\u8BB8", kind: "allow_always" },
            { id: "deny", label: "\u62D2\u7EDD", kind: "reject_once" }
          ]
        });
        return new Promise((resolve2) => {
          this.pending.set(requestId, { kind: "permission", resolve: (a) => resolve2(this.toPermissionResult(a, input)) });
          signal.addEventListener("abort", () => {
            if (this.pending.delete(requestId)) {
              this.emit({ type: "permission_resolved", requestId, cancelled: true });
              resolve2({ behavior: "deny", message: "\u5DF2\u53D6\u6D88", interrupt: true });
            }
          }, { once: true });
        });
      }
      toPermissionResult(a, input) {
        if (a.cancelled || a.optionId === "deny") {
          return { behavior: "deny", message: "\u7528\u6237\u62D2\u7EDD\u4E86\u6B64\u64CD\u4F5C", ...a.cancelled ? { interrupt: true } : {} };
        }
        return { behavior: "allow", updatedInput: input };
      }
      async handlePlanMode(requestId, input, signal, toolUseID) {
        const planText = typeof input.plan === "string" ? input.plan : "";
        if (planText) {
          this.emit({ type: "plan", itemId: toolUseID ?? requestId, markdown: planText });
        }
        this.emit({
          type: "permission_request",
          requestId,
          title: "Agent \u63D0\u4EA4\u4E86\u8BA1\u5212",
          kind: "plan",
          detail: { plan: planText },
          options: [
            { id: "implement", label: "\u5B9E\u65BD", kind: "allow_once" },
            { id: "reject", label: "\u62D2\u7EDD", kind: "reject_once" }
          ]
        });
        const answer = await new Promise((resolve2) => {
          this.pending.set(requestId, { kind: "permission", resolve: (a) => resolve2(a) });
          signal.addEventListener("abort", () => {
            if (this.pending.delete(requestId)) {
              this.emit({ type: "permission_resolved", requestId, cancelled: true });
              resolve2({ cancelled: true });
            }
          }, { once: true });
        });
        if (answer.cancelled || answer.optionId === "reject") {
          return { behavior: "deny", message: "\u7528\u6237\u62D2\u7EDD\u4E86\u8BA1\u5212\uFF0C\u8BF7\u6839\u636E\u53CD\u9988\u4FEE\u6539", ...answer.cancelled ? { interrupt: true } : {} };
        }
        try {
          await this.query?.setPermissionMode("default");
          this.o.mode = "default";
          this.o.onModeChange?.("default");
        } catch (e) {
          log("warn", "setPermissionMode(default) \u5931\u8D25", { err: String(e) });
        }
        return { behavior: "allow", updatedInput: input };
      }
      async handleQuestion(requestId, input, signal) {
        this.emit({ type: "question", requestId, questions: input.questions });
        const answer = await new Promise((resolve2) => {
          this.pending.set(requestId, { kind: "question", resolve: (a) => resolve2(a) });
          signal.addEventListener("abort", () => {
            if (this.pending.delete(requestId)) {
              this.emit({ type: "permission_resolved", requestId, cancelled: true });
              resolve2({ cancelled: true });
            }
          }, { once: true });
        });
        if (answer.cancelled) {
          return { behavior: "deny", message: "\u7528\u6237\u53D6\u6D88\u4E86\u63D0\u95EE", interrupt: true };
        }
        const questions = input.questions ?? [];
        const normalized = {};
        for (const ques of questions) {
          const text = ques.question;
          if (!text) continue;
          const v = answer.answers?.[text] ?? (ques.header ? answer.answers?.[ques.header] : void 0);
          if (v) normalized[text] = v;
        }
        return { behavior: "allow", updatedInput: { ...input, answers: normalized } };
      }
      respond(requestId, answer) {
        const p = this.pending.get(requestId);
        if (p) {
          this.pending.delete(requestId);
          p.resolve(answer);
        }
      }
      async interrupt() {
        this.st.sawInterrupt = true;
        for (const [id, p] of this.pending) {
          this.emit({ type: "permission_resolved", requestId: id, cancelled: true });
          p.resolve({ cancelled: true });
        }
        this.pending.clear();
        try {
          const q = this.query;
          if (q) {
            await Promise.race([
              q.interrupt(),
              new Promise((_, rej) => setTimeout(() => rej(new Error("interrupt \u8D85\u65F6")), 3e3))
            ]);
          }
        } catch (e) {
          log("warn", "interrupt \u5931\u8D25", { err: String(e) });
          this.needsRestart = true;
        }
      }
      async setModel(model) {
        this.o.model = model;
        try {
          await this.query?.setModel(model ?? void 0);
        } catch (e) {
          log("warn", "setModel \u5931\u8D25", { err: String(e) });
        }
      }
      async setMode(mode) {
        this.o.mode = mode;
        try {
          await this.query?.setPermissionMode(mode);
        } catch (e) {
          log("warn", "setPermissionMode \u5931\u8D25", { err: String(e) });
        }
      }
      async setEffort(effort) {
        this.o.effort = effort;
        this.needsRestart = true;
      }
      async listCommands() {
        try {
          const q = this.ensureQuery();
          const commands = await q.supportedCommands();
          const map = /* @__PURE__ */ new Map();
          for (const cmd of commands) {
            if (!map.has(cmd.name)) {
              map.set(cmd.name, {
                name: cmd.name,
                description: cmd.description,
                argumentHint: cmd.argumentHint,
                kind: classifyClaudeSlashCommand(cmd.name)
              });
            }
          }
          return sortSlashCommands([...map.values()]);
        } catch {
          return [];
        }
      }
      async close() {
        this.closed = true;
        for (const [, p] of this.pending) p.resolve({ cancelled: true });
        this.pending.clear();
        this.input.close();
        try {
          this.abort.abort();
        } catch {
        }
        if (this.pumpDone) {
          await Promise.race([this.pumpDone.catch(() => {
          }), new Promise((r) => setTimeout(r, 3e3))]);
        }
        this.q.close();
      }
    };
  }
});

// daemon/src/providers/claude/models.ts
async function listClaudeModels() {
  return [];
}
var init_models = __esm({
  "daemon/src/providers/claude/models.ts"() {
  }
});

// daemon/src/history/import.ts
import { readdir, readFile as readFile5, stat as stat4 } from "node:fs/promises";
import { existsSync as existsSync6 } from "node:fs";
import { join as join6 } from "node:path";
import { homedir as homedir3 } from "node:os";
function parseLine(line) {
  let r;
  try {
    r = rec2(JSON.parse(line));
  } catch {
    return null;
  }
  const cwd = str2(r.cwd);
  let userText;
  if (r.type === "user") {
    const content = rec2(r.message).content;
    if (typeof content === "string") userText = content;
    else if (Array.isArray(content)) {
      const t = content.map((p) => rec2(p).type === "text" ? str2(rec2(p).text) : void 0).find(Boolean);
      userText = t;
    }
  }
  return { cwd, userText };
}
async function* linesOf(path3) {
  const text = await readFile5(path3, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (line.trim()) yield line;
  }
}
async function listClaudeHistory(cwd) {
  const out = [];
  const dirs = await readdir(CLAUDE_ROOT).catch(() => []);
  for (const d of dirs) {
    const dirPath = join6(CLAUDE_ROOT, d);
    const files = (await readdir(dirPath).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const path3 = join6(dirPath, f);
      let match = false;
      let title = "";
      let count = 0;
      for await (const line of linesOf(path3)) {
        const p = parseLine(line);
        if (!p) continue;
        if (!match) {
          if (!p.cwd) continue;
          match = samePath(p.cwd, cwd);
          if (!match) break;
        }
        if (p.userText && !title) title = p.userText.slice(0, 40);
        if (p.userText) count++;
      }
      if (!match) continue;
      const s = await stat4(path3).catch(() => null);
      out.push({
        sessionId: f.replace(/\.jsonl$/, ""),
        title: title || "\uFF08\u65E0\u6807\u9898\uFF09",
        updatedAt: s ? Math.round(s.mtimeMs) : 0,
        messageCount: count
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
async function readClaudeHistory(sessionId, cwd) {
  const dirs = await readdir(CLAUDE_ROOT).catch(() => []);
  for (const d of dirs) {
    const path3 = join6(CLAUDE_ROOT, d, `${sessionId}.jsonl`);
    if (!existsSync6(path3)) continue;
    const msgs = [];
    let matched = false;
    for await (const line of linesOf(path3)) {
      const p = parseLine(line);
      if (!matched) {
        if (p?.cwd && samePath(p.cwd, cwd)) matched = true;
        else continue;
      }
      let r;
      try {
        r = rec2(JSON.parse(line));
      } catch {
        continue;
      }
      if (r.type === "user" || r.type === "assistant") msgs.push(r);
    }
    return msgs;
  }
  return [];
}
var CLAUDE_ROOT, rec2, str2;
var init_import = __esm({
  "daemon/src/history/import.ts"() {
    init_paths();
    CLAUDE_ROOT = join6(homedir3(), ".claude", "projects");
    rec2 = (v) => v && typeof v === "object" ? v : {};
    str2 = (v) => typeof v === "string" ? v : void 0;
  }
});

// daemon/src/providers/claude/provider.ts
function runVersion(r, args, timeoutMs = 5e3) {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    const p = spawnBin(r, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const t = setTimeout(() => {
      try {
        void killTree(p, { graceMs: 500 });
      } catch {
      }
      reject(new Error("timeout"));
    }, timeoutMs);
    p.stdout?.on("data", (c) => out += c.toString());
    p.stderr?.on("data", (c) => out += c.toString());
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolvePromise(out);
      else reject(new Error("exit " + code));
    });
  });
}
function createClaudeProvider() {
  return {
    id: "claude",
    name: "Claude Code",
    capabilities: claudeCapabilities,
    async detect() {
      const bin = await resolveBin("claude");
      if (!bin.ok) return { available: false, reason: bin.reason, installHint: INSTALL_HINT };
      try {
        const version = await runVersion(bin, ["--version"]);
        return { available: true, bin: bin.display, version: version.trim().split("\n")[0] || "" };
      } catch {
        return { available: true, bin: bin.display, version: "" };
      }
    },
    async listModels() {
      return listClaudeModels();
    },
    async createSession(o) {
      const bin = await resolveBin("claude");
      if (!bin.ok) throw new Error(`\u627E\u4E0D\u5230 claude\uFF1A${bin.reason}`);
      return new ClaudeSession({
        threadId: o.threadId,
        cwd: o.cwd,
        model: o.model,
        mode: o.mode,
        effort: o.effort,
        resumeId: o.resumeId,
        binCmd: bin.cmd,
        binPrefixArgs: bin.prefixArgs,
        binVia: bin.via
      });
    },
    // §7.6: jsonl sessions under ~/.claude/projects matched by cwd
    async listHistory(cwd) {
      const items = await listClaudeHistory(cwd);
      return items.map((i) => ({ provider: "claude", ...i, imported: false }));
    },
    async readHistory(sessionId, cwd) {
      const msgs = await readClaudeHistory(sessionId, cwd);
      const st = newMapState();
      const out = [];
      for (const m of msgs) {
        const r = m;
        if (r.type === "user") {
          const content = r.message?.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") : "";
          if (text.trim()) out.push({ type: "user_message", text });
          else out.push(...mapSdkMessage(m, st, cwd));
          continue;
        }
        out.push(...mapSdkMessage(m, st, cwd));
      }
      out.push({ type: "turn_ended", turnId: "", status: "completed" });
      return out;
    }
  };
}
var INSTALL_HINT, claudeCapabilities;
var init_provider = __esm({
  "daemon/src/providers/claude/provider.ts"() {
    init_bin();
    init_session();
    init_models();
    init_import();
    init_map();
    INSTALL_HINT = "npm i -g @anthropic-ai/claude-code";
    claudeCapabilities = {
      resume: true,
      interrupt: true,
      steer: false,
      // Claude doesn't support real steering — the manager queues instead (§7.2.2)
      images: true,
      plan: true,
      questions: true,
      cost: true,
      effort: ["low", "medium", "high", "xhigh", "max"],
      modes: ["plan", "default", "acceptEdits", "bypassPermissions"]
    };
  }
});

// daemon/src/history/codex.ts
import { readdir as readdir2, readFile as readFile6, stat as stat5 } from "node:fs/promises";
import { join as join7 } from "node:path";
import { homedir as homedir4 } from "node:os";
function textOf(content, kind) {
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p.type === kind || p.type === "input_text" || p.type === "output_text").map((p) => str3(p.text) ?? "").join("\n").trim();
}
async function* walk(dir, depth = 0) {
  if (depth > 6) return;
  for (const name of await readdir2(dir).catch(() => [])) {
    const p = join7(dir, name);
    const s = await stat5(p).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) yield* walk(p, depth + 1);
    else if (/^rollout-.*\.jsonl$/.test(name)) yield p;
  }
}
async function listCodexHistory(cwd) {
  const out = [];
  for await (const path3 of walk(CODEX_ROOT)) {
    const m = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(path3);
    const sessionId = m?.[1];
    if (!sessionId) continue;
    const text = await readFile6(path3, "utf8").catch(() => "");
    let match = false;
    let title = "";
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try {
        r = rec3(JSON.parse(line));
      } catch {
        continue;
      }
      if (r.type === "session_meta") {
        const cwdInFile = str3(rec3(r.payload).cwd);
        if (cwdInFile && samePath(cwdInFile, cwd)) match = true;
        else break;
        continue;
      }
      if (!match) continue;
      if (r.type === "response_item") {
        const p = rec3(r.payload);
        if (p.type === "message" && p.role === "user") {
          const t = textOf(p.content, "input_text");
          if (t && !WRAPPERS.test(t)) {
            count++;
            if (!title) title = t.slice(0, 40);
          }
        }
      }
    }
    if (!match) continue;
    const s = await stat5(path3).catch(() => null);
    out.push({ sessionId, title: title || "\uFF08\u65E0\u6807\u9898\uFF09", updatedAt: s ? Math.round(s.mtimeMs) : 0, messageCount: count });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
async function readCodexHistory(sessionId, cwd) {
  const out = [];
  let file = null;
  for await (const p of walk(CODEX_ROOT)) {
    if (p.endsWith(`${sessionId}.jsonl`)) {
      file = p;
      break;
    }
  }
  if (!file) return out;
  const text = await readFile6(file, "utf8").catch(() => "");
  let matched = false;
  let aid = 0;
  const seenText = /* @__PURE__ */ new Set();
  const pushText = (type, t) => {
    const key = type + ":" + t;
    if (!t || seenText.has(key)) return;
    seenText.add(key);
    out.push(type === "user_message" ? { type, text: t } : { type, itemId: `imp_a${aid++}`, text: t });
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = rec3(JSON.parse(line));
    } catch {
      continue;
    }
    if (r.type === "session_meta") {
      const c = str3(rec3(r.payload).cwd);
      if (c && samePath(c, cwd)) matched = true;
      continue;
    }
    if (!matched) continue;
    if (r.type === "response_item") {
      const p = rec3(r.payload);
      if (p.type === "message") {
        const role = str3(p.role);
        const phase = str3(p.phase);
        if (role === "user") {
          const t = textOf(p.content, "input_text");
          if (t && !WRAPPERS.test(t)) pushText("user_message", t);
        } else if (role === "assistant" && phase !== "commentary") {
          const t = textOf(p.content, "output_text");
          if (t) pushText("assistant_message", t);
        }
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        const name = str3(p.name) ?? "tool";
        out.push({ type: "notice", level: "info", message: `\uFF08\u5386\u53F2\uFF09\u8C03\u7528 ${name}` });
      }
      continue;
    }
    if (r.type === "event_msg") {
      const p = rec3(r.payload);
      if (p.type === "item_completed") {
        const it = rec3(p.item);
        if (it.type === "AgentMessage" && it.phase !== "commentary") {
          const t = textOf(it.content, "Text");
          if (t) pushText("assistant_message", t);
        } else if (it.type === "UserMessage") {
          const t = textOf(it.content, "text");
          if (t && !WRAPPERS.test(t)) pushText("user_message", t);
        }
      } else if (p.type === "task_complete") {
        const last = str3(p.last_agent_message);
        if (last) pushText("assistant_message", last);
      }
      continue;
    }
    const p2 = rec3(r.payload);
    if (p2.type === "function_call" || p2.type === "custom_tool_call") {
      const name = str3(p2.name) ?? "tool";
      out.push({ type: "notice", level: "info", message: `\uFF08\u5386\u53F2\uFF09\u8C03\u7528 ${name}` });
    }
  }
  out.push({ type: "turn_ended", turnId: "import", status: "completed" });
  return out;
}
var CODEX_ROOT, rec3, str3, WRAPPERS;
var init_codex = __esm({
  "daemon/src/history/codex.ts"() {
    init_paths();
    CODEX_ROOT = join7(homedir4(), ".codex", "sessions");
    rec3 = (v) => v && typeof v === "object" ? v : {};
    str3 = (v) => typeof v === "string" ? v : void 0;
    WRAPPERS = /^\s*<(environment_context|user_instructions|skills_instructions|permissions instructions)>/i;
  }
});

// daemon/src/providers/codex/rpc.ts
import { spawn as spawn2 } from "node:child_process";
var CodexRpcError, CodexProcessExitedError, CodexRpc;
var init_rpc = __esm({
  "daemon/src/providers/codex/rpc.ts"() {
    init_log();
    init_bin();
    CodexRpcError = class extends Error {
      code;
      constructor(message, code) {
        super(message);
        this.code = code;
      }
    };
    CodexProcessExitedError = class extends CodexRpcError {
      constructor() {
        super("Codex \u8FDB\u7A0B\u5DF2\u9000\u51FA");
      }
    };
    CodexRpc = class {
      proc;
      nextId = 1;
      pending = /* @__PURE__ */ new Map();
      buf = "";
      exited = false;
      onServerRequest;
      onNotification;
      onExit;
      constructor(argv, opts = {}) {
        this.proc = spawn2(argv.cmd, argv.args, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          ...argv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {},
          // Non-Windows: its own process group, so after a close() timeout killTree also ends the commands codex started
          ...process.platform !== "win32" ? { detached: true } : {}
        });
        trackTree(this.proc);
        this.proc.stdout.setEncoding("utf8");
        this.proc.stdout.on("data", (chunk) => this.onData(chunk));
        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", (chunk) => {
          this.stderrTail = (this.stderrTail + chunk).slice(-4096);
        });
        this.proc.on("error", () => this.failAll());
        this.proc.on("close", (code) => {
          this.exited = true;
          this.failAll();
          this.onExit?.(code);
        });
      }
      stderrTail = "";
      get stderr() {
        return this.stderrTail;
      }
      get isExited() {
        return this.exited;
      }
      onData(chunk) {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            log("warn", "codex rpc: \u975E JSON \u884C", { line: line.slice(0, 200) });
            continue;
          }
          void this.dispatch(msg);
        }
      }
      async dispatch(msg) {
        const hasId = msg.id !== void 0 && msg.id !== null;
        if (hasId && ("result" in msg || "error" in msg)) {
          const id = Number(msg.id);
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            if (msg.error) {
              const e = msg.error;
              p.reject(new CodexRpcError(e.message ?? "RPC error", e.code));
            } else {
              p.resolve(msg.result);
            }
          }
          return;
        }
        if (hasId && msg.method) {
          const id = Number(msg.id);
          try {
            const result = this.onServerRequest ? await this.onServerRequest(String(msg.method), msg.params ?? {}) : void 0;
            this.send({ id, result: result ?? null });
          } catch (e) {
            this.send({ id, error: { code: -32603, message: String(e?.message ?? e) } });
          }
          return;
        }
        if (!hasId && msg.method) {
          try {
            this.onNotification?.(String(msg.method), msg.params ?? {});
          } catch (e) {
            log("warn", "codex rpc: \u901A\u77E5\u5904\u7406\u5931\u8D25", { method: msg.method, err: String(e) });
          }
        }
      }
      send(obj) {
        if (this.exited) return;
        try {
          this.proc.stdin.write(JSON.stringify(obj) + "\n");
        } catch {
        }
      }
      request(method, params, timeoutMs = 6e4) {
        if (this.exited) return Promise.reject(new CodexProcessExitedError());
        const id = this.nextId++;
        return new Promise((resolvePromise, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new CodexRpcError(`\u8BF7\u6C42\u8D85\u65F6\uFF1A${method}`));
          }, timeoutMs);
          this.pending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolvePromise(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            }
          });
          this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
        });
      }
      notify(method, params) {
        this.send({ jsonrpc: "2.0", method, params: params ?? {} });
      }
      failAll() {
        const err = new CodexProcessExitedError();
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      }
      async close() {
        try {
          this.proc.stdin?.end();
        } catch {
        }
        await new Promise((resolvePromise) => {
          const t = setTimeout(() => {
            void killTree(this.proc, { graceMs: 1500 });
            resolvePromise();
          }, 3e3);
          this.proc.on("close", () => {
            clearTimeout(t);
            resolvePromise();
          });
          if (this.exited) {
            clearTimeout(t);
            resolvePromise();
          }
        });
      }
    };
  }
});

// daemon/src/providers/codex/input.ts
import { basename as basename2 } from "node:path";
async function buildCodexInput(text, attachments) {
  const images = [];
  const notes = [];
  const warnings = [];
  for (const a of attachments) {
    let file;
    try {
      file = await resolveImagePath(a.path);
    } catch (e) {
      warnings.push(`${a.path}: ${String(e?.message ?? e)}`);
      continue;
    }
    const kind = attachmentKind(a.mime);
    if (kind === "image") {
      images.push({ type: "localImage", path: file });
      continue;
    }
    notes.push(pathNote(kind, file));
    if (kind === "other") warnings.push(`${basename2(file)} (${baseMime(a.mime) || "unknown type"}) is not an image or a text file; sent its path`);
  }
  const fullText = [text, ...notes.length ? [notes.join("\n")] : []].filter(Boolean).join("\n\n");
  return { items: [{ type: "text", text: fullText }, ...images], warnings };
}
var init_input = __esm({
  "daemon/src/providers/codex/input.ts"() {
    init_attachmentRefs();
    init_attachmentKinds();
  }
});

// daemon/src/providers/codex/map.ts
function newCodexMapState() {
  return { currentTurnId: null, filesChanged: 0, diffText: "" };
}
function mapNotification(method, params, st) {
  const out = [];
  const turnId = str4(params.turnId);
  switch (method) {
    case "turn/started": {
      const turn = rec4(params.turn);
      const tid = str4(turn.id);
      if (tid) st.currentTurnId = tid;
      st.filesChanged = 0;
      st.diffText = "";
      break;
    }
    case "item/agentMessage/delta": {
      const itemId = str4(params.itemId) ?? "";
      const delta = str4(params.delta) ?? "";
      if (itemId && delta) out.push({ type: "assistant_delta", itemId, text: delta });
      break;
    }
    case "item/plan/delta": {
      break;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const itemId = str4(params.itemId) ?? "";
      const delta = str4(params.delta) ?? "";
      if (itemId && delta) out.push({ type: "reasoning_delta", itemId, text: delta });
      break;
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "command/exec/outputDelta": {
      const itemId = str4(params.itemId) ?? "";
      const delta = str4(params.delta) ?? "";
      if (itemId && delta) out.push({ type: "tool_output_delta", itemId, text: delta });
      break;
    }
    case "item/started": {
      const item = rec4(params.item);
      const type = str4(item.type) ?? "";
      const itemId = str4(item.id) ?? "";
      if (type === "commandExecution") {
        const cmd = str4(item.command) ?? "";
        out.push({
          type: "tool_call",
          itemId,
          kind: "bash",
          title: `\u8FD0\u884C ${trunc2(cmd)}`,
          status: "running",
          detail: { command: cmd, cwd: str4(item.cwd) }
        });
      } else if (type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        out.push({
          type: "tool_call",
          itemId,
          kind: "edit",
          title: `\u4FEE\u6539 ${changes.length} \u4E2A\u6587\u4EF6`,
          status: "running",
          detail: { changes }
        });
      } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
        const tool = str4(item.tool) ?? str4(item.name) ?? "";
        const server = str4(item.server) ?? "";
        out.push({
          type: "tool_call",
          itemId,
          kind: "mcp",
          title: `${server || "mcp"} \xB7 ${tool}`,
          status: "running"
        });
      } else if (type === "webSearch") {
        out.push({
          type: "tool_call",
          itemId,
          kind: "web",
          title: `\u641C\u7D22\u7F51\u9875 "${trunc2(str4(item.query) ?? "", 40)}"`,
          status: "running"
        });
      }
      break;
    }
    case "item/completed": {
      const item = rec4(params.item);
      const type = str4(item.type) ?? "";
      const itemId = str4(item.id) ?? "";
      if (type === "agentMessage") {
        const text = str4(item.text) ?? "";
        if (text) out.push({ type: "assistant_message", itemId, text });
      } else if (type === "reasoning") {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const text = summary.filter((s) => typeof s === "string").join("\n");
        if (text) out.push({ type: "reasoning", itemId, text });
      } else if (type === "commandExecution") {
        const cmd = str4(item.command) ?? "";
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : void 0;
        const output = str4(item.aggregatedOutput) ?? "";
        out.push({
          type: "tool_call",
          itemId,
          kind: "bash",
          title: `\u8FD0\u884C ${trunc2(cmd)}`,
          status: exitCode === 0 ? "ok" : "failed",
          output: output.length > MAX_OUTPUT2 ? output.slice(0, MAX_OUTPUT2) : output,
          exitCode,
          durationMs: typeof item.durationMs === "number" ? item.durationMs : void 0
        });
      } else if (type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const istatus = str4(item.status);
        st.filesChanged += changes.length;
        out.push({
          type: "tool_call",
          itemId,
          kind: "edit",
          title: `\u4FEE\u6539 ${changes.length} \u4E2A\u6587\u4EF6`,
          status: istatus === "failed" ? "failed" : "ok",
          detail: { changes }
        });
      } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
        const tool = str4(item.tool) ?? str4(item.name) ?? "";
        const server = str4(item.server) ?? "";
        const istatus = str4(item.status);
        const err = str4(item.error);
        out.push({
          type: "tool_call",
          itemId,
          kind: "mcp",
          title: `${server || "mcp"} \xB7 ${tool}`,
          status: istatus === "failed" || err ? "failed" : "ok",
          output: err ?? void 0
        });
      } else if (type === "webSearch") {
        out.push({
          type: "tool_call",
          itemId,
          kind: "web",
          title: `\u641C\u7D22\u7F51\u9875 "${trunc2(str4(item.query) ?? "", 40)}"`,
          status: "ok"
        });
      } else if (type === "plan") {
        const text = str4(item.text) ?? "";
        if (text) out.push({ type: "plan", itemId, markdown: text });
      }
      break;
    }
    case "turn/plan/updated": {
      const steps = Array.isArray(params.plan) ? params.plan : [];
      const items = steps.map((s) => {
        const step = rec4(s);
        const status = str4(step.status) ?? "pending";
        return {
          text: str4(step.step) ?? "",
          status: status === "completed" ? "done" : status === "inProgress" || status === "in_progress" ? "in_progress" : "pending"
        };
      });
      if (items.length) out.push({ type: "todo", items });
      break;
    }
    case "turn/diff/updated": {
      const diff = str4(params.diff) ?? "";
      if (diff) st.diffText = diff;
      break;
    }
    case "thread/tokenUsage/updated": {
      const usage = rec4(params.tokenUsage);
      const last = rec4(usage.last) || usage;
      const input = typeof last.inputTokens === "number" ? last.inputTokens : 0;
      const output = typeof last.outputTokens === "number" ? last.outputTokens : 0;
      const cached = typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : 0;
      out.push({
        type: "usage",
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cached,
        costUsd: 0
      });
      break;
    }
    case "turn/completed": {
      const turn = rec4(params.turn);
      const status = str4(turn.status) ?? "completed";
      const error = rec4(turn.error);
      out.push({
        type: "turn_ended",
        turnId: str4(turn.id) ?? turnId ?? st.currentTurnId ?? "",
        status: status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed",
        durationMs: typeof turn.durationMs === "number" ? turn.durationMs : void 0,
        error: str4(error.message),
        filesChanged: st.filesChanged || void 0
      });
      break;
    }
    case "error": {
      const msg = str4(params.message) ?? "Codex \u9519\u8BEF";
      out.push({ type: "notice", level: "error", message: msg });
      break;
    }
    default:
      break;
  }
  return out;
}
var MAX_OUTPUT2, trunc2, rec4, str4;
var init_map2 = __esm({
  "daemon/src/providers/codex/map.ts"() {
    MAX_OUTPUT2 = 20 * 1024;
    trunc2 = (s, n = 80) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
    rec4 = (v) => v && typeof v === "object" ? v : {};
    str4 = (v) => typeof v === "string" ? v : void 0;
  }
});

// daemon/src/providers/codex/commands.ts
import { readdir as readdir3, readFile as readFile7, stat as stat6 } from "node:fs/promises";
import { homedir as homedir5 } from "node:os";
import { basename as basename3, join as join8 } from "node:path";
function parseFrontMatter(raw) {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: raw };
  const fm = raw.slice(4, end);
  const meta = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(end + 5) };
}
function firstLine(body) {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t.replace(/^#+\s*/, "").slice(0, 120);
  }
  return "";
}
async function readPromptFiles(dir) {
  const out = [];
  let names = [];
  try {
    names = await readdir3(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const path3 = join8(dir, f);
    try {
      const st = await stat6(path3);
      if (!st.isFile()) continue;
      const raw = await readFile7(path3, "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const name = basename3(f, ".md");
      out.push({
        name,
        description: meta.description || firstLine(body) || name,
        argumentHint: meta.argumentHint || meta["argument-hint"],
        kind: "command",
        body
      });
    } catch {
    }
  }
  return out;
}
async function readSkillDirs(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = await readdir3(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const skillPath = join8(root, d, "SKILL.md");
    try {
      const st = await stat6(skillPath);
      if (!st.isFile()) continue;
      const raw = await readFile7(skillPath, "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const name = meta.name || d;
      out.push({
        name,
        description: meta.description || firstLine(body) || name,
        argumentHint: meta.argumentHint,
        kind: "skill",
        body
      });
    } catch {
    }
  }
  return out;
}
async function loadCodexSlashEntries(cwd, opts) {
  const home = homedir5();
  const parts = await Promise.all([
    opts?.skipHome ? Promise.resolve([]) : readPromptFiles(join8(home, ".codex", "prompts")),
    readPromptFiles(join8(cwd, ".codex", "prompts")),
    opts?.skipHome ? Promise.resolve([]) : readSkillDirs(join8(home, ".codex", "skills")),
    readSkillDirs(join8(cwd, ".codex", "skills"))
  ]);
  const byName = /* @__PURE__ */ new Map();
  for (const list of parts) {
    for (const e of list) {
      if (!byName.has(e.name)) byName.set(e.name, e);
    }
  }
  return sortSlashCommands([...byName.values()]);
}
function expandCodexSlash(text, entries) {
  const parsed = parseSlashInput(text);
  if (!parsed) return text;
  const hit = entries.find((e) => e.name === parsed.name);
  if (!hit) return text;
  return hit.body.replace(/\$ARGUMENTS/g, parsed.args);
}
function codexSlashCommandsFromEntries(entries) {
  return entries.map(({ body: _b, ...rest }) => rest);
}
var init_commands = __esm({
  "daemon/src/providers/codex/commands.ts"() {
    init_slash();
  }
});

// daemon/src/providers/codex/session.ts
var rid3, MODE_PRESETS, CodexSession;
var init_session2 = __esm({
  "daemon/src/providers/codex/session.ts"() {
    init_input();
    init_i18n();
    init_queue();
    init_rpc();
    init_bin();
    init_map2();
    init_commands();
    init_log();
    rid3 = () => Math.random().toString(36).slice(2, 10);
    MODE_PRESETS = {
      plan: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
      default: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
      acceptEdits: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
      bypassPermissions: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
      ask: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } }
    };
    CodexSession = class {
      constructor(o) {
        this.o = o;
        this.events = this.q;
      }
      o;
      events;
      q = new AsyncQueue();
      rpc = null;
      st = newCodexMapState();
      sessionThreadId = null;
      pending = /* @__PURE__ */ new Map();
      closed = false;
      started = null;
      interruptWanted = false;
      ourTurnId = null;
      // The current turn's turnId in the timeline (generated on send)
      staleCodexTurns = /* @__PURE__ */ new Set();
      codexSlash = null;
      emit(ev) {
        if (ev.type === "turn_ended") {
          if (ev.turnId && this.staleCodexTurns.delete(ev.turnId)) return;
          if (this.ourTurnId) ev.turnId = this.ourTurnId;
          this.ourTurnId = null;
          this.st.currentTurnId = null;
          this.interruptWanted = false;
        }
        this.q.push(ev);
      }
      async start() {
        if (this.started) return this.started;
        const attempt = (async () => {
          const rpc = new CodexRpc(
            argvFor(
              { ok: true, cmd: this.o.binCmd, prefixArgs: this.o.binPrefixArgs, display: this.o.binCmd, via: this.o.binVia ?? "path", shim: this.o.binShim },
              ["app-server"]
            ),
            { cwd: this.o.cwd }
          );
          this.rpc = rpc;
          rpc.onNotification = (m, p) => {
            for (const ev of mapNotification(m, p, this.st)) this.emit(ev);
            if (this.interruptWanted && this.st.currentTurnId) void this.interrupt();
          };
          rpc.onServerRequest = (m, p) => this.onServerRequest(m, p);
          rpc.onExit = () => {
            for (const [, p] of this.pending) p.resolve({ cancelled: true });
            this.pending.clear();
            if (!this.closed) this.q.close();
          };
          await rpc.request("initialize", {
            clientInfo: { name: "agent-console", title: "Agent Console", version: this.o.version },
            capabilities: { experimentalApi: true }
          });
          rpc.notify("initialized", {});
          const preset = MODE_PRESETS[this.o.mode];
          let threadId;
          if (this.o.resumeId) {
            const res = await rpc.request("thread/resume", {
              threadId: this.o.resumeId,
              cwd: this.o.cwd,
              model: this.o.model,
              approvalPolicy: preset.approvalPolicy,
              sandbox: preset.sandbox
            });
            threadId = res.thread?.id ?? this.o.resumeId;
          } else {
            const res = await rpc.request("thread/start", {
              cwd: this.o.cwd,
              model: this.o.model,
              approvalPolicy: preset.approvalPolicy,
              sandbox: preset.sandbox
            });
            threadId = res.thread?.id ?? "";
          }
          if (threadId) {
            this.sessionThreadId = threadId;
            this.emit({ type: "provider_session_id", id: threadId });
          }
        })();
        this.started = attempt.catch((e) => {
          if (this.started === guarded) {
            this.started = null;
            const rpc = this.rpc;
            this.rpc = null;
            if (rpc) {
              rpc.onExit = () => {
              };
              void Promise.resolve(rpc.close()).catch(() => {
              });
            }
          }
          throw e;
        });
        const guarded = this.started;
        return this.started;
      }
      async send(input) {
        if (this.closed) throw new Error("\u4F1A\u8BDD\u5DF2\u5173\u95ED");
        await this.start();
        const rpc = this.rpc;
        const preset = MODE_PRESETS[this.o.mode];
        const entries = this.codexSlash ?? await loadCodexSlashEntries(this.o.cwd);
        this.codexSlash = entries;
        const wireText = expandCodexSlash(input.text, entries);
        const { items, warnings } = await buildCodexInput(wireText, input.images ?? []);
        this.interruptWanted = false;
        const turnId = "u_" + Date.now().toString(36) + "_" + rid3();
        if (this.ourTurnId && this.st.currentTurnId) this.staleCodexTurns.add(this.st.currentTurnId);
        this.ourTurnId = turnId;
        this.st.currentTurnId = null;
        this.emit({
          type: "turn_started",
          turnId,
          model: this.o.model,
          mode: this.o.mode,
          effort: this.o.effort
        });
        for (const w of warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
        try {
          await rpc.request("turn/start", {
            threadId: this.sessionThreadId ?? void 0,
            input: items,
            model: this.o.model,
            effort: this.o.effort,
            approvalPolicy: preset.approvalPolicy,
            sandboxPolicy: preset.sandboxPolicy
          });
        } catch (e) {
          this.emit({
            type: "turn_ended",
            turnId,
            status: "failed",
            error: String(e?.message ?? e)
          });
        }
      }
      async steer(input) {
        if (!this.rpc || !this.st.currentTurnId) throw new Error("\u5F53\u524D\u8F6E\u6B21\u8FD8\u6CA1\u5F00\u59CB\uFF0C\u65E0\u6CD5\u63D2\u8BDD");
        const { items, warnings } = await buildCodexInput(input.text, input.images ?? []);
        for (const w of warnings) this.emit({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
        try {
          await this.rpc.request("turn/steer", {
            threadId: this.threadId(),
            expectedTurnId: this.st.currentTurnId,
            input: items
          });
        } catch (e) {
          log("warn", "codex steer \u5931\u8D25", { err: String(e) });
        }
      }
      async interrupt() {
        for (const [, p] of this.pending) p.resolve({ cancelled: true });
        this.pending.clear();
        if (!this.rpc) return;
        if (!this.st.currentTurnId) {
          this.interruptWanted = true;
          return;
        }
        this.interruptWanted = false;
        try {
          await this.rpc.request(
            "turn/interrupt",
            { threadId: this.threadId(), turnId: this.st.currentTurnId },
            5e3
          );
        } catch (e) {
          const msg = String(e?.message ?? e);
          if (!/idle|not running|no.*turn/i.test(msg)) {
            log("warn", "codex interrupt \u5931\u8D25", { err: msg });
          }
        }
      }
      threadId() {
        return this.sessionThreadId ?? void 0;
      }
      // ---- server requests (§7.3.5 approvals) ----
      async onServerRequest(method, params) {
        switch (method) {
          case "item/commandExecution/requestApproval": {
            const command = String(params.command ?? "");
            const requestId = "perm_" + rid3();
            this.emit({
              type: "permission_request",
              requestId,
              title: `\u8FD0\u884C ${command.slice(0, 80)}`,
              kind: "tool",
              detail: { command, cwd: params.cwd, reason: params.reason, approvalId: params.approvalId, itemId: params.itemId },
              options: [
                { id: "accept", label: "\u5141\u8BB8", kind: "allow_once" },
                { id: "acceptForSession", label: "\u672C\u5BF9\u8BDD\u90FD\u5141\u8BB8", kind: "allow_always" },
                { id: "decline", label: "\u62D2\u7EDD", kind: "reject_once" }
              ]
            });
            const a = await this.waitFor(requestId);
            if (a.cancelled) return { decision: "cancel" };
            const opt = a.optionId === "acceptForSession" ? "acceptForSession" : a.optionId === "decline" ? "decline" : "accept";
            return { decision: opt };
          }
          case "item/fileChange/requestApproval": {
            const changes = Array.isArray(params.changes) ? params.changes : [];
            const requestId = "perm_" + rid3();
            this.emit({
              type: "permission_request",
              requestId,
              title: "\u4FEE\u6539\u6587\u4EF6",
              kind: "tool",
              detail: { changes, approvalId: params.approvalId, itemId: params.itemId, reason: params.reason },
              options: [
                { id: "accept", label: "\u5141\u8BB8", kind: "allow_once" },
                { id: "acceptForSession", label: "\u672C\u5BF9\u8BDD\u90FD\u5141\u8BB8", kind: "allow_always" },
                { id: "decline", label: "\u62D2\u7EDD", kind: "reject_once" }
              ]
            });
            const a = await this.waitFor(requestId);
            if (a.cancelled) return { decision: "cancel" };
            const opt = a.optionId === "acceptForSession" ? "acceptForSession" : a.optionId === "decline" ? "decline" : "accept";
            return { decision: opt };
          }
          case "item/tool/requestUserInput": {
            const requestId = "q_" + rid3();
            this.emit({
              type: "question",
              requestId,
              questions: params.questions ?? []
            });
            const a = await this.waitFor(requestId);
            if (a.cancelled) return { answers: {} };
            const raw = a.answers ?? {};
            const shaped = {};
            for (const [k, v] of Object.entries(raw)) shaped[k] = { answers: [v] };
            return { answers: shaped };
          }
          default:
            throw new Error(`\u672A\u8BC6\u522B\u7684\u670D\u52A1\u7AEF\u8BF7\u6C42 ${method}`);
        }
      }
      waitFor(requestId) {
        return new Promise((resolve2) => {
          this.pending.set(requestId, { kind: "permission", resolve: resolve2 });
        });
      }
      respond(requestId, answer) {
        const p = this.pending.get(requestId);
        if (p) {
          this.pending.delete(requestId);
          p.resolve(answer);
        }
      }
      async setModel(model) {
        this.o.model = model;
      }
      async setMode(mode) {
        this.o.mode = mode;
      }
      async setEffort(effort) {
        this.o.effort = effort;
      }
      async listCommands() {
        try {
          const entries = this.codexSlash ?? await loadCodexSlashEntries(this.o.cwd);
          this.codexSlash = entries;
          return codexSlashCommandsFromEntries(entries);
        } catch {
          return [];
        }
      }
      async close() {
        this.closed = true;
        for (const [, p] of this.pending) p.resolve({ cancelled: true });
        this.pending.clear();
        if (this.rpc) await this.rpc.close();
        this.q.close();
      }
    };
  }
});

// daemon/src/providers/codex/provider.ts
function runVersion2(r, args, timeoutMs = 5e3) {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    const p = spawnBin(r, args, { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => {
      try {
        void killTree(p, { graceMs: 500 });
      } catch {
      }
      reject(new Error("timeout"));
    }, timeoutMs);
    p.stdout?.on("data", (c) => out += c.toString());
    p.stderr?.on("data", (c) => out += c.toString());
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolvePromise(out);
      else reject(new Error("exit " + code));
    });
  });
}
function normalizeEfforts(raw) {
  const out = [];
  for (const e of raw ?? []) {
    const v = typeof e === "string" ? e : e?.reasoningEffort;
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}
async function fetchModels(r, cwd) {
  const rpc = new CodexRpc(argvFor(r, ["app-server"]), { cwd });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "agent-console", title: "Agent Console", version: "0" },
      capabilities: { experimentalApi: true }
    }, 15e3);
    rpc.notify("initialized", {});
    const res = await rpc.request("model/list", {}, 15e3);
    const rows = res.data ?? [];
    return rows.filter((m) => typeof m.id === "string" && m.id).map((m) => {
      const efforts = normalizeEfforts(m.supportedReasoningEfforts);
      const thinkingOptions = efforts.map((e) => ({ id: e, label: e }));
      const defaultThinking = (typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : null) ?? thinkingOptions[0]?.id ?? null;
      return {
        id: m.id,
        name: m.displayName ?? m.id,
        isDefault: m.isDefault,
        efforts,
        thinkingOptions,
        defaultThinking
      };
    });
  } finally {
    await rpc.close();
  }
}
function createCodexProvider(version) {
  return {
    id: "codex",
    name: "Codex",
    capabilities: codexCapabilities,
    async detect() {
      const bin = await resolveBin("codex");
      if (!bin.ok) {
        return { available: false, reason: bin.reason, installHint: INSTALL_HINT2 };
      }
      try {
        const v = await runVersion2(bin, ["--version"]);
        return { available: true, bin: bin.display, version: v.trim().split("\n")[0] || "" };
      } catch (e) {
        return { available: true, bin: bin.display, version: "", reason: String(e) };
      }
    },
    async listModels() {
      if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
      const bin = await resolveBin("codex");
      if (!bin.ok) return [{ id: "", name: "\u9ED8\u8BA4" }];
      try {
        const models2 = await fetchModels(bin, process.cwd());
        modelCache = { at: Date.now(), models: models2 };
        return models2;
      } catch (e) {
        log("warn", "codex model/list \u5931\u8D25", { err: String(e) });
        return [{ id: "", name: "\u9ED8\u8BA4" }];
      }
    },
    async createSession(o) {
      const bin = await resolveBin("codex");
      if (!bin.ok) throw new Error(`\u627E\u4E0D\u5230 codex\uFF1A${bin.reason}`);
      return new CodexSession({
        threadId: o.threadId,
        cwd: o.cwd,
        model: o.model,
        mode: o.mode,
        effort: o.effort,
        resumeId: o.resumeId,
        binCmd: bin.cmd,
        binPrefixArgs: bin.prefixArgs,
        binVia: bin.via,
        binShim: bin.shim,
        version
      });
    },
    // §7.6: ~/.codex/sessions/**/rollout-*.jsonl matched by cwd
    async listHistory(cwd) {
      const items = await listCodexHistory(cwd);
      return items.map((i) => ({ provider: "codex", ...i, imported: false }));
    },
    async readHistory(sessionId, cwd) {
      return await readCodexHistory(sessionId, cwd);
    }
  };
}
var INSTALL_HINT2, codexCapabilities, modelCache, MODEL_CACHE_MS;
var init_provider2 = __esm({
  "daemon/src/providers/codex/provider.ts"() {
    init_codex();
    init_bin();
    init_rpc();
    init_session2();
    init_log();
    INSTALL_HINT2 = "npm i -g @openai/codex";
    codexCapabilities = {
      resume: true,
      interrupt: true,
      steer: true,
      images: true,
      plan: true,
      questions: true,
      cost: false,
      // tokenUsage yes, cost no
      effort: [],
      // effort values depend on the model — filled from model/list after detect
      modes: ["plan", "default", "acceptEdits", "bypassPermissions"]
    };
    modelCache = null;
    MODEL_CACHE_MS = 10 * 60 * 1e3;
  }
});

// daemon/src/providers/catalog.ts
function catalogById(id) {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
function providerCreatable(status) {
  return status !== "planned";
}
var PROVIDER_CATALOG;
var init_catalog = __esm({
  "daemon/src/providers/catalog.ts"() {
    PROVIDER_CATALOG = [
      { id: "claude", name: "Claude Code", bins: ["claude"], installHint: "npm i -g @anthropic-ai/claude-code", status: "verified" },
      { id: "codex", name: "Codex", bins: ["codex"], installHint: "\u89C1 OpenAI Codex CLI \u5B89\u88C5\u8BF4\u660E", status: "verified" },
      { id: "cursor", name: "Cursor", bins: ["cursor-agent", "cursor"], installHint: "\u5B89\u88C5 Cursor \u5E76\u786E\u4FDD CLI \u5728 PATH", status: "verified" },
      { id: "copilot", name: "Copilot", bins: ["copilot"], installHint: "GitHub Copilot CLI \u5B89\u88C5\u8BF4\u660E", status: "verified" },
      { id: "opencode", name: "OpenCode", bins: ["opencode"], installHint: "npm i -g opencode / \u89C1 OpenCode \u6587\u6863", status: "verified" },
      { id: "pi", name: "Pi", bins: ["pi-acp", "pi", "pi-coding-agent"], installHint: "npm i -g pi-acp\uFF08\u6216 Pi coding agent + ACP \u9002\u914D\u5668\uFF09", status: "verified" },
      { id: "devin", name: "Devin CLI", bins: ["devin"], installHint: "Devin CLI \u5B98\u65B9\u5B89\u88C5", status: "verified" },
      { id: "dsh", name: "dsh", bins: ["dsh"], installHint: "npm i -g @deepseek-ai/dsh", status: "verified" }
    ];
  }
});

// daemon/src/providers/acp/spawn.ts
import { Readable, Writable } from "node:stream";
import { resolve as resolvePath } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
function spawnResolved(r, args, o = {}) {
  return spawnBin(r, args, {
    cwd: o.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    group: true
  });
}
function acpStreamFromChild(child) {
  if (!child.stdin || !child.stdout) throw new Error("ACP \u5B50\u8FDB\u7A0B\u7F3A\u5C11 stdio \u7BA1\u9053");
  const output = Writable.toWeb(child.stdin);
  const input = Readable.toWeb(child.stdout);
  return acp.ndJsonStream(output, input);
}
function absCwd(cwd) {
  return resolvePath(cwd);
}
async function killAcpChild(child) {
  await killTree(child);
}
var init_spawn = __esm({
  "daemon/src/providers/acp/spawn.ts"() {
    init_bin();
  }
});

// daemon/src/providers/acp/clientHandlers.ts
import { readFile as readFile8, writeFile as writeFile2 } from "node:fs/promises";
import { methods } from "@agentclientprotocol/sdk";
function registerAcpClientHandlers(app, bridge) {
  app.onRequest(methods.client.fs.readTextFile, async (ctx) => {
    const text = await readFile8(ctx.params.path, "utf8");
    return { content: text };
  });
  app.onRequest(methods.client.fs.writeTextFile, async (ctx) => {
    await writeFile2(ctx.params.path, ctx.params.content, "utf8");
    return {};
  });
  app.onRequest(methods.client.session.requestPermission, async (ctx) => {
    const tc = ctx.params.toolCall;
    const options = ctx.params.options.map((o) => ({
      id: o.optionId,
      label: o.name,
      kind: o.kind
    }));
    if (bridge.autoAcceptPermissions?.()) {
      const allow = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
      if (allow) return { outcome: { outcome: "selected", optionId: allow.id } };
    }
    const requestId = "p" + Math.random().toString(36).slice(2, 10);
    bridge.push({
      type: "permission_request",
      requestId,
      title: tc.title ?? tc.name ?? "\u9700\u8981\u6388\u6743",
      kind: tc.kind ?? "tool",
      detail: tc.rawInput ?? void 0,
      options
    });
    const answer = await bridge.waitFor(requestId);
    if (answer.cancelled) return { outcome: { outcome: "cancelled" } };
    const optionId = answer.optionId ?? options[0]?.id;
    if (!optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  });
}
var init_clientHandlers = __esm({
  "daemon/src/providers/acp/clientHandlers.ts"() {
  }
});

// daemon/src/providers/acp/mapUpdate.ts
function mapToolKind(k) {
  switch (k) {
    case "read":
    case "edit":
    case "search":
      return k;
    case "execute":
      return "bash";
    case "fetch":
      return "web";
    default:
      return "other";
  }
}
function mapToolStatus(s) {
  if (s === "completed") return "ok";
  if (s === "failed") return "failed";
  return "running";
}
function textFromContent(content) {
  if (content.type === "text") return content.text;
  return "";
}
function newMapCtx() {
  return { itemPrefix: "a" + rid4() + "_", messageIds: /* @__PURE__ */ new Map() };
}
function mapSessionUpdate(update, ctx) {
  const out = [];
  const mid = "messageId" in update && update.messageId ? String(update.messageId) : null;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      if (!text) break;
      const itemId = mid ? ctx.messageIds.get(mid) ?? ctx.itemPrefix + mid : ctx.itemPrefix + "msg";
      if (mid) ctx.messageIds.set(mid, itemId);
      out.push({ type: "assistant_delta", itemId, text });
      break;
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      if (!text) break;
      const itemId = mid ? ctx.itemPrefix + "t_" + mid : ctx.itemPrefix + "think";
      out.push({ type: "reasoning_delta", itemId, text });
      break;
    }
    case "tool_call":
      out.push({
        type: "tool_call",
        itemId: ctx.itemPrefix + update.toolCallId,
        kind: mapToolKind(update.kind),
        title: update.title,
        status: mapToolStatus(update.status),
        input: update.rawInput
      });
      break;
    case "tool_call_update":
      out.push({
        type: "tool_call",
        itemId: ctx.itemPrefix + update.toolCallId,
        kind: mapToolKind(update.kind),
        title: update.title ?? update.name ?? "tool",
        status: mapToolStatus(update.status),
        input: update.rawInput,
        output: typeof update.rawOutput === "string" ? update.rawOutput : void 0
      });
      break;
    case "plan":
      out.push({
        type: "plan",
        itemId: ctx.itemPrefix + "plan",
        markdown: update.entries.map((e) => `- ${e.content}`).join("\n"),
        entries: update.entries.map((e) => ({ step: e.content, status: e.status ?? "" }))
      });
      break;
    case "notice":
      out.push({
        type: "notice",
        level: update.severity === "error" ? "error" : update.severity === "warning" ? "warn" : "info",
        message: update.description ? `${update.title}: ${update.description}` : update.title
      });
      break;
    case "usage_update":
      out.push({
        type: "usage",
        inputTokens: update.used,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: typeof update.cost?.amount === "number" ? update.cost.amount : 0,
        contextWindow: update.size
      });
      break;
    default:
      break;
  }
  return out;
}
function stopToTurnEnd(stopReason, turnId, err) {
  if (stopReason === "cancelled") {
    return { type: "turn_ended", turnId, status: "interrupted" };
  }
  if (stopReason === "refusal" || stopReason === "max_tokens") {
    return { type: "turn_ended", turnId, status: "failed", error: err ?? stopReason };
  }
  return { type: "turn_ended", turnId, status: "completed" };
}
var rid4;
var init_mapUpdate = __esm({
  "daemon/src/providers/acp/mapUpdate.ts"() {
    rid4 = () => Math.random().toString(36).slice(2, 8);
  }
});

// daemon/src/providers/acp/promptCaps.ts
function promptCapsFromInitialize(res) {
  const pc = res?.agentCapabilities?.promptCapabilities;
  return {
    image: pc?.image === true,
    audio: pc?.audio === true,
    embeddedContext: pc?.embeddedContext === true
  };
}
function rememberPromptCaps(providerId, caps) {
  if (providerId) learned.set(providerId, caps);
}
function knownPromptCaps(providerId) {
  return learned.get(providerId);
}
var learned;
var init_promptCaps = __esm({
  "daemon/src/providers/acp/promptCaps.ts"() {
    learned = /* @__PURE__ */ new Map();
  }
});

// daemon/src/providers/acp/prompt.ts
import { readFile as readFile9, stat as stat7 } from "node:fs/promises";
import { basename as basename4 } from "node:path";
import { pathToFileURL } from "node:url";
async function buildAcpPrompt(text, attachments, caps) {
  const media = [];
  const links = [];
  const pathLines = [];
  const imagesByPath = [];
  const warnings = [];
  let inlineBytes = 0;
  const byPath = (file, mime, size, label) => {
    links.push({ type: "resource_link", uri: pathToFileURL(file).href, name: basename4(file), mimeType: mime, ...size !== null ? { size } : {} });
    pathLines.push(`${label}: ${file}`);
  };
  for (const a of attachments) {
    const mime = a.mime || "application/octet-stream";
    let file;
    let size = null;
    try {
      file = await resolveImagePath(a.path);
      size = (await stat7(file)).size;
    } catch (e) {
      warnings.push(`${a.path}: ${String(e?.message ?? e)}`);
      continue;
    }
    const image = attachmentKind(mime) === "image";
    const audio = mime.startsWith("audio/");
    if (image && caps.image || audio && caps.audio) {
      if (size > MAX_INLINE_MEDIA_BYTES || inlineBytes + size > MAX_INLINE_TOTAL_BYTES) {
        const limit = size > MAX_INLINE_MEDIA_BYTES ? MAX_INLINE_MEDIA_BYTES : MAX_INLINE_TOTAL_BYTES;
        warnings.push(`${basename4(file)}: ${(size / 1024 / 1024).toFixed(1)} MB, over the ${limit / 1024 / 1024} MB inline limit; sent as a file path`);
        byPath(file, mime, size, image ? "Attached image" : "Attached audio");
        if (image) imagesByPath.push(file);
        continue;
      }
      try {
        const data = (await readFile9(file)).toString("base64");
        media.push(image ? { type: "image", data, mimeType: mime } : { type: "audio", data, mimeType: mime });
        inlineBytes += size;
      } catch (e) {
        warnings.push(`${basename4(file)}: ${String(e?.message ?? e)}`);
        byPath(file, mime, size, image ? "Attached image" : "Attached audio");
        if (image) imagesByPath.push(file);
      }
      continue;
    }
    if (image || audio) {
      byPath(file, mime, size, image ? "Attached image" : "Attached audio");
      if (image) imagesByPath.push(file);
      continue;
    }
    if (isText(mime) && caps.embeddedContext && size <= MAX_EMBED_TEXT_BYTES && inlineBytes + size <= MAX_INLINE_TOTAL_BYTES) {
      try {
        const body = await readFile9(file, "utf8");
        media.push({ type: "resource", resource: { uri: pathToFileURL(file).href, mimeType: mime, text: body } });
        inlineBytes += size;
        continue;
      } catch {
      }
    }
    byPath(file, mime, size, "Attached file");
  }
  const fullText = [text, ...pathLines.length ? [pathLines.join("\n")] : []].filter(Boolean).join("\n\n");
  const blocks = [];
  if (fullText) blocks.push({ type: "text", text: fullText });
  blocks.push(...media, ...links);
  return { blocks, imagesByPath, warnings };
}
var MAX_INLINE_MEDIA_BYTES, MAX_INLINE_TOTAL_BYTES, MAX_EMBED_TEXT_BYTES, isText;
var init_prompt = __esm({
  "daemon/src/providers/acp/prompt.ts"() {
    init_attachmentRefs();
    init_attachmentKinds();
    MAX_INLINE_MEDIA_BYTES = 10 * 1024 * 1024;
    MAX_INLINE_TOTAL_BYTES = 16 * 1024 * 1024;
    MAX_EMBED_TEXT_BYTES = 1024 * 1024;
    isText = (mime) => attachmentKind(mime) === "text";
  }
});

// daemon/src/providers/acp/session.ts
import { client, methods as methods2, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
var AcpSession;
var init_session3 = __esm({
  "daemon/src/providers/acp/session.ts"() {
    init_slash();
    init_queue();
    init_bin();
    init_spawn();
    init_clientHandlers();
    init_mapUpdate();
    init_promptCaps();
    init_prompt();
    init_i18n();
    init_log();
    AcpSession = class {
      constructor(o) {
        this.o = o;
        this.events = this.q;
        this.startModel = o.model;
        this.cursorFast = o.cursorFast ?? false;
        this.cursorAutoReview = false;
        this.commandsReady = new Promise((r) => this.settleCommands = r);
        this.initPromise = this.boot();
      }
      o;
      events;
      q = new AsyncQueue();
      child = null;
      conn = null;
      ctx = null;
      active = null;
      initErr = null;
      initPromise;
      closed = false;
      turnId = null;
      turnNum = 0;
      running = false;
      permPending = /* @__PURE__ */ new Map();
      mapCtx = newMapCtx();
      modelConfigId = null;
      thoughtConfigId = null;
      cursorFast = false;
      cursorAutoReview = false;
      slashCommands = [];
      activeTurnId = null;
      configOptions = null;
      // initialize → agentCapabilities.promptCapabilities (ACP baseline until initialize answers: text + resource_link)
      promptCaps = { image: false, audio: false, embeddedContext: false };
      initCaps = this.promptCaps;
      startModel = null;
      wakePump = null;
      // listCommands waits for the first batch of commands (or confirmation there are none), following Paseo's waitForInitialCommands
      commandsReady;
      settleCommands;
      async boot() {
        const bin = this.o.launch ? {
          ok: true,
          cmd: this.o.launch.cmd,
          prefixArgs: this.o.launch.prefixArgs,
          display: this.o.launch.cmd,
          via: "custom",
          binName: "custom"
        } : await resolveFirstBin(this.o.binCandidates?.length ? this.o.binCandidates : [this.o.binName]);
        if (!bin.ok) throw new Error(bin.reason);
        try {
          this.child = spawnResolved(bin, this.o.acpArgs, { cwd: this.o.cwd });
          this.child.stderr?.on("data", (d) => {
            const t = d.toString().trim();
            if (t) log("info", `[${this.o.binName} acp] ${t.slice(0, 500)}`);
          });
          this.child.on("error", (e) => this.failInit(e));
          this.child.on("close", (code) => {
            if (!this.closed && code !== 0) {
              this.q.push({ type: "notice", level: "error", message: `${this.o.binName} \u8FDB\u7A0B\u9000\u51FA (${code})` });
            }
          });
          const app = client({ name: "magpie-agent-console" });
          registerAcpClientHandlers(app, {
            push: (ev) => this.q.push(ev),
            waitFor: (id) => this.waitPerm(id),
            autoAcceptPermissions: () => this.cursorAutoReview
          });
          const stream = acpStreamFromChild(this.child);
          this.conn = app.connect(stream);
          this.ctx = this.conn.agent;
          const initRes = await this.ctx.request(methods2.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            // Cursor: declare support for the parameterized model picker (as Paseo does); only then does it expose levels / Fast as separate config options
            clientCapabilities: this.o.flavor === "cursor" ? { _meta: { parameterizedModelPicker: true } } : {},
            clientInfo: { name: "Agent Console", version: this.o.appVersion }
          });
          this.promptCaps = promptCapsFromInitialize(initRes);
          this.initCaps = this.promptCaps;
          rememberPromptCaps(this.o.providerId, this.promptCaps);
          const cwd = absCwd(this.o.cwd);
          const ctx = this.ctx;
          if (!ctx) throw new Error("ACP \u672A\u8FDE\u63A5");
          if (this.o.resumeId) {
            const loaded = await ctx.request(methods2.agent.session.load, {
              sessionId: this.o.resumeId,
              cwd,
              mcpServers: []
            });
            this.active = ctx.attachSession({
              sessionId: this.o.resumeId,
              modes: loaded.modes
            });
          } else {
            this.active = await ctx.buildSession(cwd).start();
          }
          this.syncModelConfigId();
          this.syncThoughtConfigId();
          await this.applySessionMode(this.o.mode);
          await this.applySessionModel(this.o.model);
          await this.applyCursorAutoReviewConfig(this.cursorAutoReview);
          this.q.push({ type: "provider_session_id", id: this.active.sessionId });
          const init = this.active.newSessionResponse?.availableCommands;
          if (init?.length) this.applyAvailableCommands(init);
          void this.pumpUpdates();
        } catch (e) {
          this.failInit(e);
          throw e;
        }
      }
      failInit(e) {
        this.initErr = e instanceof Error ? e : new Error(String(e));
      }
      applyAvailableCommands(raw) {
        this.slashCommands = sortSlashCommands(mapAcpAvailableCommands(raw));
        this.q.push({ type: "slash_commands", commands: this.slashCommands });
        this.settleCommands();
      }
      async ready() {
        await this.initPromise.catch(() => {
        });
        if (this.initErr) throw this.initErr;
        if (!this.active) throw new Error("ACP \u4F1A\u8BDD\u672A\u5C31\u7EEA");
      }
      /** The config options currently in effect: each set_config_option response returns the latest set (levels change after switching models); otherwise use session/new's */
      currentConfig() {
        return this.configOptions ?? this.active?.newSessionResponse.configOptions ?? [];
      }
      syncModelConfigId() {
        for (const o of this.currentConfig()) {
          if (o.type === "select" && (o.category === "model" || o.id === "model")) {
            this.modelConfigId = o.id;
            return;
          }
        }
        if (this.o.flavor === "cursor") this.modelConfigId = "model";
      }
      // Level options belong to the current model: recompute on every refresh (cleared when switching to a model without levels)
      syncThoughtConfigId() {
        this.thoughtConfigId = null;
        const opts = this.currentConfig().filter((o) => o.type === "select");
        const hit = opts.find((o) => o.category === "thought_level") ?? opts.find((o) => /thought|thinking|effort|reasoning/i.test(o.id ?? ""));
        if (hit) this.thoughtConfigId = hit.id;
      }
      /** set_config_option, then refresh local state from the latest config options it returns */
      async setOption(configId, value) {
        if (!this.ctx || !this.active) return false;
        try {
          const res = await this.ctx.request(methods2.agent.session.setConfigOption, {
            sessionId: this.active.sessionId,
            configId,
            value
          });
          if (Array.isArray(res?.configOptions)) {
            this.configOptions = res.configOptions;
            this.syncThoughtConfigId();
          }
          return true;
        } catch (e) {
          log("info", `ACP set_config_option(${configId}=${value}): ${String(e)}`);
          return false;
        }
      }
      async applySessionThought(effort) {
        if (!effort || !this.thoughtConfigId) return;
        const opt = this.currentConfig().find((o) => o.id === this.thoughtConfigId);
        const values = (opt?.options ?? []).flatMap((x) => x.options ? x.options : [x]).map((x) => x.value);
        if (values.length && !values.includes(effort)) return;
        await this.setOption(this.thoughtConfigId, effort);
      }
      /** Mode choices the Agent reports: prefer a category=mode select in configOptions, otherwise ACP modes.availableModes */
      modeChoices() {
        const opt = this.currentConfig().find(
          (o) => o.type === "select" && (o.category === "mode" || o.id === "mode")
        );
        if (opt?.options?.length) {
          return opt.options.filter((x) => typeof x.value === "string").map((x) => ({ id: x.value, name: x.name ?? x.value, configId: opt.id }));
        }
        return (this.active?.modes?.availableModes ?? []).map((m) => ({ id: m.id, name: m.name, configId: null }));
      }
      resolveAcpModeId(mode) {
        if (this.o.modeMap) {
          const want = this.o.modeMap[mode];
          if (!want) return null;
          const hit = this.modeChoices().find(
            (m) => m.id === want || m.id.endsWith(`#${want}`) || m.name.toLowerCase() === want
          );
          return hit?.id ?? want;
        }
        if (this.o.flavor === "cursor") {
          const map = { default: "agent", plan: "plan", ask: "ask" };
          const want = map[mode] ?? "agent";
          const avail = this.active?.modes?.availableModes ?? [];
          const hit = avail.find((m) => m.id === want || m.name.toLowerCase() === want);
          return hit?.id ?? want;
        }
        return mode === "plan" ? "plan" : "default";
      }
      async applySessionMode(mode) {
        if (!this.ctx || !this.active) return;
        const hasAllowAll = this.currentConfig().some((o) => o.id === "allow_all");
        if (this.o.modeMap?.[mode] === "allow-all") {
          const agentId = this.modeChoices().find((m) => m.id === "agent" || m.id.endsWith("#agent"));
          if (agentId?.configId) await this.setOption(agentId.configId, agentId.id);
          if (hasAllowAll) await this.setOption("allow_all", "on");
          return;
        }
        if (hasAllowAll && this.o.modeMap) await this.setOption("allow_all", "off");
        const modeId = this.resolveAcpModeId(mode);
        if (!modeId) return;
        try {
          const viaConfig = this.modeChoices().find((m) => m.id === modeId)?.configId;
          if (viaConfig) {
            await this.setOption(viaConfig, modeId);
            return;
          }
          await this.ctx.request(methods2.agent.session.setMode, {
            sessionId: this.active.sessionId,
            modeId
          });
        } catch (e) {
          log("info", `ACP setMode(${mode}): ${String(e)}`);
        }
      }
      /**
       * Switch model → refresh level options from the new config options it returns → then apply the level (as Paseo does).
       * Cursor connects with parameterizedModelPicker: only the base model name is sent (grok-4.6); level / Fast are separate config options.
       */
      async applySessionModel(model) {
        if (!this.ctx || !this.active) return;
        const value = model && this.o.flavor === "cursor" ? model.replace(/\[.*\]$/u, "") : model;
        if (value) {
          const modelOption = this.currentConfig().find((o) => o.id === (this.modelConfigId ?? "model"));
          const values = (modelOption?.options ?? []).flatMap((x) => x.options ? x.options : [x]).map((x) => x.value).filter((x) => typeof x === "string");
          if (!values.length || values.includes(value)) {
            await this.setOption(this.modelConfigId ?? "model", value);
          } else {
            log("info", `\u5FFD\u7565 ${this.o.binName} \u7684\u65E0\u6548\u6A21\u578B\uFF1A${value}`);
          }
        }
        if (this.o.flavor === "cursor" && this.cursorFast && this.currentConfig().some((o) => o.id === "fast")) {
          await this.setOption("fast", "true");
        }
        await this.applySessionThought(this.o.effort);
      }
      async applyCursorAutoReviewConfig(on) {
        if (this.o.flavor !== "cursor" || !this.ctx || !this.active) return;
        for (const configId of ["auto_review", "autoReview", "smart_auto"]) {
          try {
            await this.ctx.request(methods2.agent.session.setConfigOption, {
              sessionId: this.active.sessionId,
              configId,
              type: "boolean",
              value: on
            });
            return;
          } catch {
          }
        }
      }
      /** Cursor only: Fast / Auto-review (can be changed while the session is open) */
      async updateCursorOpts(fast, autoReview) {
        this.cursorFast = fast;
        void autoReview;
        await this.ready();
        await this.applySessionModel(this.o.model);
        await this.applyCursorAutoReviewConfig(false);
      }
      waitPerm(requestId) {
        return new Promise((resolve2) => {
          this.permPending.set(requestId, resolve2);
        });
      }
      respond(requestId, answer) {
        const r = this.permPending.get(requestId);
        if (r) {
          this.permPending.delete(requestId);
          r(answer);
          this.q.push({
            type: "permission_resolved",
            requestId,
            optionId: answer.optionId,
            cancelled: answer.cancelled
          });
        }
      }
      async send(input) {
        await this.ready();
        if (this.running) throw new Error("\u5F53\u524D\u8F6E\u6B21\u5C1A\u672A\u7ED3\u675F");
        this.turnNum++;
        this.turnId = "u_" + Date.now().toString(36) + "_" + this.turnNum;
        this.mapCtx = newMapCtx();
        this.running = true;
        this.q.push({
          type: "turn_started",
          turnId: this.turnId,
          model: this.o.model,
          mode: this.o.mode,
          effort: this.o.effort
        });
        const text = input.text.trim();
        const attachments = input.images ?? [];
        if (!text && !attachments.length) {
          this.running = false;
          this.q.push({ type: "turn_ended", turnId: this.turnId, status: "completed" });
          return;
        }
        const built = await buildAcpPrompt(text, attachments, this.promptCaps);
        const agent = this.o.providerName ?? this.o.binName;
        if (built.imagesByPath.length && !this.promptCaps.image) {
          const switched = this.o.imagesFollowStartModel && this.initCaps.image && this.o.model !== this.startModel;
          this.q.push({ type: "notice", level: "warn", message: tr(switched ? "notice.acpImageByPathSwitched" : "notice.acpImageByPath", { agent, paths: built.imagesByPath.join(", ") }) });
        }
        for (const w of built.warnings) this.q.push({ type: "notice", level: "warn", message: tr("notice.attachmentIssue", { detail: w }) });
        if (!built.blocks.length) {
          this.running = false;
          this.q.push({ type: "turn_ended", turnId: this.turnId, status: "completed" });
          return;
        }
        void this.runTurn(built.blocks);
      }
      // Send this turn's prompt; reading updates is the job of the persistent pumpUpdates() (following Paseo: session/update is handled at session level)
      async runTurn(prompt) {
        this.activeTurnId = this.turnId;
        this.wakePump?.();
        this.wakePump = null;
        this.active.prompt(prompt).catch(() => {
        });
      }
      endTurn(ev) {
        this.q.push(ev);
        this.activeTurnId = null;
        this.running = false;
      }
      /**
       * Read session/update for the whole lifetime of the session.
       * It used to read only during a turn: the available_commands_update an Agent pushes after session/new and before the first message went unread,
       * so the slash menu stayed empty. Now command updates are cached at any time; conversation content becomes timeline events only while a turn is in progress.
       */
      async pumpUpdates() {
        const session = this.active;
        if (!session) return;
        while (!this.closed) {
          let msg;
          try {
            msg = await session.nextUpdate();
          } catch (e) {
            if (this.closed) return;
            const turnId = this.activeTurnId;
            if (turnId) {
              this.endTurn({ type: "turn_ended", turnId, status: "failed", error: String(e?.message ?? e) });
            }
            await new Promise((r) => this.wakePump = r);
            continue;
          }
          if (msg.kind === "session_update") {
            const u = msg.update;
            if (u.sessionUpdate === "available_commands_update") {
              this.applyAvailableCommands(u.availableCommands ?? []);
              continue;
            }
            if (!this.activeTurnId) continue;
            for (const ev of mapSessionUpdate(u, this.mapCtx)) this.q.push(ev);
          } else if (this.activeTurnId) {
            this.endTurn(stopToTurnEnd(msg.stopReason, this.activeTurnId));
          }
        }
      }
      async interrupt() {
        await this.ready();
        if (!this.ctx || !this.active) return;
        try {
          await this.ctx.request(methods2.agent.session.cancel, { sessionId: this.active.sessionId });
        } catch (e) {
          log("info", `ACP cancel: ${String(e)}`);
        }
      }
      async setModel(model) {
        this.o.model = model;
        await this.ready();
        if (this.o.imagesFollowStartModel) {
          this.promptCaps = model === this.startModel ? this.initCaps : { ...this.initCaps, image: false };
        }
        await this.applySessionModel(model);
      }
      async setMode(mode) {
        this.o.mode = mode;
        await this.ready();
        await this.applySessionMode(mode);
      }
      async setEffort(effort) {
        this.o.effort = effort;
        await this.ready();
        await this.applySessionThought(effort);
      }
      async listCommands() {
        try {
          await this.ready();
        } catch {
          return [];
        }
        if (!this.slashCommands.length) {
          await Promise.race([this.commandsReady, new Promise((r) => setTimeout(r, 1e4))]);
        }
        return this.slashCommands;
      }
      async close() {
        this.closed = true;
        this.wakePump?.();
        this.settleCommands();
        for (const r of this.permPending.values()) r({ cancelled: true });
        this.permPending.clear();
        try {
          this.active?.dispose();
        } catch {
        }
        try {
          this.conn?.close();
        } catch {
        }
        await killAcpChild(this.child);
        this.child = null;
        this.q.close();
      }
    };
  }
});

// daemon/src/providers/acp/provider.ts
function runVersion3(r, args, timeoutMs = 8e3) {
  return new Promise((resolvePromise, reject) => {
    let out = "";
    const p = spawnBin(r, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    const t = setTimeout(() => {
      try {
        void killTree(p, { graceMs: 500 });
      } catch {
      }
      reject(new Error("timeout"));
    }, timeoutMs);
    p.stdout?.on("data", (c) => out += c.toString());
    p.stderr?.on("data", (c) => out += c.toString());
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0 || out.trim()) resolvePromise(out.trim());
      else reject(new Error("exit " + code));
    });
  });
}
async function resolveProviderBin(cfg2) {
  const names = cfg2.binCandidates?.length ? cfg2.binCandidates : [cfg2.binName];
  return resolveFirstBin(names);
}
function createAcpProvider(cfg2) {
  const base = cfg2.capabilities ?? acpCapabilities;
  const ORDER = ["plan", "default", "acceptEdits", "bypassPermissions"];
  const caps = cfg2.modeMap ? { ...base, modes: ORDER.filter((m) => cfg2.modeMap[m] !== void 0), modeLabels: cfg2.modeLabels } : base;
  return {
    id: cfg2.id,
    name: cfg2.name,
    // images is what the Agent's own initialize says (probe at warm-up / providers.list, or any session); until then unknown
    get capabilities() {
      const learned2 = knownPromptCaps(cfg2.id);
      return learned2 ? { ...caps, images: learned2.image, imagesKnown: true } : { ...caps, images: false, imagesKnown: false };
    },
    async detect() {
      const r = await resolveProviderBin(cfg2);
      if (!r.ok) {
        return { available: false, reason: r.reason, installHint: cfg2.installHint };
      }
      let version;
      try {
        if (cfg2.id === "cursor") {
          version = (await runVersion3(r, ["--version"])).split(/\r?\n/)[0]?.trim();
        } else if (cfg2.id === "devin") {
          version = (await runVersion3(r, ["version"])).split(/\r?\n/)[0]?.trim();
        } else if (cfg2.id === "opencode") {
          version = (await runVersion3(r, ["--version"])).split(/\r?\n/)[0]?.trim();
        }
      } catch {
      }
      return { available: true, bin: r.display, version };
    },
    async listModels() {
      const r = await resolveProviderBin(cfg2);
      if (!r.ok) return [{ id: "default", name: "\u9ED8\u8BA4", isDefault: true }];
      if (cfg2.fetchModels) return cfg2.fetchModels(r);
      return [{ id: "default", name: "\u9ED8\u8BA4", isDefault: true }];
    },
    async createSession(o) {
      return new AcpSession({
        threadId: o.threadId,
        providerId: cfg2.id,
        providerName: cfg2.name,
        cwd: o.cwd,
        model: o.model,
        mode: o.mode,
        effort: o.effort,
        resumeId: o.resumeId,
        binName: cfg2.binName,
        binCandidates: cfg2.binCandidates ?? [cfg2.binName],
        acpArgs: cfg2.argsFor ? await cfg2.argsFor(o.model) : cfg2.acpArgs,
        imagesFollowStartModel: cfg2.imagesFollowStartModel,
        appVersion: cfg2.appVersion ?? "0.0.1",
        flavor: cfg2.flavor ?? "generic",
        modeMap: cfg2.modeMap,
        cursorFast: o.cursorFast,
        cursorAutoReview: o.cursorAutoReview,
        launch: o.launch
      });
    }
  };
}
var acpCapabilities, cursorAcpCapabilities;
var init_provider3 = __esm({
  "daemon/src/providers/acp/provider.ts"() {
    init_bin();
    init_bin();
    init_session3();
    init_promptCaps();
    acpCapabilities = {
      resume: true,
      interrupt: true,
      steer: false,
      images: false,
      plan: true,
      questions: false,
      cost: false,
      effort: [],
      modes: ["plan", "default", "acceptEdits", "bypassPermissions"]
    };
    cursorAcpCapabilities = {
      ...acpCapabilities,
      questions: true,
      modes: ["default", "plan", "ask"]
    };
  }
});

// daemon/src/providers/acp/dsh.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdir as mkdir2, writeFile as writeFile3 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join9 } from "node:path";
function dshRoute(model) {
  if (!model) return null;
  try {
    const v = JSON.parse(model);
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && v[0] && v[1]) {
      return { provider: v[0], model: v[1] };
    }
  } catch {
  }
  return null;
}
function dshRoutePatch(route) {
  return [
    "# Agent Console: the route dsh's ACP starts on, so initialize advertises image input for it",
    "- id: acp",
    "  config:",
    `    provider: ${JSON.stringify(route.provider)}`,
    `    model: ${JSON.stringify(route.model)}`,
    ""
  ].join("\n");
}
async function dshAcpArgs(model, dir = join9(tmpdir(), "agent-console-dsh")) {
  const route = dshRoute(model);
  if (!route) return [...DSH_ACP_ARGS];
  const body = dshRoutePatch(route);
  const file = join9(dir, `acp-route-${createHash2("sha256").update(body).digest("hex").slice(0, 16)}.yml`);
  await mkdir2(dir, { recursive: true });
  await writeFile3(file, body, { mode: 384 });
  return [...DSH_ACP_ARGS, "--patch", file];
}
function dshDefaultModel(models2, current) {
  return models2.find((m) => /magpie/i.test(m.id))?.id ?? current ?? models2[0]?.id ?? null;
}
var DSH_ACP_ARGS;
var init_dsh = __esm({
  "daemon/src/providers/acp/dsh.ts"() {
    DSH_ACP_ARGS = ["--profile", "acp"];
  }
});

// daemon/src/providers/acp/probe.ts
import { tmpdir as tmpdir2 } from "node:os";
function flatten(opts) {
  const out = [];
  for (const o of opts ?? []) {
    if (o.options) out.push(...flatten(o.options));
    else if (typeof o.value === "string" && o.value) {
      out.push({ id: o.value, name: typeof o.name === "string" && o.name ? o.name : o.value });
    }
  }
  return out.filter((m, i) => out.findIndex((x) => x.id === m.id) === i);
}
function parseAcpSession(res) {
  const opts = res.configOptions ?? [];
  const modelOpt = opts.find((o) => o.type === "select" && (o.category === "model" || o.id === "model"));
  const thoughtOpt = opts.find((o) => o.type === "select" && (o.category === "thought_level" || o.id === "thought_level"));
  let models2 = flatten(modelOpt?.options);
  let currentModel = typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : null;
  if (!models2.length && res.models?.availableModels?.length) {
    models2 = res.models.availableModels.filter((m) => typeof m.modelId === "string" && m.modelId).map((m) => ({ id: m.modelId, name: m.name || m.modelId }));
    models2 = models2.filter((m, i) => models2.findIndex((x) => x.id === m.id) === i);
    currentModel = res.models.currentModelId ?? currentModel;
  }
  const thinking = flatten(thoughtOpt?.options).map((t) => ({ id: t.id, label: t.name }));
  const currentThinking = typeof thoughtOpt?.currentValue === "string" ? thoughtOpt.currentValue : null;
  return { models: models2, currentModel, thinking, currentThinking };
}
function probeAcp(r, acpArgs, timeoutMs = 3e4, providerId) {
  return probeAcpRaw(r, acpArgs, timeoutMs).then((x) => {
    rememberPromptCaps(providerId, x.promptCaps);
    return x.parsed;
  });
}
function probeAcpRaw(r, acpArgs, timeoutMs = 3e4, extMethod) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnResolved(r, acpArgs, { cwd: tmpdir2() });
    let buf = "";
    let nextId = 0;
    const pending = /* @__PURE__ */ new Map();
    let done = false;
    const finish = (err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void killAcpChild(child).catch(() => {
      });
      if (err) reject(err);
      else resolvePromise(v);
    };
    const timer = setTimeout(() => finish(new Error("ACP \u63A2\u6D4B\u8D85\u65F6")), timeoutMs);
    const send2 = (method, params) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    child.on("error", (e) => finish(e));
    child.on("close", () => finish(new Error("ACP \u8FDB\u7A0B\u63D0\u524D\u9000\u51FA")));
    child.stderr?.on("data", () => {
    });
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id !== void 0 && !m.method && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) p.rej(new Error(JSON.stringify(m.error)));
          else p.res(m.result);
        } else if (m.id !== void 0 && m.method) {
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }) + "\n");
        }
      }
    });
    void (async () => {
      try {
        const init = await send2("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "Agent Console", version: "probe" } });
        const res = await send2("session/new", { cwd: tmpdir2(), mcpServers: [] });
        let ext = null;
        if (extMethod) ext = await send2(extMethod, {}).catch(() => null);
        finish(null, { parsed: parseAcpSession(res ?? {}), ext, promptCaps: promptCapsFromInitialize(init) });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}
function probeToModels(p) {
  return p.models.map((m) => ({
    id: m.id,
    name: m.name,
    isDefault: m.id === p.currentModel,
    ...p.thinking.length ? { thinkingOptions: p.thinking, defaultThinking: p.currentThinking ?? void 0 } : {}
  }));
}
function cursorCatalogToModels(catalog, currentModel) {
  const currentBase = currentModel?.replace(/\[.*\]$/u, "") ?? null;
  const out = [];
  for (const m of catalog.models ?? []) {
    if (typeof m.value !== "string" || !m.value) continue;
    const id = m.value.replace(/\[.*\]$/u, "");
    const thought = (m.configOptions ?? []).find((o) => o.category === "thought_level");
    const levels = flatten(thought?.options);
    out.push({
      id,
      name: typeof m.name === "string" && m.name ? m.name : id,
      isDefault: id === currentBase,
      ...thought && levels.length ? {
        thinkingOptions: levels.map((l) => ({ id: l.id, label: EFFORT_LABEL[l.id] ?? l.name })),
        defaultThinking: typeof thought.currentValue === "string" ? thought.currentValue : void 0,
        thinkingParam: thought.id
      } : {}
    });
  }
  return out;
}
function cursorProbeModels(acpArgs, providerId) {
  return async (r) => {
    try {
      const { parsed, ext, promptCaps } = await probeAcpRaw(r, acpArgs, 4e4, "cursor/list_available_models");
      rememberPromptCaps(providerId, promptCaps);
      const fromCatalog = ext ? cursorCatalogToModels(ext, parsed.currentModel) : [];
      return fromCatalog.length ? fromCatalog : probeToModels(parsed);
    } catch (e) {
      log("warn", "Cursor \u6A21\u578B\u63A2\u6D4B\u5931\u8D25", { err: String(e) });
      return [];
    }
  };
}
function dshProbeModels(providerId) {
  return async (r) => {
    try {
      const first = await probeAcpRaw(r, DSH_ACP_ARGS, 3e4);
      let caps = first.promptCaps;
      const start = dshDefaultModel(first.parsed.models, first.parsed.currentModel);
      if (start && start !== first.parsed.currentModel && dshRoute(start)) {
        caps = await probeAcpRaw(r, await dshAcpArgs(start), 3e4).then((x) => x.promptCaps, () => caps);
      }
      rememberPromptCaps(providerId, caps);
      return probeToModels(first.parsed);
    } catch (e) {
      log("warn", "ACP \u63A2\u6D4B\u6A21\u578B\u5931\u8D25", { err: String(e) });
      return [];
    }
  };
}
function acpProbeModels(acpArgs, providerId) {
  return async (r) => {
    try {
      return probeToModels(await probeAcp(r, acpArgs, 3e4, providerId));
    } catch (e) {
      log("warn", "ACP \u63A2\u6D4B\u6A21\u578B\u5931\u8D25", { err: String(e) });
      return [];
    }
  };
}
var EFFORT_LABEL;
var init_probe = __esm({
  "daemon/src/providers/acp/probe.ts"() {
    init_spawn();
    init_log();
    init_promptCaps();
    init_dsh();
    EFFORT_LABEL = {
      none: "None",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
      max: "Max"
    };
  }
});

// daemon/src/providers/acp/specs.ts
function acpConfigForEntry(entry, appVersion) {
  if (!ACP_IDS.has(entry.id)) return null;
  const base = {
    id: entry.id,
    name: entry.name,
    binName: entry.bins[0] ?? entry.id,
    binCandidates: entry.bins,
    installHint: entry.installHint,
    appVersion
  };
  switch (entry.id) {
    case "cursor":
      return {
        ...base,
        acpArgs: ["acp"],
        flavor: "cursor",
        capabilities: cursorAcpCapabilities,
        // Each model's own thinking levels come from cursor/list_available_models (as Paseo does)
        fetchModels: cursorProbeModels(["acp"], entry.id)
      };
    case "devin":
      return {
        ...base,
        acpArgs: ["acp"],
        fetchModels: acpProbeModels(["acp"], entry.id),
        modeMap: { plan: "plan", default: "ask", acceptEdits: "accept-edits", bypassPermissions: "bypass" },
        modeLabels: { plan: "Plan", default: "Ask", acceptEdits: "Code", bypassPermissions: "Bypass Permissions" }
      };
    case "opencode":
      return {
        ...base,
        acpArgs: ["acp"],
        fetchModels: acpProbeModels(["acp"], entry.id),
        modeMap: { plan: "plan", default: "build" },
        modeLabels: { plan: "Plan", default: "Build" }
      };
    case "copilot":
      return {
        ...base,
        acpArgs: ["--acp"],
        fetchModels: acpProbeModels(["--acp"], entry.id),
        modeMap: { plan: "plan", default: "agent", bypassPermissions: "allow-all" },
        modeLabels: { plan: "Plan", default: "Agent", bypassPermissions: "Allow All" }
      };
    case "pi":
      return { ...base, acpArgs: [], fetchModels: acpProbeModels([], entry.id), modeMap: { default: "" } };
    case "dsh":
      return {
        ...base,
        acpArgs: DSH_ACP_ARGS,
        argsFor: (model) => dshAcpArgs(model),
        imagesFollowStartModel: true,
        fetchModels: dshProbeModels(entry.id)
      };
    default:
      return null;
  }
}
var ACP_IDS;
var init_specs = __esm({
  "daemon/src/providers/acp/specs.ts"() {
    init_provider3();
    init_probe();
    init_dsh();
    ACP_IDS = /* @__PURE__ */ new Set(["cursor", "devin", "opencode", "dsh", "pi", "copilot"]);
  }
});

// daemon/src/providers/registry.ts
function registerProvider(p) {
  providers.set(p.id, p);
}
function getProvider(id) {
  return providers.get(id);
}
function listProviders() {
  return [...providers.values()];
}
function initProviders(version = "") {
  providers.clear();
  for (const entry of PROVIDER_CATALOG) {
    if (entry.id === "claude") registerProvider(createClaudeProvider());
    else if (entry.id === "codex") registerProvider(createCodexProvider(version));
    else {
      const acp2 = acpConfigForEntry(entry, version);
      if (acp2) registerProvider(createAcpProvider(acp2));
    }
  }
  if (process.env.AGENT_CONSOLE_MOCK === "1") {
    registerProvider(createMockProvider());
  }
}
var providers;
var init_registry = __esm({
  "daemon/src/providers/registry.ts"() {
    init_mock();
    init_provider();
    init_provider2();
    init_catalog();
    init_provider3();
    init_specs();
    providers = /* @__PURE__ */ new Map();
  }
});

// daemon/src/providers/enabled.ts
function isProviderEnabled(settings, id) {
  const m = settings.providerEnabled;
  if (m && typeof m === "object" && typeof m[id] === "boolean") return m[id];
  const entry = catalogById(id);
  if (!entry) return true;
  return entry.status === "verified";
}
var init_enabled = __esm({
  "daemon/src/providers/enabled.ts"() {
    init_catalog();
  }
});

// daemon/src/util/pickFolderWin.ts
import { execFile } from "node:child_process";
function decodePickFolderStdout(stdout) {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8");
  const line = buf.toString("utf8").trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (!line) return null;
  if (/^[A-Za-z0-9+/]+=*$/.test(line)) {
    const decoded = Buffer.from(line, "base64").toString("utf8");
    if (decoded && !decoded.includes("\uFFFD")) return decoded;
  }
  if (!line.includes("\uFFFD")) return line;
  const gbkLine = new TextDecoder("gbk").decode(buf).trim().split(/\r?\n/).pop()?.trim() ?? "";
  return gbkLine || null;
}
function pickFolderWindows(initial) {
  return new Promise((resolvePromise) => {
    if (process.platform !== "win32") return resolvePromise({ available: false, path: null });
    const init = (initial ?? "").replace(/'/g, "''");
    const script = "Add-Type -AssemblyName System.Windows.Forms;$d = New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description = '\u9009\u62E9\u9879\u76EE\u6587\u4EF6\u5939';$d.ShowNewFolderButton = $true;" + (init ? `$d.SelectedPath = '${init}';` : "") + "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath)) }";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-Command", script],
      { timeout: 12e4, windowsHide: false, encoding: "buffer" },
      (e, stdout) => {
        if (e) return resolvePromise({ available: true, path: null });
        resolvePromise({ available: true, path: decodePickFolderStdout(stdout ?? Buffer.alloc(0)) });
      }
    );
  });
}
var init_pickFolderWin = __esm({
  "daemon/src/util/pickFolderWin.ts"() {
  }
});

// daemon/src/util/pickFolder.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync7, statSync as statSync3 } from "node:fs";
function appleScriptString(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
function isDir(p) {
  try {
    return !!p && existsSync7(p) && statSync3(p).isDirectory();
  } catch {
    return false;
  }
}
function pickFolderCommand(platform, initial, find = (n) => findOnPath(n)[0] ?? null, env = process.env) {
  const init = isDir(initial) ? initial : void 0;
  if (platform === "darwin") {
    const prompt = appleScriptString("\u9009\u62E9\u9879\u76EE\u6587\u4EF6\u5939 / Choose a project folder");
    const loc = init ? ` default location (POSIX file ${appleScriptString(init)})` : "";
    return { cmd: "/usr/bin/osascript", args: ["-e", `POSIX path of (choose folder with prompt ${prompt}${loc})`] };
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    const zenity = find("zenity");
    if (zenity) {
      const args = ["--file-selection", "--directory", "--title=\u9009\u62E9\u9879\u76EE\u6587\u4EF6\u5939 / Choose a project folder"];
      if (init) args.push(`--filename=${init.endsWith("/") ? init : init + "/"}`);
      return { cmd: zenity, args };
    }
    const kdialog = find("kdialog");
    if (kdialog) return { cmd: kdialog, args: ["--getexistingdirectory", init ?? env.HOME ?? "/"] };
  }
  return null;
}
function pickFolder(initial) {
  if (process.platform === "win32") return pickFolderWindows(initial);
  const c = pickFolderCommand(process.platform, initial);
  if (!c) return Promise.resolve({ available: false, path: null });
  return new Promise((resolvePromise) => {
    execFile2(c.cmd, c.args, { timeout: TIMEOUT, encoding: "utf8" }, (e, stdout) => {
      if (e) return resolvePromise({ available: true, path: null });
      let p = String(stdout ?? "").replace(/\r?\n$/, "").trim();
      if (p.length > 1) p = p.replace(/\/+$/, "");
      resolvePromise({ available: true, path: p || null });
    }).on("error", () => resolvePromise({ available: false, path: null }));
  });
}
var TIMEOUT;
var init_pickFolder = __esm({
  "daemon/src/util/pickFolder.ts"() {
    init_pathscan();
    init_pickFolderWin();
    TIMEOUT = 10 * 60 * 1e3;
  }
});

// daemon/src/providers/magpieGateway.ts
import { readFile as readFile10 } from "node:fs/promises";
import { homedir as homedir6 } from "node:os";
import { join as join10 } from "node:path";
async function readJson(path3) {
  try {
    return JSON.parse(await readFile10(path3, "utf8"));
  } catch {
    return null;
  }
}
async function readApplied() {
  return await readJson(join10(homedir6(), ".config", "magpie", "applied.json")) ?? {};
}
async function readClaudeEnv() {
  const s = await readJson(join10(homedir6(), ".claude", "settings.json"));
  return s?.env ?? {};
}
async function gatewayBase() {
  const env = await readClaudeEnv();
  const raw = env.ANTHROPIC_BASE_URL?.trim();
  return (raw && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(raw) ? raw : "http://127.0.0.1:3425").replace(/\/+$/, "");
}
async function fetchGatewayModelIds() {
  const base = await gatewayBase();
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5e3) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.data ?? []).map((m) => m.id).filter((id) => typeof id === "string" && !!id);
  } catch (e) {
    log("warn", "\u8BFB\u53D6 magpie \u7F51\u5173\u6A21\u578B\u5217\u8868\u5931\u8D25", { err: String(e) });
    return [];
  }
}
function parseCapabilities(raw) {
  const out = /* @__PURE__ */ new Map();
  for (const part of (raw ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const flags = new Set(part.slice(i + 1).split(",").map((s) => s.trim()));
    if (!flags.has("effort")) continue;
    const levels = ["low", "medium", "high"];
    if (flags.has("xhigh_effort")) levels.push("xhigh");
    if (flags.has("max_effort")) levels.push("max");
    out.set(part.slice(0, i).trim(), levels);
  }
  return out;
}
function isPlaceholder(m) {
  return !m.id || /^(default|auto)$/i.test(m.id);
}
async function withMagpie(providerId, own) {
  const tool = MAGPIE_TOOLS[providerId];
  if (!tool) return own;
  const applied = (await readApplied())[tool.key]?.fields;
  if (!applied?.model) return own;
  const caps = parseCapabilities((await readClaudeEnv()).CLAUDE_CODE_MODEL_CAPABILITIES);
  const real = own.filter((m) => !isPlaceholder(m));
  if (providerId === "dsh") {
    const appliedId = applied.model.replace(/^magpie\//, "");
    const selected = real.find(
      (m) => m.id === applied.model || m.id === appliedId || appliedId.includes("/") && m.id.includes(appliedId)
    );
    const fallback = selected ?? real.find((m) => m.isDefault) ?? real[0];
    return real.map((m) => ({ ...m, isDefault: m.id === fallback?.id }));
  }
  const knowsMagpie = tool.prefix ? real.some((m) => m.id.startsWith(tool.prefix)) : real.length > 0;
  let list;
  if (knowsMagpie) {
    const mine = real.filter((m) => !tool.prefix || m.id.startsWith(tool.prefix));
    const others = tool.prefix ? real.filter((m) => !m.id.startsWith(tool.prefix)) : [];
    list = [...mine, ...others];
  } else {
    list = (await fetchGatewayModelIds()).map((gid) => ({ id: tool.prefix + gid, name: gid }));
  }
  const defId = applied.model;
  if (!list.some((m) => m.id === defId)) list.unshift({ id: defId, name: defId.slice(tool.prefix.length) || defId });
  list = list.map((m) => ({ ...m, isDefault: m.id === defId }));
  list.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
  return list.map((m) => {
    const name = tool.prefix && m.name.startsWith(tool.prefix) ? m.name.slice(tool.prefix.length) : m.name;
    if (m.thinkingOptions?.length && providerId !== "claude") return { ...m, name };
    const levels = caps.get(m.id.slice(tool.prefix.length) || m.id);
    if (!levels) return { ...m, name, thinkingOptions: providerId === "claude" ? [] : m.thinkingOptions };
    const def = applied.effort && levels.includes(applied.effort) ? applied.effort : levels.includes("high") ? "high" : levels[0];
    return {
      ...m,
      name,
      thinkingOptions: levels.map((id) => ({ id, label: EFFORT_LABEL2[id] ?? id })),
      defaultThinking: m.isDefault ? def : m.defaultThinking ?? def
    };
  });
}
var MAGPIE_TOOLS, EFFORT_LABEL2;
var init_magpieGateway = __esm({
  "daemon/src/providers/magpieGateway.ts"() {
    init_log();
    MAGPIE_TOOLS = {
      claude: { key: "claude", prefix: "" },
      codex: { key: "codex", prefix: "" },
      opencode: { key: "opencode", prefix: "magpie/" },
      pi: { key: "pi", prefix: "magpie/" },
      dsh: { key: "dsh", prefix: "magpie/" }
    };
    EFFORT_LABEL2 = {
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
      max: "Max"
    };
  }
});

// daemon/src/providers/infoCache.ts
function withTimeout(p, ms, fb) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
}
function fresh(e, ttl) {
  return !!e && Date.now() - e.at < ttl;
}
async function cachedDetect(p) {
  const hit = detects.get(p.id);
  if (fresh(hit, DETECT_MS)) return hit.value;
  let job = inflightDetect.get(p.id);
  if (!job) {
    job = withTimeout(
      p.detect().catch((e) => ({ available: false, reason: String(e?.message ?? e) })),
      STEP_TIMEOUT_MS,
      { available: false, reason: "\u68C0\u6D4B\u8D85\u65F6" }
    ).then((v) => {
      if (v.reason !== "\u68C0\u6D4B\u8D85\u65F6") detects.set(p.id, { at: Date.now(), value: v });
      return v;
    }).finally(() => inflightDetect.delete(p.id));
    inflightDetect.set(p.id, job);
  }
  return job;
}
async function cachedModels(p) {
  const hit = models.get(p.id);
  if (fresh(hit, MODELS_MS)) return hit.value;
  let job = inflightModels.get(p.id);
  if (!job) {
    job = withTimeout(p.listModels().catch(() => []), MODELS_TIMEOUT_MS, null).then(async (v) => {
      if (v === null) return models.get(p.id)?.value ?? [];
      const list = await withMagpie(p.id, dropPlaceholder(v)).catch(() => dropPlaceholder(v));
      models.set(p.id, { at: Date.now(), value: list });
      return list;
    }).finally(() => inflightModels.delete(p.id));
    inflightModels.set(p.id, job);
  }
  return job;
}
function dropPlaceholder(list) {
  if (list.length === 1 && list[0].id === "default" && list[0].name === "\u9ED8\u8BA4") return [];
  return list;
}
function clearProviderCache(id) {
  if (id) {
    detects.delete(id);
    models.delete(id);
  } else {
    detects.clear();
    models.clear();
  }
}
var DETECT_MS, MODELS_MS, STEP_TIMEOUT_MS, MODELS_TIMEOUT_MS, detects, models, inflightDetect, inflightModels;
var init_infoCache = __esm({
  "daemon/src/providers/infoCache.ts"() {
    init_magpieGateway();
    DETECT_MS = 60 * 1e3;
    MODELS_MS = 10 * 60 * 1e3;
    STEP_TIMEOUT_MS = 15e3;
    MODELS_TIMEOUT_MS = 35e3;
    detects = /* @__PURE__ */ new Map();
    models = /* @__PURE__ */ new Map();
    inflightDetect = /* @__PURE__ */ new Map();
    inflightModels = /* @__PURE__ */ new Map();
  }
});

// daemon/src/ws/methods.ts
import { z } from "zod";
import { existsSync as existsSync8, statSync as statSync4 } from "node:fs";
import { mkdir as mkdir3, writeFile as writeFile4 } from "node:fs/promises";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname3, join as join11, win32 as win32Path } from "node:path";
import { execFile as execFile3 } from "node:child_process";
function wrap(schema, fn) {
  return (params, ctx) => {
    const r = schema.safeParse(params ?? {});
    if (!r.success) {
      throw new ApiError("bad_params", "\u53C2\u6570\u4E0D\u5BF9\uFF1A" + r.error.issues.map((i) => i.message).join("\uFF1B"));
    }
    return fn(r.data, ctx);
  };
}
function registerMethods(gw, svc) {
  const zEmpty = z.object({}).passthrough().optional();
  gw.method("app.info", wrap(zEmpty, () => ({
    version: svc.cfg.version,
    dataDir: svc.cfg.dataDir,
    pid: process.pid,
    port: svc.cfg.port
  })));
  gw.method("app.shutdown", wrap(zEmpty, () => {
    setTimeout(() => process.exit(0), 100);
    return { ok: true };
  }));
  gw.method("settings.get", wrap(zEmpty, () => svc.settings.get()));
  gw.method("settings.set", wrap(
    z.object({ patch: z.record(z.string(), z.unknown()) }),
    (p) => svc.settings.set(p.patch)
  ));
  gw.method("sub.add", wrap(
    z.object({ ch: z.string().min(1).max(120), afterSeq: z.number().int().nonnegative().optional() }),
    async (p, ctx) => {
      svc.gateway.subscribe(ctx.conn, p.ch);
      const m = /^thread:(.+)$/.exec(p.ch);
      if (m && p.afterSeq != null) {
        const events = await svc.threads.readEvents(m[1], p.afterSeq, 5e3).catch(() => []);
        for (const ev of events) ctx.conn.send({ t: "evt", ch: p.ch, d: { type: "event", event: ev } });
      }
      return { ok: true };
    }
  ));
  gw.method("sub.remove", wrap(z.object({ ch: z.string().min(1).max(120) }), (p, ctx) => {
    svc.gateway.unsubscribe(ctx.conn, p.ch);
    return { ok: true };
  }));
  gw.method("providers.list", wrap(
    z.object({ refresh: z.boolean().optional() }).passthrough().optional(),
    async (p) => {
      if (p?.refresh) {
        clearBinCache();
        clearProviderCache();
      }
      const settings = await svc.settings.get();
      const rows = await Promise.all(
        listProviders().map(async (p2) => {
          const entry = catalogById(p2.id);
          const enabled = isProviderEnabled(settings, p2.id);
          const skip = !enabled || entry?.status === "planned";
          const det = skip ? { available: false, reason: !enabled ? "\u5DF2\u5728\u8BBE\u7F6E\u4E2D\u7981\u7528" : "\u5C1A\u672A\u63A5\u5165" } : await cachedDetect(p2);
          const models2 = !skip && det.available ? await cachedModels(p2) : [];
          return {
            id: p2.id,
            name: p2.name,
            available: det.available,
            enabled,
            status: entry?.status ?? "verified",
            ready: entry?.status === "verified",
            bin: det.bin,
            version: det.version,
            reason: !enabled ? "\u5DF2\u5728\u8BBE\u7F6E\u4E2D\u7981\u7528" : det.reason,
            installHint: det.installHint,
            capabilities: p2.capabilities,
            models: models2
          };
        })
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = PROVIDER_CATALOG.map((e) => byId.get(e.id)).filter(Boolean);
      for (const r of rows) {
        if (!PROVIDER_CATALOG.some((e) => e.id === r.id)) ordered.push(r);
      }
      return ordered;
    }
  ));
  gw.method("projects.list", wrap(zEmpty, () => svc.projects.list()));
  gw.method("projects.create", wrap(
    z.object({ path: z.string().min(1), name: z.string().optional() }),
    async (p) => {
      const proj = await svc.projects.create(p.path, p.name);
      const s = await svc.settings.get();
      const dirs = (s.recentDirs ?? []).filter((d) => d.toLowerCase() !== p.path.toLowerCase());
      await svc.settings.set({ recentDirs: [p.path, ...dirs].slice(0, 12) });
      gw.publish("sidebar", { type: "project.upsert", project: proj });
      return proj;
    }
  ));
  gw.method("projects.rename", wrap(z.object({ id: z.string(), name: z.string() }), async (p) => {
    const proj = await svc.projects.rename(p.id, p.name);
    gw.publish("sidebar", { type: "project.upsert", project: proj });
    return proj;
  }));
  gw.method("projects.remove", wrap(z.object({ id: z.string() }), async (p) => {
    const proj = await svc.projects.get(p.id);
    if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
    for (const t of await svc.threads.list()) {
      if (t.projectId === p.id) {
        await svc.threads.delete(t.id);
        gw.publish("sidebar", { type: "thread.remove", id: t.id });
      }
    }
    await svc.projects.remove(p.id);
    gw.publish("sidebar", { type: "project.remove", id: p.id });
    return { ok: true };
  }));
  gw.method("projects.open", wrap(z.object({ id: z.string() }), async (p) => {
    const proj = await svc.projects.get(p.id);
    if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
    if (!existsSync8(proj.path)) throw new ApiError("bad_path", "\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u6587\u4EF6\u5939");
    const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const target = process.platform === "win32" ? win32Path.normalize(proj.path) : proj.path;
    execFile3(cmd, [target], { windowsHide: true }, () => {
    }).on("error", () => {
    });
    return { ok: true };
  }));
  gw.method("fs.check", wrap(z.object({ path: z.string().min(1) }), (p) => {
    let exists = false;
    let isDir2 = false;
    try {
      exists = existsSync8(p.path);
      isDir2 = exists && statSync4(p.path).isDirectory();
    } catch {
    }
    return { exists, isDir: isDir2 };
  }));
  gw.method("fs.recentDirs", wrap(zEmpty, async () => {
    const s = await svc.settings.get();
    return (s.recentDirs ?? []).slice(0, 12);
  }));
  gw.method("fs.pickFolder", wrap(
    z.object({ initial: z.string().optional() }).passthrough().optional(),
    (p) => pickFolder(p?.initial)
  ));
  gw.method("threads.list", wrap(zEmpty, () => svc.threads.list()));
  gw.method("threads.create", wrap(
    z.object({
      projectId: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().nullable().optional(),
      mode: threadModeSchema.optional(),
      effort: z.string().nullable().optional(),
      title: z.string().optional(),
      providerSessionId: z.string().nullable().optional(),
      importedFrom: z.object({ provider: z.string(), sessionId: z.string() }).optional()
    }),
    async (p) => {
      const proj = await svc.projects.get(p.projectId);
      if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
      if (!existsSync8(proj.path)) throw new ApiError("bad_path", "\u9879\u76EE\u76EE\u5F55\u5DF2\u4E0D\u5B58\u5728");
      if (!p.providerSessionId && !isProviderEnabled(await svc.settings.get(), p.provider)) {
        throw new ApiError("bad_params", "\u8BE5 Agent \u5DF2\u5728\u8BBE\u7F6E\u4E2D\u7981\u7528");
      }
      const cat = catalogById(p.provider);
      if (!p.providerSessionId && cat && !providerCreatable(cat.status)) {
        throw new ApiError("bad_params", `${cat.name} \u5C1A\u672A\u63A5\u5165\uFF0C\u6682\u4E0D\u80FD\u65B0\u5EFA\u5BF9\u8BDD`);
      }
      const meta = await svc.threads.create(p);
      gw.publish("sidebar", { type: "thread.upsert", thread: meta });
      return meta;
    }
  ));
  gw.method("threads.get", wrap(
    z.object({ id: z.string(), afterSeq: z.number().int().nonnegative().optional() }),
    async (p) => {
      const meta = await svc.threads.get(p.id);
      if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
      const events = await svc.threads.readEvents(p.id, p.afterSeq ?? 0, 5e3);
      const rt = svc.runtime?.(p.id) ?? null;
      return {
        meta,
        events,
        queue: rt?.queue ?? [],
        pending: rt?.pending ?? [],
        runtimeStatus: rt?.status ?? meta.status
      };
    }
  ));
  gw.method("threads.update", wrap(
    z.object({
      id: z.string(),
      title: z.string().optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional()
    }),
    async (p) => {
      const meta = await svc.threads.get(p.id);
      if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
      const patch = {};
      if (p.title !== void 0) {
        patch.title = p.title.trim() || meta.title;
        patch.titleAuto = false;
      }
      if (p.pinned !== void 0) patch.pinned = p.pinned;
      if (p.archived !== void 0) patch.archived = p.archived;
      const next = await svc.threads.patch(p.id, patch);
      gw.publish("sidebar", { type: "thread.upsert", thread: next });
      return next;
    }
  ));
  gw.method("threads.delete", wrap(z.object({ id: z.string() }), async (p) => {
    const meta = await svc.threads.get(p.id);
    if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
    if (svc.manager) await svc.manager.deleteThread(p.id);
    else await svc.threads.delete(p.id);
    gw.publish("sidebar", { type: "thread.remove", id: p.id });
    return { ok: true };
  }));
  const projectPath = async (projectId) => {
    const proj = await svc.projects.get(projectId);
    if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
    if (!existsSync8(proj.path)) throw new ApiError("bad_path", "\u9879\u76EE\u76EE\u5F55\u5DF2\u4E0D\u5B58\u5728");
    return proj.path;
  };
  gw.method("git.status", wrap(
    z.object({ projectId: z.string() }),
    async (p) => svc.git.status(await projectPath(p.projectId))
  ));
  gw.method("git.diff", wrap(
    z.object({ projectId: z.string(), path: z.string() }),
    async (p) => svc.git.diff(await projectPath(p.projectId), p.path)
  ));
  gw.method("git.discard", wrap(
    z.object({ projectId: z.string(), path: z.string() }),
    async (p) => svc.git.discard(await projectPath(p.projectId), p.path, svc.cfg.dataDir)
  ));
  gw.method("files.tree", wrap(
    z.object({ projectId: z.string(), dir: z.string().default(".") }),
    async (p) => svc.files.tree(await projectPath(p.projectId), p.dir)
  ));
  gw.method("files.read", wrap(
    z.object({ projectId: z.string(), path: z.string() }),
    async (p) => svc.files.read(await projectPath(p.projectId), p.path)
  ));
  gw.method("history.list", wrap(z.object({ projectId: z.string() }), async (p) => {
    const proj = await svc.projects.get(p.projectId);
    if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
    const imported = new Set(
      (await svc.threads.list()).filter((t) => t.projectId === p.projectId && t.providerSessionId).map((t) => t.providerSessionId)
    );
    const out = [];
    for (const provider of listProviders()) {
      if (!provider.listHistory) continue;
      const items = await provider.listHistory(proj.path).catch(() => []);
      for (const i of items) out.push({ ...i, imported: imported.has(i.sessionId) });
    }
    return out;
  }));
  gw.method("history.import", wrap(
    z.object({
      projectId: z.string(),
      items: z.array(z.object({ provider: z.string(), sessionId: z.string(), title: z.string().optional() })).min(1).max(20)
    }),
    async (p) => {
      const proj = await svc.projects.get(p.projectId);
      if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
      const metas = [];
      for (const item of p.items) {
        const provider = getProvider(item.provider);
        if (!provider?.readHistory) continue;
        const existing = (await svc.threads.list()).find(
          (t) => t.projectId === p.projectId && t.provider === item.provider && t.providerSessionId === item.sessionId
        );
        if (existing) {
          metas.push(existing);
          continue;
        }
        const meta = await svc.threads.create({
          projectId: p.projectId,
          provider: item.provider,
          title: item.title,
          providerSessionId: item.sessionId,
          importedFrom: { provider: item.provider, sessionId: item.sessionId }
        });
        const events = await provider.readHistory(item.sessionId, proj.path).catch(() => []);
        for (const ev of events) {
          await svc.threads.appendEvent(meta.id, ev);
        }
        await svc.threads.patch(meta.id, { status: "closed" });
        gw.publish("sidebar", { type: "thread.upsert", thread: await svc.threads.get(meta.id) });
        metas.push(await svc.threads.get(meta.id));
      }
      return metas;
    }
  ));
  gw.method("terminal.list", wrap(
    z.object({ projectId: z.string().optional() }).passthrough().optional(),
    (p) => svc.terminals.list(p?.projectId)
  ));
  gw.method("terminal.create", wrap(
    z.object({ projectId: z.string(), cols: z.number().int().min(20).max(500).default(80), rows: z.number().int().min(5).max(200).default(24) }),
    async (p) => {
      const path3 = await projectPath(p.projectId);
      const r = await svc.terminals.create(p.projectId, path3, p.cols, p.rows);
      if ("error" in r) throw new ApiError("bad_params", r.error);
      return r;
    }
  ));
  gw.method("terminal.attach", wrap(z.object({ id: z.string() }), async (p, ctx) => {
    const r = svc.terminals.attach(p.id);
    if (r.error || r.index == null) throw new ApiError("not_found", r.error ?? "\u7EC8\u7AEF\u4E0D\u5B58\u5728");
    svc.gateway.subscribe(ctx.conn, `terminal:${r.index}`);
    return r;
  }));
  gw.method("terminal.resize", wrap(
    z.object({ id: z.string(), cols: z.number().int(), rows: z.number().int() }),
    (p) => svc.terminals.resize(p.id, p.cols, p.rows)
  ));
  gw.method("terminal.kill", wrap(z.object({ id: z.string() }), (p) => svc.terminals.kill(p.id)));
  const needManager = () => {
    if (!svc.manager) throw new ApiError("unavailable", "\u4F1A\u8BDD\u7BA1\u7406\u5668\u672A\u542F\u52A8");
    return svc.manager;
  };
  gw.method("thread.send", wrap(
    z.object({
      id: z.string(),
      text: z.string(),
      attachments: z.array(z.object({ path: z.string(), mime: z.string(), name: z.string().optional() })).optional(),
      behavior: z.enum(["queue", "steer"]).optional()
    }),
    async (p) => {
      await needManager().send(p.id, { text: p.text, attachments: p.attachments }, p.behavior ?? "queue");
      return { ok: true };
    }
  ));
  gw.method("thread.interrupt", wrap(z.object({ id: z.string() }), async (p) => {
    await needManager().interrupt(p.id);
    return { ok: true };
  }));
  gw.method("thread.respond", wrap(
    z.object({
      id: z.string(),
      requestId: z.string(),
      optionId: z.string().optional(),
      answers: z.record(z.string(), z.string()).optional(),
      cancelled: z.boolean().optional()
    }),
    async (p) => {
      await needManager().respond(p.id, p.requestId, { optionId: p.optionId, answers: p.answers, cancelled: p.cancelled });
      return { ok: true };
    }
  ));
  gw.method("thread.setModel", wrap(z.object({ id: z.string(), model: z.string().nullable() }), async (p) => {
    await needManager().setModel(p.id, p.model);
    return { ok: true };
  }));
  gw.method("thread.setMode", wrap(z.object({ id: z.string(), mode: threadModeSchema }), async (p) => {
    await needManager().setMode(p.id, p.mode);
    return { ok: true };
  }));
  gw.method("thread.setEffort", wrap(z.object({ id: z.string(), effort: z.string().nullable() }), async (p) => {
    await needManager().setEffort(p.id, p.effort);
    return { ok: true };
  }));
  gw.method("thread.commands", wrap(z.object({ id: z.string(), load: z.boolean().optional() }), async (p) => {
    const commands = await needManager().listCommands(p.id, { load: p.load });
    return { commands };
  }));
  gw.method("thread.setCursorOpts", wrap(
    z.object({
      id: z.string(),
      cursorFast: z.boolean().optional(),
      cursorAutoReview: z.boolean().optional()
    }),
    async (p) => {
      await needManager().setCursorOpts(p.id, {
        cursorFast: p.cursorFast,
        cursorAutoReview: p.cursorAutoReview
      });
      return { ok: true };
    }
  ));
  gw.method("thread.setProvider", wrap(z.object({ id: z.string(), provider: z.string().min(1) }), async (p) => {
    await needManager().setProvider(p.id, p.provider);
    return { ok: true };
  }));
  gw.method("thread.close", wrap(z.object({ id: z.string() }), async (p) => {
    await needManager().close(p.id);
    return { ok: true };
  }));
  gw.method("thread.exportMarkdown", wrap(z.object({ id: z.string() }), async (p) => {
    const meta = await svc.threads.get(p.id);
    if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
    const events = await svc.threads.readEvents(p.id, 0, 2e4);
    const L = [];
    L.push(`# ${meta.title}`, "");
    L.push(`> ${meta.provider} \xB7 ${meta.model ?? "\u9ED8\u8BA4"} \xB7 ${meta.mode} \xB7 ${new Date(meta.createdAt).toLocaleString("zh-CN")}`, "");
    for (const e of events) {
      switch (e.type) {
        case "user_message":
          L.push(`**\u6211**${e.steered ? "\uFF08\u63D2\u8BDD\uFF09" : ""}\uFF1A

${e.text}`, "");
          break;
        case "assistant_message":
          L.push(e.text, "");
          break;
        case "reasoning":
          L.push(`<details><summary>\u601D\u8003</summary>

${e.text}
</details>`, "");
          break;
        case "tool_call": {
          const icon = e.status === "ok" ? "\u2713" : e.status === "failed" ? "\u2717" : "\u2026";
          L.push(`- \`${e.kind}\` ${icon} ${e.title}${e.output ? `
  \`\`\`
  ${e.output.slice(0, 2e3)}
  \`\`\`` : ""}`);
          break;
        }
        case "plan":
          L.push("### \u8BA1\u5212\n\n" + e.markdown, "");
          break;
        case "todo":
          L.push("### \u5F85\u529E\n\n" + e.items.map((i) => `- [${i.status === "done" || i.status === "completed" ? "x" : " "}] ${i.text}`).join("\n"), "");
          break;
        case "notice":
          L.push(`_${e.message}_`, "");
          break;
        case "turn_ended":
          L.push(`\u2014 ${e.status}${e.durationMs ? ` \xB7 ${Math.round(e.durationMs / 1e3)}s` : ""}${e.error ? ` \xB7 ${e.error}` : ""} \u2014`, "");
          break;
        default:
          break;
      }
    }
    const markdown = L.join("\n");
    const safe = meta.title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "thread";
    const filename = `${safe}.md`;
    const dir = join11(homedir7(), "Downloads");
    await mkdir3(dir, { recursive: true });
    let dest = join11(dir, filename);
    if (existsSync8(dest)) {
      const stamp2 = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      dest = join11(dir, `${safe}-${stamp2}.md`);
    }
    await writeFile4(dest, markdown, "utf8");
    revealInFileManager(dest);
    return { markdown, filename, path: dest };
  }));
}
function revealInFileManager(filePath) {
  if (process.platform === "win32") {
    execFile3("explorer.exe", ["/select," + win32Path.normalize(filePath)], { windowsHide: true }, () => {
    }).on("error", () => {
    });
    return;
  }
  if (process.platform === "darwin") {
    execFile3("open", ["-R", filePath], () => {
    }).on("error", () => {
    });
    return;
  }
  execFile3("xdg-open", [dirname3(filePath)], () => {
  }).on("error", () => {
  });
}
var threadModeSchema, ApiError;
var init_methods = __esm({
  "daemon/src/ws/methods.ts"() {
    init_registry();
    init_catalog();
    init_enabled();
    init_pickFolder();
    init_bin();
    init_infoCache();
    threadModeSchema = z.enum(["plan", "default", "acceptEdits", "bypassPermissions", "ask"]);
    ApiError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
  }
});

// daemon/src/util/atomic.ts
import { writeFile as writeFile5, rename, mkdir as mkdir4 } from "node:fs/promises";
import { dirname as dirname4 } from "node:path";
async function writeJsonAtomic(file, obj) {
  try {
    await mkdir4(dirname4(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile5(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, file);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("io_error", `\u5199\u5165\u6570\u636E\u5931\u8D25\uFF08${file}\uFF09\uFF1A${e?.message ?? e}`);
  }
}
var init_atomic = __esm({
  "daemon/src/util/atomic.ts"() {
    init_methods();
  }
});

// daemon/src/util/jsonl.ts
import { appendFile, readFile as readFile13, mkdir as mkdir5, rename as rename2, writeFile as writeFile6 } from "node:fs/promises";
import { dirname as dirname5 } from "node:path";
async function readJsonl(file) {
  let text = "";
  try {
    text = await readFile13(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
    }
  }
  return out;
}
function appendJsonl(file, obj) {
  const prev = writers.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      await mkdir5(dirname5(file), { recursive: true });
      await appendFile(file, JSON.stringify(obj) + "\n", "utf8");
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("io_error", `\u5199\u5165\u6570\u636E\u5931\u8D25\uFF08${file}\uFF09\uFF1A${e?.message ?? e}`);
    }
  });
  writers.set(
    file,
    next.catch(() => {
    })
  );
  return next;
}
var writers;
var init_jsonl = __esm({
  "daemon/src/util/jsonl.ts"() {
    init_methods();
    writers = /* @__PURE__ */ new Map();
  }
});

// daemon/src/migrate/legacy.ts
var legacy_exports = {};
__export(legacy_exports, {
  migrateLegacy: () => migrateLegacy
});
import { cp as cp2, mkdir as mkdir8, readdir as readdir6, readFile as readFile17 } from "node:fs/promises";
import { existsSync as existsSync12 } from "node:fs";
import { join as join18 } from "node:path";
function stamp() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
async function migrateLegacy(dataDir, stores) {
  const settings = await stores.settings.get();
  if (settings.v1Migrated) return { migrated: 0, skipped: true };
  const oldDir = join18(dataDir, "sessions");
  const oldSettingsPath = join18(dataDir, "settings.json");
  if (!existsSync12(oldDir) && !existsSync12(oldSettingsPath)) {
    await stores.settings.set({ v1Migrated: true });
    return { migrated: 0, skipped: true };
  }
  const backup = join18(dataDir, "trash", `legacy-${stamp()}`);
  await mkdir8(backup, { recursive: true });
  if (existsSync12(oldDir)) await cp2(oldDir, join18(backup, "sessions"), { recursive: true }).catch(() => {
  });
  if (existsSync12(oldSettingsPath)) await cp2(oldSettingsPath, join18(backup, "settings.json")).catch(() => {
  });
  const oldSettings = existsSync12(oldSettingsPath) ? JSON.parse(await readFile17(oldSettingsPath, "utf8").catch(() => "{}")) : {};
  const projectIdByPath = /* @__PURE__ */ new Map();
  const lc = (p) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  for (const p of oldSettings.projects ?? []) {
    if (!p?.path) continue;
    try {
      const proj = await stores.projects.create(p.path, p.name);
      projectIdByPath.set(lc(proj.path), proj.id);
    } catch (e) {
      log("warn", "\u8FC1\u79FB\uFF1A\u5EFA\u9879\u76EE\u5931\u8D25", { path: p.path, err: String(e) });
    }
  }
  let sessionIds = [];
  try {
    sessionIds = (await readdir6(oldDir)).filter((d) => validId(d) && existsSync12(join18(oldDir, d, "meta.json")));
  } catch {
  }
  const metas = [];
  for (const id of sessionIds) {
    try {
      const m = JSON.parse(await readFile17(join18(oldDir, id, "meta.json"), "utf8"));
      if (m?.cwd) metas.push(m);
    } catch {
    }
  }
  const extraDirs = [];
  const projPaths = [...projectIdByPath.keys()];
  for (const m of metas) {
    const covered = projPaths.some((pp) => belongsTo(m.cwd, pp)) || extraDirs.some((d) => belongsTo(m.cwd, d));
    if (covered) continue;
    for (let i = extraDirs.length - 1; i >= 0; i--) if (belongsTo(extraDirs[i], m.cwd)) extraDirs.splice(i, 1);
    extraDirs.push(m.cwd);
  }
  for (const d of extraDirs) {
    if (!existsSync12(d)) continue;
    try {
      const name = d.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? d;
      const proj = await stores.projects.create(d, name);
      projectIdByPath.set(lc(proj.path), proj.id);
      projPaths.push(lc(proj.path));
    } catch (e) {
      log("warn", "\u8FC1\u79FB\uFF1A\u8865\u5EFA\u5B64\u513F\u9879\u76EE\u5931\u8D25", { path: d, err: String(e) });
    }
  }
  const projectOf = (cwd) => {
    const l = lc(cwd);
    let best = null;
    for (const [pp, id] of projectIdByPath) {
      if (belongsTo(l, pp) && (best == null || pp.length > best.length)) best = pp;
    }
    return best ? projectIdByPath.get(best) : null;
  };
  let migrated = 0;
  const threadsDir = join18(dataDir, "threads");
  for (const m of metas) {
    try {
      const projectId = projectOf(m.cwd);
      if (!projectId) {
        log("warn", "\u8FC1\u79FB\uFF1A\u65E0\u9879\u76EE\u53EF\u5F52\uFF0C\u8DF3\u8FC7", { id: m.id, cwd: m.cwd });
        continue;
      }
      const testTitle = SKIP_TITLE.test(m.title ?? "") || m.title === "\u9ED8\u8BA4\u5267\u672C\u6F14\u793A";
      const provider = m.agent === "claude" || m.agent === "codex" ? m.agent : "mock";
      const archived = testTitle || m.agent !== "claude" && m.agent !== "codex";
      const now = Date.now();
      const meta = {
        id: `t_${m.id.replace(/^s?_?/, "")}`.slice(0, 80),
        projectId,
        title: m.title || "\u65E7\u5BF9\u8BDD",
        titleAuto: false,
        provider,
        model: m.model || null,
        mode: MODE_MAP[m.permission] ?? "default",
        effort: null,
        providerSessionId: m.cliSessionId || null,
        status: "closed",
        pinned: !!m.pinned,
        archived,
        createdAt: m.created || now,
        updatedAt: m.updated || now,
        lastTurnStatus: m.lastStatus === "ok" ? "completed" : m.lastStatus === "error" ? "failed" : null,
        usage: {
          inputTokens: m.totalUsage?.inputTokens ?? 0,
          outputTokens: m.totalUsage?.outputTokens ?? 0,
          cacheReadTokens: m.totalUsage?.cacheReadTokens ?? 0,
          costUsd: m.totalCost ?? 0
        },
        importedFrom: m.cliSessionId ? { provider, sessionId: m.cliSessionId } : void 0,
        seq: 0
      };
      const tdir = join18(threadsDir, meta.id);
      if (existsSync12(tdir)) meta.id = `t_${m.id}_v1`.slice(0, 80);
      await mkdir8(join18(threadsDir, meta.id), { recursive: true });
      const oldEvts = (await readFile17(join18(oldDir, m.id, "events.jsonl"), "utf8").catch(() => "")).split("\n").filter((l) => l.trim()).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter((x) => !!x);
      const lines = [];
      const openTools = /* @__PURE__ */ new Map();
      let seq = 0;
      const push = (ev) => {
        seq++;
        lines.push({ ...ev, seq, ts: Date.now(), threadId: meta.id });
      };
      for (const e of oldEvts) {
        switch (e.type) {
          case "user":
            push({ type: "user_message", text: String(e.text ?? "") });
            break;
          case "text":
            push({ type: "assistant_message", itemId: `lg_${seq}`, text: String(e.text ?? "") });
            break;
          case "thinking":
            push({ type: "reasoning", itemId: `lg_${seq}`, text: String(e.text ?? "") });
            break;
          case "tool.call": {
            const key = String(e.itemId ?? e.callId ?? `c${seq}`);
            openTools.set(key, { kind: String(e.kind ?? "other"), title: String(e.title ?? e.kind ?? "\u5DE5\u5177"), input: e.input, detail: e.detail });
            push({ type: "tool_call", itemId: key, kind: "other", title: String(e.title ?? "\u5DE5\u5177"), status: "running", input: e.input, detail: e.detail });
            break;
          }
          case "tool.result": {
            const key = String(e.itemId ?? e.callId ?? `c${seq}`);
            const open = openTools.get(key);
            openTools.delete(key);
            push({
              type: "tool_call",
              itemId: key,
              kind: open?.kind ?? "other",
              title: open?.title ?? "\u5DE5\u5177",
              status: e.ok === false || e.error ? "failed" : "ok",
              output: typeof e.output === "string" ? e.output.slice(0, 2e4) : void 0,
              detail: open?.detail
            });
            break;
          }
          case "todo": {
            const items = e.items ?? [];
            push({ type: "todo", items: items.map((i) => ({ text: String(i.text ?? ""), status: i.status === "done" ? "done" : i.status === "in_progress" ? "in_progress" : "todo" })) });
            break;
          }
          case "permission.denied":
            push({ type: "notice", level: "warn", message: `\u5DF2\u62D2\u7EDD\uFF1A${String(e.title ?? e.kind ?? "")}` });
            break;
          case "permission.request":
          case "permission.resolved":
            break;
          // Old permission cards are stale; don't recreate them
          case "notice":
            push({ type: "notice", level: e.level ?? "info", message: String(e.message ?? "") });
            break;
          case "run.end": {
            const u = e.usage;
            if (u) push({ type: "usage", turnId: `lg_t${seq}`, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadTokens ?? 0, costUsd: e.costUsd ?? 0 });
            push({ type: "turn_ended", turnId: `lg_t${seq}`, status: e.status === "error" ? "failed" : e.status === "interrupted" ? "interrupted" : "completed", durationMs: e.ms ?? void 0, error: e.error });
            break;
          }
          case "run.start":
            break;
          case "init":
            break;
          default:
            break;
        }
      }
      for (const [key, o] of openTools) {
        seq++;
        lines.push({ type: "tool_call", itemId: key, kind: "other", title: o.title, status: "failed", seq, ts: Date.now(), threadId: meta.id });
      }
      for (const ev of lines) await appendJsonl(join18(threadsDir, meta.id, "timeline.jsonl"), ev);
      meta.seq = seq;
      await writeJsonAtomic(join18(threadsDir, meta.id, "meta.json"), meta);
      migrated++;
    } catch (e) {
      log("warn", "\u8FC1\u79FB\uFF1A\u4F1A\u8BDD\u5931\u8D25", { id: m.id, err: String(e) });
    }
  }
  const patch = { v1Migrated: true };
  if (typeof oldSettings.theme === "string") patch.theme = oldSettings.theme;
  if (typeof oldSettings.sendKey === "string") patch.sendKey = oldSettings.sendKey;
  if (typeof oldSettings.showThinking === "boolean") patch.showThinking = oldSettings.showThinking;
  if (typeof oldSettings.defaultAgent === "string") patch.defaultProvider = oldSettings.defaultAgent === "claude" || oldSettings.defaultAgent === "codex" ? oldSettings.defaultAgent : "claude";
  if (typeof oldSettings.defaultPermission === "string") patch.defaultMode = MODE_MAP[oldSettings.defaultPermission] ?? "default";
  await stores.settings.set(patch);
  log("info", `\u65E7\u6570\u636E\u8FC1\u79FB\u5B8C\u6210\uFF1A${migrated} \u4E2A\u4F1A\u8BDD\u3001${projectIdByPath.size} \u4E2A\u9879\u76EE\uFF0C\u5907\u4EFD\u5728 ${backup}`);
  return { migrated, skipped: false };
}
var SKIP_TITLE, MODE_MAP, belongsTo;
var init_legacy = __esm({
  "daemon/src/migrate/legacy.ts"() {
    init_jsonl();
    init_atomic();
    init_paths();
    init_log();
    SKIP_TITLE = /^\/(slow|deny|error|long|codex)/;
    MODE_MAP = {
      plan: "plan",
      default: "default",
      acceptEdits: "acceptEdits",
      bypassPermissions: "bypassPermissions",
      auto: "acceptEdits",
      full: "bypassPermissions"
    };
    belongsTo = (cwd, parent) => {
      const c = cwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      const p = parent.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      return c === p || c.startsWith(p + "/");
    };
  }
});

// daemon/src/providers/warm.ts
var warm_exports = {};
__export(warm_exports, {
  warmProviderCache: () => warmProviderCache
});
async function warmProviderCache(settings) {
  await Promise.all(
    listProviders().map(async (p) => {
      if (!isProviderEnabled(settings, p.id) || catalogById(p.id)?.status === "planned") return;
      const det = await cachedDetect(p);
      if (det.available) await cachedModels(p);
    })
  );
}
var init_warm = __esm({
  "daemon/src/providers/warm.ts"() {
    init_registry();
    init_catalog();
    init_enabled();
    init_infoCache();
  }
});

// daemon/src/main.ts
import { mkdirSync as mkdirSync2, rmSync as rmSync2, chmodSync as chmodSync2 } from "node:fs";
import { join as join19, dirname as dirname7 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// daemon/src/config.ts
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2, resolve, dirname as dirname2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// daemon/src/util/buildStamp.ts
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function resolveDaemonMainJs() {
  const self = fileURLToPath(import.meta.url);
  const norm = self.replace(/\\/g, "/");
  if (norm.endsWith("/daemon/dist/main.js") || norm.endsWith("/dist/main.js")) return self;
  const here = dirname(self);
  const candidates = [
    join(here, "..", "..", "dist", "main.js"),
    // src/util → daemon/dist/main.js (vitest/tsc)
    join(here, "main.js"),
    // Already in the dist directory
    join(here, "..", "main.js")
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
function daemonBuildStamp() {
  try {
    const mainJs = resolveDaemonMainJs();
    if (!mainJs) return "0";
    return String(statSync(mainJs).mtimeMs);
  } catch {
    return "0";
  }
}

// daemon/src/config.ts
function pkgVersion() {
  try {
    const here = dirname2(fileURLToPath2(import.meta.url));
    const pkg = JSON.parse(readFileSync(join2(here, "..", "..", "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}
function parseConfig(argv) {
  let port = null;
  let data = null;
  let token = null;
  let parentPid;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice(7));
    else if (a === "--data" && argv[i + 1]) data = argv[++i];
    else if (a.startsWith("--data=")) data = a.slice(7);
    else if (a === "--token" && argv[i + 1]) token = argv[++i];
    else if (a.startsWith("--token=")) token = a.slice(8);
    else if (a === "--parent-pid" && argv[i + 1]) parentPid = Number(argv[++i]);
    else if (a.startsWith("--parent-pid=")) parentPid = Number(a.slice(13));
  }
  if (port == null || !Number.isInteger(port) || port < 0 || port > 65535) {
    const envPort = Number(process.env.AGENT_CONSOLE_PORT || "");
    port = Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535 ? envPort : 3488;
  }
  const xdg = data ?? process.env.XDG_CONFIG_HOME ?? join2(homedir(), ".config");
  const dataDir = resolve(join2(xdg, "magpie", "agent-console"));
  const idleEnv = Number(process.env.AGENT_CONSOLE_IDLE_EXIT_MIN || "");
  return {
    port,
    dataDir,
    token: token ?? process.env.AGENT_CONSOLE_TOKEN ?? randomBytes(16).toString("hex"),
    version: pkgVersion(),
    idleExitMinutes: Number.isFinite(idleEnv) && idleEnv > 0 ? idleEnv : 60,
    buildStamp: daemonBuildStamp(),
    parentPid: Number.isInteger(parentPid) ? parentPid : void 0
  };
}

// daemon/src/main.ts
init_log();

// daemon/src/http.ts
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { join as join4, normalize, extname } from "node:path";

// daemon/src/security.ts
import { timingSafeEqual, createHash } from "node:crypto";
function checkHost(host, port) {
  if (!host) return { ok: false, code: 421, message: "Host \u4E0D\u5BF9" };
  const h = host.toLowerCase();
  if (h === `127.0.0.1:${port}` || h === `localhost:${port}`) return { ok: true };
  return { ok: false, code: 421, message: "Host \u4E0D\u5BF9" };
}
function classifyOrigin(origin, port) {
  if (origin === void 0 || origin === "") return "none";
  if (origin === "null") return "opaque";
  const o = origin.toLowerCase();
  if (o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`) return "self";
  return "foreign";
}
function tokenEqual(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// daemon/src/http.ts
init_log();
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".json": "application/json; charset=utf-8"
};
var MAX_UPLOAD = 50 * 1024 * 1024;
var MAX_MSG = 200 * 1024;
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}
function sendJson(res, code, obj, headers = {}) {
  send(res, code, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
}
var STATIC_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
function createHttpServer(cfg2, appDir, attachments, hooks = {}) {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      log("error", "HTTP \u5904\u7406\u5F02\u5E38", { url: req.url, err: String(e) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, e: { code: "internal", message: "\u670D\u52A1\u5185\u90E8\u9519\u8BEF" } });
      else res.end();
    }
  });
  async function route(req, res) {
    const hostCheck = checkHost(req.headers.host, cfg2.port);
    if (!hostCheck.ok) {
      sendJson(res, hostCheck.code, { ok: false, e: { code: "bad_host", message: hostCheck.message } });
      return;
    }
    const origin = classifyOrigin(req.headers.origin, cfg2.port);
    if (origin === "foreign") {
      sendJson(res, 403, { ok: false, e: { code: "bad_origin", message: "\u6765\u6E90\u4E0D\u5141\u8BB8" } });
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${cfg2.port}`);
    const pathname = url.pathname;
    const isApi = pathname.startsWith("/api/");
    const isAttachment = pathname.startsWith("/attachments/");
    if (req.method === "OPTIONS") {
      if (pathname !== "/api/upload" || origin === "none") {
        sendJson(res, 403, { ok: false, e: { code: "bad_preflight", message: "\u9884\u68C0\u4E0D\u5141\u8BB8" } });
        return;
      }
      send(res, 204, "", {
        "access-control-allow-origin": origin === "opaque" ? "null" : `http://127.0.0.1:${cfg2.port}`,
        "access-control-allow-headers": "x-agent-console, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "600",
        vary: "origin"
      });
      return;
    }
    if (isApi || isAttachment) {
      const headerToken = req.headers["x-agent-console"];
      const queryToken = isAttachment ? url.searchParams.get("t") : null;
      const validToken = typeof headerToken === "string" && tokenEqual(headerToken, cfg2.token) || typeof queryToken === "string" && tokenEqual(queryToken, cfg2.token);
      if (!validToken) {
        sendJson(res, 403, { ok: false, e: { code: "bad_token", message: "\u4EE4\u724C\u65E0\u6548" } });
        return;
      }
      if (origin === "opaque") {
        res.setHeader("access-control-allow-origin", "null");
        res.setHeader("vary", "origin");
      }
      if (isApi) {
        await routeApi(req, res, pathname, url);
        return;
      }
      const id = safeDecode(pathname.slice("/attachments/".length));
      const a = id === null ? null : await attachments.get(id);
      if (!a) {
        sendJson(res, 404, { ok: false, e: { code: "not_found", message: "\u9644\u4EF6\u4E0D\u5B58\u5728" } });
        return;
      }
      const data2 = await attachments.read(a.id);
      send(res, 200, data2 ?? Buffer.alloc(0), { ...STATIC_HEADERS, "content-type": a.mime });
      return;
    }
    if (origin === "opaque") {
      sendJson(res, 403, { ok: false, e: { code: "bad_origin", message: "\u6765\u6E90\u4E0D\u5141\u8BB8" } });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, e: { code: "method", message: "\u65B9\u6CD5\u4E0D\u5141\u8BB8" } });
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      try {
        const html = await readFile(join4(appDir, "index.html"), "utf8");
        send(res, 200, html, { ...STATIC_HEADERS, "content-type": "text/html; charset=utf-8" });
      } catch {
        send(res, 503, "app \u8FD8\u6CA1\u6784\u5EFA\uFF08\u7F3A app/index.html\uFF09", { ...STATIC_HEADERS, "content-type": "text/plain; charset=utf-8" });
      }
      return;
    }
    const decoded = safeDecode(pathname);
    if (decoded === null) {
      sendJson(res, 400, { ok: false, e: { code: "bad_path", message: "\u8DEF\u5F84\u4E0D\u5408\u6CD5" } });
      return;
    }
    const rel = normalize(decoded).replace(/^([\\/])+/, "");
    const full = normalize(join4(appDir, rel));
    if (!full.startsWith(normalize(appDir)) || rel.includes("..")) {
      sendJson(res, 403, { ok: false, e: { code: "bad_path", message: "\u8DEF\u5F84\u4E0D\u5141\u8BB8" } });
      return;
    }
    if (!existsSync2(full) || !(await stat(full)).isFile()) {
      sendJson(res, 404, { ok: false, e: { code: "not_found", message: "\u6587\u4EF6\u4E0D\u5B58\u5728" } });
      return;
    }
    const data = await readFile(full);
    send(res, 200, data, { ...STATIC_HEADERS, "content-type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream" });
  }
  async function routeApi(req, res, pathname, url) {
    if (pathname === "/api/ping" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: cfg2.version, port: cfg2.port, pid: process.pid, dataDir: cfg2.dataDir, buildStamp: cfg2.buildStamp });
      return;
    }
    if (pathname === "/api/upload" && req.method === "POST") {
      const name = url.searchParams.get("name") ?? "";
      if (!attachments.allowedExt(name)) {
        sendJson(res, 400, { ok: false, e: { code: "bad_type", message: "\u4E0D\u652F\u6301\u7684\u6587\u4EF6\u7C7B\u578B" } });
        return;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD) {
        res.setHeader("connection", "close");
        sendJson(res, 413, { ok: false, e: { code: "too_large", message: "\u6587\u4EF6\u592A\u5927\uFF08\u4E0A\u9650 50MB\uFF09" } });
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        const b = c;
        size += b.length;
        if (size > MAX_UPLOAD) {
          res.setHeader("connection", "close");
          sendJson(res, 413, { ok: false, e: { code: "too_large", message: "\u6587\u4EF6\u592A\u5927\uFF08\u4E0A\u9650 50MB\uFF09" } });
          return;
        }
        chunks.push(b);
      }
      const a = await attachments.save(name, Buffer.concat(chunks));
      sendJson(res, 200, { ok: true, id: a.id, name: a.name, mime: a.mime, size: a.size });
      return;
    }
    sendJson(res, 404, { ok: false, e: { code: "not_found", message: "\u63A5\u53E3\u4E0D\u5B58\u5728" } });
  }
  if (hooks.onUpgrade) {
    server.on("upgrade", hooks.onUpgrade);
  }
  return server;
}

// daemon/src/store/attachments.ts
init_paths();
import { writeFile, mkdir, stat as stat2, readFile as readFile2 } from "node:fs/promises";
import { join as join5, extname as extname2 } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
var IMG_EXT = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
var TEXT_EXT = /* @__PURE__ */ new Set([".txt", ".md", ".log", ".json", ".csv", ".xml", ".yaml", ".yml", ".html", ".css", ".js", ".ts", ".py", ".toml", ".ini", ".conf"]);
var MIME2 = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
var TEXT_MIME = "text/plain; charset=utf-8";
var AttachmentStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  // id → file name: avoids a readdir of the whole directory on every lookup (slow with many attachments)
  files = /* @__PURE__ */ new Map();
  safeExt(name) {
    const ext = extname2(name).toLowerCase();
    if (IMG_EXT.has(ext) || TEXT_EXT.has(ext)) return ext;
    if (!ext) return ".txt";
    return null;
  }
  allowedExt(name) {
    return this.safeExt(name) !== null;
  }
  async save(name, data) {
    const ext = this.safeExt(name);
    if (!ext) throw new Error("\u4E0D\u652F\u6301\u7684\u6587\u4EF6\u7C7B\u578B");
    const id = "a_" + Date.now().toString(36) + randomBytes2(3).toString("hex");
    await mkdir(this.dir, { recursive: true });
    const file = join5(this.dir, id + ext);
    await writeFile(file, data);
    this.files.set(id, id + ext);
    const mime = MIME2[ext] ?? TEXT_MIME;
    return { id, name: name || "\u672A\u547D\u540D" + ext, mime, size: data.length, path: file };
  }
  async get(id) {
    if (!validId(id)) return null;
    const known = this.files.get(id);
    if (known) {
      const hit = await this.describe(id, known);
      if (hit) return hit;
      this.files.delete(id);
    }
    const { readdir: readdir7 } = await import("node:fs/promises");
    try {
      for (const f of await readdir7(this.dir)) {
        if (f.startsWith(id + ".")) {
          this.files.set(id, f);
          return await this.describe(id, f);
        }
      }
    } catch {
    }
    return null;
  }
  async describe(id, f) {
    const p = join5(this.dir, f);
    const s = await stat2(p).catch(() => null);
    if (!s?.isFile()) return null;
    const ext = extname2(f).toLowerCase();
    return { id, name: f.slice(id.length + 1) || f, mime: MIME2[ext] ?? TEXT_MIME, size: s.size, path: p };
  }
  async read(id) {
    const a = await this.get(id);
    if (!a) return null;
    return readFile2(a.path);
  }
};

// daemon/src/store/settings.ts
init_atomic();
import { readFile as readFile11 } from "node:fs/promises";
import { join as join12 } from "node:path";
var DEFAULT_SETTINGS = {
  defaultProvider: "claude",
  defaultMode: "default",
  defaultEffort: null,
  sendKey: "enter",
  runningSend: "queue",
  showThinking: true,
  density: "comfortable",
  theme: "auto",
  idleCloseMinutes: 30,
  idleExitMinutes: 60,
  collapsedProjects: [],
  panel: { open: false, tab: "changes", width: 440 },
  sidebarWidth: 248,
  lastProjectId: null,
  lastThreadId: null,
  recentDirs: []
};
var SettingsStore = class {
  file;
  cache = null;
  writing = Promise.resolve();
  constructor(dataDir) {
    this.file = join12(dataDir, "settings.json");
  }
  async get() {
    if (this.cache) return this.cache;
    let raw = {};
    try {
      raw = JSON.parse(await readFile11(this.file, "utf8"));
    } catch {
    }
    this.cache = { ...DEFAULT_SETTINGS, ...raw, panel: { ...DEFAULT_SETTINGS.panel, ...raw.panel } };
    return this.cache;
  }
  async set(patch) {
    const cur = await this.get();
    const next = { ...cur, ...patch, panel: { ...cur.panel, ...patch.panel } };
    this.cache = next;
    const snap = next;
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snap));
    await this.writing;
    return next;
  }
};

// daemon/src/store/projects.ts
init_atomic();
init_paths();
init_methods();
import { readFile as readFile12 } from "node:fs/promises";
import { existsSync as existsSync9, statSync as statSync5 } from "node:fs";
import { join as join13 } from "node:path";
import { randomBytes as randomBytes3 } from "node:crypto";
function newId() {
  return "p_" + Date.now().toString(36) + randomBytes3(3).toString("hex");
}
var ProjectsStore = class {
  file;
  cache = null;
  writing = Promise.resolve();
  constructor(dataDir) {
    this.file = join13(dataDir, "projects.json");
  }
  async list() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile12(this.file, "utf8"));
      if (!Array.isArray(this.cache)) this.cache = [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }
  async get(id) {
    if (!validId(id)) return null;
    return (await this.list()).find((p) => p.id === id) ?? null;
  }
  async save(list) {
    this.cache = list;
    const snap = list;
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snap));
    await this.writing;
  }
  async create(path3, name) {
    if (!path3 || typeof path3 !== "string") throw new ApiError("bad_params", "\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
    if (!existsSync9(path3) || !statSync5(path3).isDirectory()) {
      throw new ApiError("bad_path", "\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u6587\u4EF6\u5939");
    }
    const np = normPath(path3);
    const list = await this.list();
    const dup = list.find((p) => normPath(p.path) === np);
    if (dup) return dup;
    const proj = {
      id: newId(),
      name: name?.trim() || path3.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path3,
      path: path3,
      createdAt: Date.now()
    };
    list.push(proj);
    await this.save(list);
    return proj;
  }
  async rename(id, name) {
    const list = await this.list();
    const p = list.find((x) => x.id === id);
    if (!p) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
    p.name = name.trim() || p.name;
    await this.save(list);
    return p;
  }
  async remove(id) {
    const list = await this.list();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    list.splice(idx, 1);
    await this.save(list);
  }
};

// daemon/src/store/threads.ts
init_atomic();
init_jsonl();
init_paths();
init_methods();
init_i18n();
import { mkdir as mkdir6, rename as rename3, readdir as readdir4, readFile as readFile14 } from "node:fs/promises";
import { join as join14 } from "node:path";
import { randomBytes as randomBytes4 } from "node:crypto";
function newId2() {
  return "t_" + Date.now().toString(36) + randomBytes4(3).toString("hex");
}
var ThreadsStore = class {
  dir;
  trashDir;
  metas = /* @__PURE__ */ new Map();
  loaded = false;
  // Serialize meta writes: concurrent patch/appendEvent would overwrite each other (setStatus/patch/provider_session_id run concurrently in the manager)
  writeQ = Promise.resolve();
  serial(fn) {
    const p = this.writeQ.then(fn, fn);
    this.writeQ = p.catch(() => {
    });
    return p;
  }
  constructor(dataDir) {
    this.dir = join14(dataDir, "threads");
    this.trashDir = join14(dataDir, "trash", "threads");
  }
  tdir(id) {
    return join14(this.dir, id);
  }
  metaPath(id) {
    return join14(this.tdir(id), "meta.json");
  }
  timelinePath(id) {
    return join14(this.tdir(id), "timeline.jsonl");
  }
  async loadAll() {
    if (this.loaded) return;
    this.loaded = true;
    let ids = [];
    try {
      ids = (await readdir4(this.dir)).filter((d) => validId(d));
    } catch {
      return;
    }
    for (const id of ids) {
      try {
        const m = JSON.parse(await readFile14(this.metaPath(id), "utf8"));
        if (m && typeof m.id === "string") this.metas.set(m.id, m);
      } catch {
      }
    }
  }
  async list() {
    await this.loadAll();
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id) {
    if (!validId(id)) return null;
    await this.loadAll();
    return this.metas.get(id) ?? null;
  }
  async saveMeta(meta) {
    this.metas.set(meta.id, meta);
    await writeJsonAtomic(this.metaPath(meta.id), meta);
  }
  async create(o) {
    const now = Date.now();
    const meta = {
      id: newId2(),
      projectId: o.projectId,
      title: o.title ?? tr("thread.defaultTitle"),
      titleAuto: o.title == null,
      provider: o.provider,
      model: o.model ?? null,
      mode: o.mode ?? "default",
      effort: o.effort ?? null,
      providerSessionId: o.providerSessionId ?? null,
      status: "idle",
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      lastTurnStatus: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      importedFrom: o.importedFrom,
      seq: 0
    };
    try {
      await mkdir6(this.tdir(meta.id), { recursive: true });
    } catch (e) {
      throw new ApiError("io_error", `\u521B\u5EFA\u5BF9\u8BDD\u76EE\u5F55\u5931\u8D25\uFF1A${e?.message ?? e}`);
    }
    await this.saveMeta(meta);
    return meta;
  }
  async patch(id, patch) {
    return this.serial(async () => {
      const meta = await this.get(id);
      if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
      if (patch.title !== void 0 && patch.titleAuto === void 0) patch = { ...patch, titleAuto: false };
      const next = { ...meta, ...patch, id: meta.id, updatedAt: Date.now() };
      await this.saveMeta(next);
      return next;
    });
  }
  // Append an event: inside the serialized section take meta.seq+1 as seq, write the jsonl and update meta.
  // A passed-in seq is ignored (keeps it strictly increasing); ts/threadId are filled in when missing.
  async appendEvent(id, ev) {
    return this.serial(async () => {
      const meta = await this.get(id);
      if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
      const full = {
        ...ev,
        seq: meta.seq + 1,
        ts: ev.ts ?? Date.now(),
        threadId: id
      };
      await appendJsonl(this.timelinePath(id), full);
      meta.seq = full.seq;
      meta.updatedAt = Date.now();
      this.metas.set(id, meta);
      await writeJsonAtomic(this.metaPath(id), meta);
      return full;
    });
  }
  async readEvents(id, afterSeq = 0, limit = 5e3) {
    const rows = await readJsonl(this.timelinePath(id));
    const out = rows.filter((e) => typeof e.seq === "number" && e.seq > afterSeq);
    return out.slice(-limit);
  }
  async delete(id) {
    const meta = await this.get(id);
    if (!meta) return;
    const stamp2 = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    await mkdir6(this.trashDir, { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename3(this.tdir(id), join14(this.trashDir, `${id}-${stamp2}`));
        break;
      } catch (e) {
        const code = e?.code;
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 8) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw new ApiError("internal", "\u79FB\u5165\u56DE\u6536\u76EE\u5F55\u5931\u8D25\uFF1A" + String(e));
      }
    }
    this.metas.delete(id);
  }
};

// daemon/src/ws/gateway.ts
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes as randomBytes5 } from "node:crypto";
init_log();
init_i18n();
var Conn = class {
  id;
  ws;
  authed = false;
  subs = /* @__PURE__ */ new Set();
  alive = true;
  lastMsg = Date.now();
  constructor(ws) {
    this.id = "c_" + randomBytes5(4).toString("hex");
    this.ws = ws;
  }
  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const s = JSON.stringify(obj);
      if (this.overflow(s.length)) {
        log("warn", `\u8FDE\u63A5 ${this.id} \u51FA\u7AD9\u7F13\u51B2\u8D85 8MB\uFF0C\u65AD\u5F00`);
        this.ws.close(4e3, "buffer_overflow");
        return;
      }
      this.ws.send(s);
    } catch {
    }
  }
  // Look at bytes really still unsent in the socket (only grows when the client is stuck), not the cumulative amount sent
  overflow(next) {
    return this.ws.bufferedAmount + next > 8 * 1024 * 1024;
  }
  sendBinary(frame) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.overflow(frame.length)) {
      log("warn", `\u8FDE\u63A5 ${this.id} \u51FA\u7AD9\u7F13\u51B2\u8D85 8MB\uFF0C\u65AD\u5F00`);
      this.ws.close(4e3, "buffer_overflow");
      return;
    }
    try {
      this.ws.send(frame);
    } catch {
    }
  }
};
var Gateway = class {
  constructor(cfg2) {
    this.cfg = cfg2;
    this.wss = new WebSocketServer({ noServer: true });
  }
  cfg;
  wss;
  conns = /* @__PURE__ */ new Map();
  methods = /* @__PURE__ */ new Map();
  helloTimers = /* @__PURE__ */ new Map();
  onTerminalInput;
  method(name, fn) {
    this.methods.set(name, fn);
  }
  get connectionCount() {
    return this.conns.size;
  }
  handleUpgrade(req, socket, head) {
    const hostCheck = checkHost(req.headers.host, this.cfg.port);
    if (!hostCheck.ok) {
      socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (classifyOrigin(req.headers.origin, this.cfg.port) === "foreign") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.cfg.port}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConn(ws));
  }
  onConn(ws) {
    const conn = new Conn(ws);
    this.conns.set(conn.id, conn);
    const timer = setTimeout(() => {
      if (!conn.authed) ws.close(4401, "auth_timeout");
    }, 5e3);
    this.helloTimers.set(conn.id, timer);
    ws.on("message", (data, isBinary) => {
      conn.lastMsg = Date.now();
      if (isBinary) {
        this.onBinary(conn, data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        conn.send({ t: "res", id: 0, ok: false, e: { code: "bad_json", message: "\u6D88\u606F\u4E0D\u662F\u5408\u6CD5 JSON" } });
        return;
      }
      this.onMessage(conn, msg);
    });
    ws.on("close", () => {
      this.conns.delete(conn.id);
      const t = this.helloTimers.get(conn.id);
      if (t) clearTimeout(t);
      this.helloTimers.delete(conn.id);
    });
    ws.on("error", () => {
    });
  }
  onMessage(conn, msg) {
    if (msg.t === "hello") {
      if (!conn.authed) {
        if (typeof msg.token === "string" && tokenEqual(msg.token, this.cfg.token)) {
          conn.authed = true;
          setAppLocale(msg.lang);
          const t = this.helloTimers.get(conn.id);
          if (t) clearTimeout(t);
          conn.send({ t: "hello.ok", version: this.cfg.version, serverTime: Date.now() });
        } else {
          conn.send({ t: "res", id: 0, ok: false, e: { code: "bad_token", message: "\u4EE4\u724C\u65E0\u6548" } });
          conn.ws.close(4401, "bad_token");
        }
      }
      return;
    }
    if (msg.t === "ping") {
      conn.send({ t: "pong" });
      return;
    }
    if (msg.t === "req") {
      if (!conn.authed) {
        conn.send({ t: "res", id: msg.id, ok: false, e: { code: "unauthorized", message: "\u672A\u9274\u6743" } });
        return;
      }
      void this.dispatch(conn, msg);
      return;
    }
  }
  async dispatch(conn, msg) {
    const fn = this.methods.get(msg.m);
    if (!fn) {
      conn.send({ t: "res", id: msg.id, ok: false, e: { code: "not_found", message: `\u672A\u77E5\u65B9\u6CD5 ${msg.m}` } });
      return;
    }
    try {
      const r = await fn(msg.p, { connId: conn.id, conn });
      conn.send({ t: "res", id: msg.id, ok: true, r: r ?? null });
    } catch (e) {
      const err = e;
      conn.send({
        t: "res",
        id: msg.id,
        ok: false,
        e: { code: err.code ?? "internal", message: err.message ?? "\u670D\u52A1\u5185\u90E8\u9519\u8BEF" }
      });
    }
  }
  // Terminal binary frame: [op:1][terminalIndex:2 BE][payload]
  onBinary(conn, buf) {
    if (buf.length < 3) return;
    const op = buf.readUInt8(0);
    const index = buf.readUInt16BE(1);
    this.onTerminalInput?.(conn, index, op, buf.subarray(3));
  }
  publish(ch, data) {
    for (const c of this.conns.values()) {
      if (c.authed && c.subs.has(ch)) c.send({ t: "evt", ch, d: data });
    }
  }
  publishTerminal(index, payload) {
    const frame = Buffer.concat([Buffer.from([1, index >> 8 & 255, index & 255]), payload]);
    for (const c of this.conns.values()) {
      if (c.authed && c.subs.has(`terminal:${index}`)) c.sendBinary(frame);
    }
  }
  subscribe(conn, ch) {
    conn.subs.add(ch);
  }
  unsubscribe(conn, ch) {
    conn.subs.delete(ch);
  }
  closeAll() {
    for (const c of this.conns.values()) {
      try {
        c.ws.close(1001, "server_shutdown");
      } catch {
      }
    }
    this.conns.clear();
  }
};

// daemon/src/main.ts
init_methods();
init_atomic();
init_registry();

// daemon/src/agents/manager.ts
init_attachmentRefs();
init_registry();
init_catalog();
init_enabled();
init_infoCache();

// daemon/src/timeline/coalescer.ts
var Coalescer = class {
  windowMs;
  acc = /* @__PURE__ */ new Map();
  onEmit;
  constructor(windowMs, onEmit) {
    this.windowMs = windowMs;
    this.onEmit = onEmit;
  }
  // Push a delta; the first goes out immediately, the rest are merged within the window and sent trailing
  push(itemId, text) {
    const acc = this.acc.get(itemId);
    if (!acc) {
      this.onEmit(itemId, text);
      this.acc.set(itemId, { text: "", timer: setTimeout(() => this.flush(itemId), this.windowMs) });
      return;
    }
    acc.text += text;
  }
  // Must flush before the complete event arrives to keep ordering (deltas before the complete event)
  flush(itemId) {
    const acc = this.acc.get(itemId);
    if (!acc) return;
    if (acc.timer) {
      clearTimeout(acc.timer);
      acc.timer = null;
    }
    if (acc.text.length > 0) this.onEmit(itemId, acc.text);
    this.acc.delete(itemId);
  }
  // Call before an itemId's complete event arrives: flush the deltas not yet sent
  flushItem(itemId) {
    this.flush(itemId);
  }
  dispose() {
    for (const id of [...this.acc.keys()]) this.flush(id);
  }
};

// daemon/src/agents/manager.ts
init_methods();
init_log();
init_i18n();
init_commands();
var SLASH_CACHE_TTL_MS = 10 * 60 * 1e3;
var DELTA_TYPES = ["assistant_delta", "reasoning_delta", "tool_output_delta"];
var deltaKey = (type, itemId) => `${type}\0${itemId}`;
var AgentManager = class {
  constructor(gw, threads, projects, settings, attachments) {
    this.gw = gw;
    this.threads = threads;
    this.projects = projects;
    this.settings = settings;
    this.attachments = attachments;
  }
  gw;
  threads;
  projects;
  settings;
  attachments;
  runtimes = /* @__PURE__ */ new Map();
  recycleTimer = null;
  slashCache = /* @__PURE__ */ new Map();
  /** attachment.path in the frontend's thread.send is really an upload id; resolve it to the file under dataDir/attachments */
  resolveAttachments(refs) {
    return resolveAttachmentRefs(this.attachments, refs);
  }
  attachmentLabels(refs) {
    return refs.map((a) => ({ id: a.path, name: (a.name ?? "").trim() || a.path, mime: a.mime }));
  }
  // Called at startup: running/initializing conversations are recovered as closed (§5.7.6)
  async recoverOnStart() {
    for (const meta of await this.threads.list()) {
      if (meta.status === "running" || meta.status === "initializing") {
        await this.appendRaw(meta.id, {
          type: "notice",
          level: "warn",
          message: tr("notice.daemonRestart")
        });
        const events = await this.threads.readEvents(meta.id, 0, 5e4);
        let open = null;
        for (const e of events) {
          if (e.type === "turn_started") open = e.turnId ?? "unknown";
          else if (e.type === "user_message" && !e.steered) open = open ?? "unknown";
          else if (e.type === "turn_ended") open = null;
        }
        if (open !== null) {
          await this.appendRaw(meta.id, { type: "turn_ended", status: "interrupted", ...open && open !== "unknown" ? { turnId: open } : {} });
        }
        const resolved = new Set(
          events.filter((e) => e.type === "permission_resolved").map((e) => e.requestId)
        );
        for (const e of events) {
          if (e.type === "permission_request" && !resolved.has(e.requestId)) {
            await this.appendRaw(meta.id, {
              type: "permission_resolved",
              requestId: e.requestId,
              cancelled: true
            });
          }
        }
        await this.threads.patch(meta.id, { status: "closed", lastTurnStatus: "interrupted" });
      }
    }
    this.recycleTimer = setInterval(() => void this.recycleIdle(), 6e4);
    this.recycleTimer.unref?.();
  }
  /** Close every session; the returned Promise resolves once each close finishes (or fails). Callers add their own timeout. */
  shutdown() {
    if (this.recycleTimer) clearInterval(this.recycleTimer);
    const all = [...this.runtimes.values()].map((rt) => rt.session?.close().catch(() => {
    }));
    this.runtimes.clear();
    return Promise.all(all).then(() => {
    });
  }
  // Idle-exit check (§5.2.7): busy if any runtime is not idle
  anyBusy() {
    for (const rt of this.runtimes.values()) {
      if (rt.status === "running" || rt.status === "initializing") return true;
    }
    return false;
  }
  runtimeInfo(threadId) {
    const rt = this.runtimes.get(threadId);
    if (!rt) return null;
    return {
      status: rt.status,
      queue: rt.queue,
      pending: [...rt.pending.values()].map((p) => ({
        requestId: p.requestId,
        kind: p.kind,
        options: p.options
      }))
    };
  }
  rt(threadId) {
    let r = this.runtimes.get(threadId);
    if (!r) {
      r = {
        threadId,
        session: null,
        status: "idle",
        currentTurnId: null,
        queue: [],
        pending: /* @__PURE__ */ new Map(),
        allowAlways: /* @__PURE__ */ new Set(),
        lastActivity: Date.now(),
        coalescer: this.newCoalescer(threadId),
        interruptTimer: null,
        endedTurnIds: /* @__PURE__ */ new Set(),
        starting: false,
        commands: [],
        sessionCreating: null
      };
      this.runtimes.set(threadId, r);
    }
    return r;
  }
  newCoalescer(threadId) {
    return new Coalescer(60, (key, text) => {
      const i = key.indexOf("\0");
      const type = key.slice(0, i);
      void this.pushEvent(threadId, { type, itemId: key.slice(i + 1), text });
    });
  }
  flushDeltas(rt, itemId) {
    for (const t of DELTA_TYPES) rt.coalescer.flushItem(deltaKey(t, itemId));
  }
  // ---- send ----
  async send(threadId, input, behavior = "queue") {
    const meta = await this.mustThread(threadId);
    if (meta.archived) {
      await this.threads.patch(threadId, { archived: false });
      this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
    }
    const rt = this.rt(threadId);
    rt.lastActivity = Date.now();
    const attachmentRefs = input.attachments ?? [];
    if (meta.status === "closed" && rt.session) {
      try {
        await rt.session.close();
      } catch {
      }
      rt.session = null;
      rt.commands = [];
    }
    if (!rt.starting && rt.session === null && (rt.status === "running" || rt.status === "initializing" || rt.status === "error")) {
      rt.status = "idle";
    }
    if (rt.status === "running" || rt.starting || rt.status === "initializing") {
      const provider = this.providerOf(meta);
      if (behavior === "steer" && provider?.capabilities.steer && rt.session?.steer && !rt.starting) {
        try {
          const images = await this.resolveAttachments(attachmentRefs);
          await rt.session.steer({ text: input.text, images });
          await this.appendRaw(threadId, {
            type: "user_message",
            text: input.text,
            steered: true,
            attachments: this.attachmentLabels(attachmentRefs)
          });
          return;
        } catch (e) {
          log("info", `thread ${threadId} \u63D2\u8BDD\u5931\u8D25\uFF0C\u6539\u4E3A\u6392\u961F\uFF1A${String(e)}`);
        }
      }
      const q = { id: "q" + Date.now().toString(36), text: input.text, attachments: attachmentRefs };
      rt.queue.push(q);
      this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
      return;
    }
    await this.startTurn(threadId, input.text, attachmentRefs);
  }
  async startTurn(threadId, text, attachmentRefs) {
    const rt = this.rt(threadId);
    rt.starting = true;
    try {
      await this.startTurnInner(threadId, text, attachmentRefs);
    } finally {
      rt.starting = false;
    }
  }
  async startTurnInner(threadId, text, attachmentRefs) {
    const meta = await this.mustThread(threadId);
    const rt = this.rt(threadId);
    const provider = await this.assertProviderUsable(meta.provider, { allowDisabled: !!meta.providerSessionId });
    if (!rt.session) {
      await this.setStatus(threadId, "initializing");
      try {
        await this.createSessionIfNeeded(threadId, { updateStatus: true });
      } catch (e) {
        await this.appendRaw(threadId, { type: "notice", level: "error", message: tr("notice.sessionStartFailed", { detail: String(e?.message ?? e) }) });
        await this.appendRaw(threadId, { type: "turn_ended", status: "failed", error: String(e?.message ?? e) });
        await this.setStatus(threadId, "error");
        throw e;
      }
    }
    const trimmed = text.trim();
    if (meta.titleAuto && trimmed) {
      await this.threads.patch(threadId, { title: trimmed.slice(0, 40), titleAuto: true });
      this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
    }
    await this.appendRaw(threadId, {
      type: "user_message",
      text,
      attachments: this.attachmentLabels(attachmentRefs)
    });
    await this.setStatus(threadId, "running");
    try {
      const images = await this.resolveAttachments(attachmentRefs);
      await rt.session.send({ text, images });
    } catch (e) {
      const msg = String(e?.message ?? e);
      await this.appendRaw(threadId, { type: "notice", level: "error", message: tr("notice.sendFailed", { detail: msg }) });
      await this.appendRaw(threadId, { type: "turn_ended", status: "failed", error: msg });
      await this.threads.patch(threadId, { lastTurnStatus: "failed" });
      rt.currentTurnId = null;
      await this.setStatus(threadId, "idle");
      throw e;
    }
  }
  // ---- event pump ----
  async pumpEvents(threadId, session) {
    const rt = this.rt(threadId);
    let ended = false;
    try {
      for await (const ev of session.events) {
        await this.onProviderEvent(threadId, ev);
        if (ev.type === "turn_started") ended = false;
        if (ev.type === "turn_ended") ended = true;
      }
    } catch (e) {
      log("warn", `thread ${threadId} \u4E8B\u4EF6\u6D41\u5F02\u5E38\uFF1A${String(e)}`);
    }
    if (!ended && this.rt(threadId).session === session) {
      await this.onProviderEvent(threadId, {
        type: "turn_ended",
        turnId: rt.currentTurnId ?? "unknown",
        status: "failed",
        error: tr("turn.agentExit")
      });
      rt.session = null;
      await this.setStatus(threadId, "closed");
    }
  }
  async onProviderEvent(threadId, ev) {
    const rt = this.rt(threadId);
    rt.lastActivity = Date.now();
    if (ev.type === "provider_session_id") {
      await this.threads.patch(threadId, { providerSessionId: ev.id });
      return;
    }
    if (ev.type === "slash_commands") {
      rt.commands = ev.commands;
      const meta = await this.mustThread(threadId);
      const proj = await this.projects.get(meta.projectId);
      if (proj) this.putSlashCache(meta.provider, proj.path, ev.commands);
      this.gw.publish(`thread:${threadId}`, { type: "commands", commands: ev.commands });
      return;
    }
    if (ev.type === "turn_started") {
      rt.currentTurnId = ev.turnId;
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "assistant_delta" || ev.type === "reasoning_delta" || ev.type === "tool_output_delta") {
      rt.coalescer.push(deltaKey(ev.type, ev.itemId), ev.text);
      return;
    }
    const evItemId = ev.itemId;
    if (typeof evItemId === "string") this.flushDeltas(rt, evItemId);
    if (ev.type === "assistant_message" || ev.type === "reasoning") {
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "usage") {
      const meta = await this.mustThread(threadId);
      const u = meta.usage;
      await this.threads.patch(threadId, {
        usage: {
          inputTokens: u.inputTokens + ev.inputTokens,
          outputTokens: u.outputTokens + ev.outputTokens,
          cacheReadTokens: u.cacheReadTokens + ev.cacheReadTokens,
          costUsd: u.costUsd + ev.costUsd
        }
      });
      await this.pushEvent(threadId, ev);
      return;
    }
    if (ev.type === "permission_request" || ev.type === "question") {
      const options = ev.type === "permission_request" ? ev.options : [];
      const pending = {
        kind: ev.type === "permission_request" ? "permission" : "question",
        requestId: ev.requestId,
        options,
        resolve: () => {
        },
        event: ev
      };
      const toolName = ev.detail?.toolName;
      if (toolName && rt.allowAlways.has(toolName)) {
        rt.session?.respond(ev.requestId, { optionId: "accept" });
        return;
      }
      rt.pending.set(ev.requestId, pending);
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "permission_resolved" || ev.type === "question_answered") {
      if (!rt.pending.delete(ev.requestId)) return;
      await this.appendRaw(threadId, ev);
      return;
    }
    if (ev.type === "turn_ended") {
      if (ev.turnId && ev.turnId !== "unknown" && rt.endedTurnIds.has(ev.turnId)) return;
      if (rt.interruptTimer) {
        clearTimeout(rt.interruptTimer);
        rt.interruptTimer = null;
      }
      if (ev.turnId && ev.turnId !== "unknown") rt.endedTurnIds.add(ev.turnId);
      rt.coalescer.dispose();
      rt.coalescer = this.newCoalescer(threadId);
      await this.appendRaw(threadId, ev);
      await this.threads.patch(threadId, { lastTurnStatus: ev.status });
      rt.currentTurnId = null;
      if (ev.status === "failed" && rt.session && !this.alive(rt.session)) rt.session = null;
      await this.setStatus(threadId, "idle");
      const next = rt.queue.shift();
      if (next) {
        this.gw.publish(`thread:${threadId}`, { type: "queue", queue: rt.queue });
        await this.startTurn(threadId, next.text, next.attachments).catch((e) => {
          log("warn", `thread ${threadId} \u6392\u961F\u6D88\u606F\u542F\u52A8\u5931\u8D25\uFF1A${String(e)}`);
        });
      }
      return;
    }
    await this.appendRaw(threadId, ev);
  }
  alive(_s) {
    return true;
  }
  // ---- respond (permission/question answers) ----
  async respond(threadId, requestId, answer) {
    const rt = this.rt(threadId);
    const pending = rt.pending.get(requestId);
    if (!pending) throw new ApiError("not_found", "\u6388\u6743/\u63D0\u95EE\u4E0D\u5B58\u5728\u6216\u5DF2\u56DE\u5E94");
    if (pending.kind === "permission" && answer.optionId) {
      const valid = pending.options.some((o) => o.id === answer.optionId);
      if (!valid) throw new ApiError("bad_params", `optionId \u975E\u6CD5\uFF1A${answer.optionId}`);
    }
    rt.pending.delete(requestId);
    if (pending.kind === "permission") {
      await this.appendRaw(threadId, {
        type: "permission_resolved",
        requestId,
        optionId: answer.optionId,
        cancelled: answer.cancelled
      });
      const opt = pending.options.find((o) => o.id === answer.optionId);
      if (opt?.kind === "allow_always") {
        const toolName = pending.event.detail?.toolName;
        if (toolName) rt.allowAlways.add(toolName);
      }
    } else {
      await this.appendRaw(threadId, {
        type: "question_answered",
        requestId,
        answers: answer.answers ?? {}
      });
    }
    rt.session?.respond(requestId, answer);
  }
  // ---- interrupt ----
  async interrupt(threadId) {
    const rt = this.rt(threadId);
    if (!rt.session || rt.status !== "running") return;
    for (const [id, p] of rt.pending) {
      await this.appendRaw(threadId, { type: "permission_resolved", requestId: id, cancelled: true });
      p.resolve({ cancelled: true });
    }
    rt.pending.clear();
    await rt.session.interrupt();
    const turnId = rt.currentTurnId;
    rt.interruptTimer = setTimeout(() => {
      rt.interruptTimer = null;
      if (rt.currentTurnId === turnId && turnId) {
        void this.onProviderEvent(threadId, { type: "turn_ended", turnId, status: "interrupted" }).catch((e) => {
          log("warn", `thread ${threadId} \u6253\u65AD\u515C\u5E95\u5931\u8D25\uFF1A${String(e)}`);
        });
      }
    }, 1e3);
  }
  // ---- setModel / setMode / setEffort ----
  async setModel(threadId, model) {
    const meta = await this.mustThread(threadId);
    let effort = meta.effort;
    const p = getProvider(meta.provider);
    if (p) {
      const models2 = await cachedModels(p);
      const row = models2.find((m) => model ? m.id === model : m.isDefault) ?? models2[0];
      const opts = row?.thinkingOptions ?? [];
      if (effort && opts.length && !opts.some((o) => o.id === effort)) {
        effort = null;
        await this.appendRaw(threadId, {
          type: "notice",
          level: "info",
          message: tr("notice.effortResetOnModel")
        });
      }
    }
    await this.threads.patch(threadId, { model, effort });
    const rt = this.rt(threadId);
    if (rt.session) await rt.session.setModel(model);
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }
  async setMode(threadId, mode) {
    await this.threads.patch(threadId, { mode });
    const rt = this.rt(threadId);
    if (rt.session) await rt.session.setMode(mode);
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }
  async setEffort(threadId, effort) {
    const meta = await this.mustThread(threadId);
    await this.threads.patch(threadId, { effort });
    const rt = this.rt(threadId);
    if (rt.session) await rt.session.setEffort(effort);
    if (meta.provider === "claude" && (rt.status === "running" || rt.status === "initializing")) {
      await this.appendRaw(threadId, {
        type: "notice",
        level: "info",
        message: tr("notice.effortNextTurn")
      });
    }
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }
  async setCursorOpts(threadId, patch) {
    const meta = await this.mustThread(threadId);
    if (meta.provider !== "cursor") throw new ApiError("bad_params", "\u4EC5 Cursor \u5BF9\u8BDD\u652F\u6301\u8BE5\u9009\u9879");
    const next = await this.threads.patch(threadId, patch);
    const rt = this.rt(threadId);
    const sess = rt.session;
    if (sess?.updateCursorOpts) {
      await sess.updateCursorOpts(!!next.cursorFast, !!next.cursorAutoReview);
    }
    this.gw.publish("sidebar", { type: "thread.upsert", thread: next });
  }
  /** The Agent can be switched only before any user message and while not running */
  async setProvider(threadId, providerId) {
    await this.mustThread(threadId);
    const meta = await this.threads.get(threadId);
    if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
    const rt = this.rt(threadId);
    if (rt.status === "running" || rt.status === "initializing" || rt.starting) {
      throw new ApiError("busy", "\u5BF9\u8BDD\u8FD0\u884C\u4E2D\uFF0C\u4E0D\u80FD\u66F4\u6362 Agent");
    }
    const events = await this.threads.readEvents(threadId, 0, 5e3);
    if (events.some((e) => e.type === "user_message")) {
      throw new ApiError("bad_params", "\u5DF2\u6709\u6D88\u606F\uFF0C\u4E0D\u80FD\u66F4\u6362 Agent");
    }
    const p = await this.assertProviderUsable(providerId);
    if (rt.session) {
      try {
        await rt.session.close();
      } catch {
      }
      rt.session = null;
      rt.commands = [];
    }
    rt.status = "idle";
    await this.threads.patch(threadId, {
      provider: providerId,
      model: null,
      mode: p.capabilities.modes.includes(meta.mode) ? meta.mode : p.capabilities.modes[0] ?? "default",
      effort: null,
      providerSessionId: null,
      status: "idle"
    });
    this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
  }
  async close(threadId) {
    const rt = this.rt(threadId);
    if (rt.session) {
      try {
        await rt.session.close();
      } catch {
      }
      rt.session = null;
      rt.commands = [];
    }
    await this.setStatus(threadId, "closed");
  }
  /** Slash commands: no session by default; only with load:true do we create a session for providers that need one to list them */
  async listCommands(threadId, opts) {
    let meta;
    try {
      meta = await this.mustThread(threadId);
    } catch {
      return [];
    }
    const rt = this.rt(threadId);
    const proj = await this.projects.get(meta.projectId);
    if (!proj) return [];
    if (meta.provider === "codex") {
      try {
        const commands = codexSlashCommandsFromEntries(await loadCodexSlashEntries(proj.path));
        rt.commands = commands;
        this.putSlashCache(meta.provider, proj.path, commands);
        return commands;
      } catch {
        return this.getSlashCache(meta.provider, proj.path) ?? rt.commands;
      }
    }
    if (rt.session) {
      try {
        const commands = await rt.session.listCommands();
        rt.commands = commands;
        this.putSlashCache(meta.provider, proj.path, commands);
        return commands;
      } catch {
        return rt.commands.length ? rt.commands : this.getSlashCache(meta.provider, proj.path) ?? [];
      }
    }
    const cached = this.getSlashCache(meta.provider, proj.path);
    if (cached) {
      rt.commands = cached;
      return cached;
    }
    if (!opts?.load) return [];
    try {
      const session = await this.createSessionIfNeeded(threadId, { updateStatus: false });
      const commands = await session.listCommands();
      rt.commands = commands;
      this.putSlashCache(meta.provider, proj.path, commands);
      return commands;
    } catch {
      return [];
    }
  }
  slashCacheKey(provider, projectPath) {
    return `${provider}\0${projectPath}`;
  }
  getSlashCache(provider, projectPath) {
    const hit = this.slashCache.get(this.slashCacheKey(provider, projectPath));
    if (!hit) return null;
    if (Date.now() > hit.expires) {
      this.slashCache.delete(this.slashCacheKey(provider, projectPath));
      return null;
    }
    return hit.commands;
  }
  putSlashCache(provider, projectPath, commands) {
    if (!commands.length) return;
    this.slashCache.set(this.slashCacheKey(provider, projectPath), {
      commands,
      expires: Date.now() + SLASH_CACHE_TTL_MS
    });
  }
  async createSessionIfNeeded(threadId, opts) {
    const rt = this.rt(threadId);
    if (rt.session) return rt.session;
    if (rt.sessionCreating) return rt.sessionCreating;
    const creating = this.createSessionInner(threadId, opts);
    rt.sessionCreating = creating;
    try {
      return await creating;
    } finally {
      if (rt.sessionCreating === creating) rt.sessionCreating = null;
    }
  }
  async createSessionInner(threadId, opts) {
    const meta = await this.mustThread(threadId);
    const rt = this.rt(threadId);
    if (rt.session) return rt.session;
    const provider = await this.assertProviderUsable(meta.provider, { allowDisabled: !!meta.providerSessionId });
    const proj = await this.projects.get(meta.projectId);
    if (!proj) throw new ApiError("not_found", "\u9879\u76EE\u4E0D\u5B58\u5728");
    let model = meta.model;
    if (meta.provider === "dsh" && model) {
      const available = await cachedModels(provider).catch(() => []);
      if (available.length && !available.some((m) => m.id === model)) {
        model = available.find((m) => /magpie/i.test(m.id))?.id ?? available.find((m) => m.isDefault)?.id ?? null;
        await this.threads.patch(threadId, { model });
        this.gw.publish("sidebar", { type: "thread.upsert", thread: await this.threads.get(threadId) });
      }
    } else if (meta.provider === "dsh" && !model) {
      const available = await cachedModels(provider).catch(() => []);
      const magpie = available.filter((m) => /magpie/i.test(m.id));
      model = (magpie.find((m) => m.isDefault) ?? magpie[0] ?? available.find((m) => m.isDefault))?.id ?? null;
    }
    if (opts.updateStatus) await this.setStatus(threadId, "initializing");
    const settings = await this.settings.get();
    const custom = settings.providerCommand?.[meta.provider];
    const launch = custom?.executable?.trim() ? { cmd: custom.executable.trim(), prefixArgs: custom.args ?? [] } : void 0;
    rt.session = await provider.createSession({
      threadId,
      cwd: proj.path,
      model,
      mode: meta.mode,
      effort: meta.effort,
      resumeId: meta.providerSessionId,
      cursorFast: meta.cursorFast,
      cursorAutoReview: meta.cursorAutoReview,
      launch
    });
    void this.pumpEvents(threadId, rt.session);
    return rt.session;
  }
  async deleteThread(threadId) {
    await this.close(threadId);
    this.runtimes.delete(threadId);
    await this.threads.delete(threadId);
  }
  // ---- internals ----
  async mustThread(threadId) {
    const meta = await this.threads.get(threadId);
    if (!meta) throw new ApiError("not_found", "\u5BF9\u8BDD\u4E0D\u5B58\u5728");
    return meta;
  }
  providerOf(meta) {
    return getProvider(meta.provider);
  }
  async assertProviderUsable(providerId, opts = {}) {
    const p = getProvider(providerId);
    if (!p) throw new ApiError("bad_params", `\u672A\u77E5 Agent\uFF1A${providerId}`);
    const s = await this.settings.get();
    if (!opts.allowDisabled && !isProviderEnabled(s, providerId)) {
      throw new ApiError("bad_params", `${p.name} \u5DF2\u5728\u8BBE\u7F6E\u4E2D\u7981\u7528`);
    }
    const entry = catalogById(providerId);
    if (entry && !providerCreatable(entry.status)) {
      throw new ApiError("bad_params", `${p.name} \u5C1A\u672A\u63A5\u5165\uFF0C\u6682\u4E0D\u80FD\u65B0\u5EFA\u5BF9\u8BDD`);
    }
    const det = await cachedDetect(p);
    if (!det.available) throw new ApiError("bad_params", det.reason ?? `${p.name} \u672A\u5B89\u88C5\u6216\u4E0D\u53EF\u7528`);
    return p;
  }
  async setStatus(threadId, status) {
    const rt = this.rt(threadId);
    rt.status = status;
    const meta = await this.threads.patch(threadId, { status });
    this.gw.publish("sidebar", { type: "thread.upsert", thread: meta });
    this.gw.publish(`thread:${threadId}`, { type: "status", status });
  }
  // Append an event: seq is assigned in the store's serialized section, persisted, then pushed to thread:<id>
  async appendRaw(threadId, ev) {
    const full = await this.threads.appendEvent(threadId, { ...ev, ts: Date.now() });
    this.gw.publish(`thread:${threadId}`, { type: "event", event: full });
  }
  // Push without persisting (for coalescer deltas; usage is already accumulated above).
  // Unpersisted events take no seq: seq=-1 so the frontend dedupes only by persisted seq,
  // otherwise deltas would push the client's maxSeq up and the following persisted events would be dropped by mistake.
  async pushEvent(threadId, ev) {
    const full = { ...ev, seq: -1, ts: Date.now(), threadId };
    this.gw.publish(`thread:${threadId}`, { type: "event", event: full });
  }
  async recycleIdle() {
    const s = await this.settings.get();
    const limit = (s.idleCloseMinutes ?? 30) * 6e4;
    for (const rt of this.runtimes.values()) {
      if (rt.status === "idle" && rt.pending.size === 0 && Date.now() - rt.lastActivity > limit) {
        log("info", `\u7A7A\u95F2\u56DE\u6536 thread ${rt.threadId}`);
        await this.close(rt.threadId);
      }
    }
  }
};

// daemon/src/git/service.ts
import { execFile as execFile4 } from "node:child_process";
import { existsSync as existsSync10 } from "node:fs";
import { cp, mkdir as mkdir7, readFile as readFile15, rename as rename4, rm, stat as stat9 } from "node:fs/promises";
import { join as join15, normalize as normalize2, sep as sep2 } from "node:path";
var TIMEOUT2 = 15e3;
var DIFF_LIMIT = 1024 * 1024;
function runGit(cwd, args) {
  return new Promise((res) => {
    execFile4("git", ["-c", "core.quotepath=false", ...args], { cwd, timeout: TIMEOUT2, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (e, stdout, stderr) => {
      const code = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
      const missing = e?.code === "ENOENT";
      res({ code, out: String(stdout ?? ""), err: missing ? "\u627E\u4E0D\u5230 git\uFF08\u8BF7\u5148\u5B89\u88C5 git \u5E76\u52A0\u5165 PATH\uFF09" : String(stderr || (e?.message ?? "")) });
    });
  });
}
function insidePath(projectPath, p) {
  const rel = normalize2(p).replace(/\\/g, "/");
  const abs = normalize2(join15(projectPath, rel));
  const proj = normalize2(projectPath);
  if (abs !== proj && !abs.startsWith(proj + sep2)) return null;
  return rel.replace(/\\/g, "/");
}
async function moveAcrossDevices(from, to, ops = {}) {
  const ren = ops.rename ?? rename4;
  try {
    await ren(from, to);
  } catch (e) {
    const code = e?.code;
    if (code !== "EXDEV") throw e;
    await (ops.cp ?? cp)(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await (ops.rm ?? rm)(from, { recursive: true, force: true });
  }
}
var GitService = class {
  // projectPath is resolved from projectId by the caller (the service doesn't know about the store)
  async status(projectPath) {
    const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.out.trim() !== "true") return { isRepo: false };
    const br = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const st = await runGit(projectPath, ["status", "--porcelain=v1", "-z", "-uall"]);
    if (st.code !== 0) return { isRepo: true, branch: br.out.trim() || void 0, error: st.err.trim() || "status \u5931\u8D25" };
    const files = [];
    const parts = st.out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const rec5 = parts[i];
      if (!rec5 || rec5.length < 4) continue;
      const index = rec5[0];
      const worktree = rec5[1];
      let path3 = rec5.slice(3);
      let kind = "modified";
      if (index === "?" && worktree === "?") kind = "untracked";
      else if (index === "R" || worktree === "R") {
        kind = "renamed";
        i++;
      } else if (index === "A" || worktree === "A") kind = "added";
      else if (index === "D" || worktree === "D") kind = "deleted";
      files.push({ path: path3, index, worktree, kind });
    }
    return { isRepo: true, branch: br.out.trim() || void 0, files };
  }
  // Unified diff text; {tooLarge:true} when the diff is > 1MB
  async diff(projectPath, p) {
    const rel = insidePath(projectPath, p);
    if (!rel) return { error: "\u8DEF\u5F84\u4E0D\u5141\u8BB8" };
    const ls = await runGit(projectPath, ["ls-files", "--error-unmatch", "--", rel]);
    if (ls.code !== 0) {
      const full = join15(projectPath, rel);
      if (!existsSync10(full)) return { error: "\u6587\u4EF6\u4E0D\u5B58\u5728" };
      const s = await stat9(full);
      if (!s.isFile()) return { error: "\u4E0D\u662F\u6587\u4EF6" };
      if (s.size > DIFF_LIMIT) return { tooLarge: true };
      const text = await readFile15(full, "utf8").catch(() => null);
      if (text === null) return { error: "\u4E8C\u8FDB\u5236\u6216\u65E0\u6CD5\u8BFB\u53D6" };
      const lines = text.split("\n").map((l) => "+" + l).join("\n");
      return { untracked: true, diff: `--- /dev/null
+++ b/${rel}
@@ -0,0 +1,${text.split("\n").length} @@
${lines}` };
    }
    let d = await runGit(projectPath, ["diff", "--no-color", "--", rel]);
    if (d.code !== 0) return { error: d.err.trim() || "diff \u5931\u8D25" };
    if (!d.out.trim()) {
      d = await runGit(projectPath, ["diff", "--cached", "--no-color", "--", rel]);
      if (d.code !== 0) return { error: d.err.trim() || "diff \u5931\u8D25" };
    }
    if (d.out.length > DIFF_LIMIT) return { tooLarge: true };
    return { diff: d.out };
  }
  // Tracked → git restore; untracked → move to trash/discarded/<ts>/<relpath>
  async discard(projectPath, p, dataDir) {
    const rel = insidePath(projectPath, p);
    if (!rel) return { ok: false, error: "\u8DEF\u5F84\u4E0D\u5141\u8BB8" };
    if (rel === "." || rel === "" || rel === "./") return { ok: false, error: "\u8DEF\u5F84\u4E0D\u5141\u8BB8" };
    const ls = await runGit(projectPath, ["ls-files", "--error-unmatch", "--", rel]);
    if (ls.code === 0) {
      let r = await runGit(projectPath, ["restore", "--staged", "--worktree", "--", rel]);
      if (r.code !== 0) r = await runGit(projectPath, ["checkout", "--", rel]);
      if (r.code !== 0) return { ok: false, error: r.err.trim() || "\u653E\u5F03\u5931\u8D25" };
      return { ok: true };
    }
    const full = join15(projectPath, rel);
    if (!existsSync10(full)) return { ok: false, error: "\u6587\u4EF6\u4E0D\u5B58\u5728" };
    const stamp2 = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = join15(dataDir, "trash", "discarded", stamp2, rel);
    await mkdir7(join15(dest, ".."), { recursive: true });
    try {
      await moveAcrossDevices(full, dest);
    } catch (e) {
      return { ok: false, error: "\u79FB\u52A8\u5931\u8D25\uFF1A" + String(e?.message ?? e) };
    }
    return { ok: true, trashedTo: dest };
  }
};

// daemon/src/files/service.ts
import { readdir as readdir5, readFile as readFile16, stat as stat10 } from "node:fs/promises";
import { join as join16, normalize as normalize3, sep as sep3, extname as extname3 } from "node:path";
import ignore from "ignore";
function decodeText(buf) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
    return { text, encoding: "utf8" };
  } catch {
  }
  try {
    const text = new TextDecoder("gbk", { fatal: true }).decode(buf);
    return { text, encoding: "gbk" };
  } catch {
  }
  return { text: new TextDecoder("utf-8").decode(buf), encoding: "utf8" };
}
var MAX_READ = 1024 * 1024;
var MAX_PER_LEVEL = 2e3;
var ALWAYS_IGNORE = /* @__PURE__ */ new Set([".git", "node_modules"]);
var LANG = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".scss": "scss",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".svg": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".ini": "ini",
  ".sh": "bash",
  ".bash": "bash",
  ".ps1": "powershell",
  ".sql": "sql",
  ".lua": "lua",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".vue": "xml",
  ".svelte": "xml",
  ".dockerfile": "dockerfile",
  ".txt": "plaintext",
  ".log": "plaintext"
};
function insidePath2(projectPath, p) {
  const rel = normalize3(p || ".").replace(/\\/g, "/");
  const abs = normalize3(join16(projectPath, rel));
  const proj = normalize3(projectPath);
  if (abs !== proj && !abs.startsWith(proj + sep3)) return null;
  return rel;
}
var FileService = class {
  // Cache an ignore instance per project (.gitignore changes are picked up on the next daemon restart; acceptable cost)
  // Invalidate by .gitignore mtime: an edited .gitignore takes effect the next time a directory is expanded
  igCache = /* @__PURE__ */ new Map();
  async igFor(projectPath) {
    const gi = join16(projectPath, ".gitignore");
    const st = await stat10(gi).catch(() => null);
    const mtime = st?.isFile() ? st.mtimeMs : -1;
    const hit = this.igCache.get(projectPath);
    if (hit && hit.mtime === mtime) return hit.ig;
    let ig = null;
    if (mtime >= 0) {
      try {
        ig = ignore().add(await readFile16(gi, "utf8"));
      } catch {
        ig = null;
      }
    }
    this.igCache.set(projectPath, { mtime, ig });
    return ig;
  }
  async tree(projectPath, dir) {
    const rel = insidePath2(projectPath, dir);
    if (rel === null) return { error: "\u8DEF\u5F84\u4E0D\u5141\u8BB8" };
    const abs = join16(projectPath, rel);
    const s = await stat10(abs).catch(() => null);
    if (!s?.isDirectory()) return { error: "\u76EE\u5F55\u4E0D\u5B58\u5728" };
    const ig = await this.igFor(projectPath);
    const dirents = await readdir5(abs, { withFileTypes: true }).catch(() => null);
    if (!dirents) return { error: "\u65E0\u6CD5\u8BFB\u53D6\u76EE\u5F55" };
    const out = [];
    for (const d of dirents) {
      if (out.length >= MAX_PER_LEVEL) break;
      const name = d.name;
      if (ALWAYS_IGNORE.has(name)) continue;
      const childRel = rel === "." ? name : `${rel}/${name}`;
      let isDir2 = d.isDirectory();
      if (d.isSymbolicLink()) {
        const st = await stat10(join16(projectPath, childRel)).catch(() => null);
        if (!st) continue;
        isDir2 = st.isDirectory();
      } else if (!d.isFile() && !isDir2) {
        continue;
      }
      if (ig) {
        if (ig.ignores(isDir2 ? childRel + "/" : childRel)) continue;
      }
      out.push({ name, path: childRel, isDir: isDir2 });
    }
    out.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh-CN") : a.isDir ? -1 : 1);
    return { entries: out };
  }
  async read(projectPath, p) {
    const rel = insidePath2(projectPath, p);
    if (rel === null) return { error: "\u8DEF\u5F84\u4E0D\u5141\u8BB8" };
    const abs = join16(projectPath, rel);
    const s = await stat10(abs).catch(() => null);
    if (!s) return { error: "\u6587\u4EF6\u4E0D\u5B58\u5728" };
    if (!s.isFile()) return { error: "\u4E0D\u662F\u6587\u4EF6" };
    if (s.size > MAX_READ) return { tooLarge: true };
    const buf = await readFile16(abs).catch(() => null);
    if (!buf) return { error: "\u65E0\u6CD5\u8BFB\u53D6" };
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return { binary: true };
    const { text, encoding } = decodeText(buf);
    return { text, encoding, language: LANG[extname3(rel).toLowerCase()] ?? "plaintext" };
  }
};

// daemon/src/terminal/service.ts
init_pathscan();
init_log();
import { spawn as spawn3, execFileSync as execFileSync2 } from "node:child_process";
import { accessSync as accessSync2, chmodSync, constants as fsc, existsSync as existsSync11, statSync as statSync6 } from "node:fs";
import { createRequire as moduleRequire } from "node:module";
import { release } from "node:os";
import { dirname as dirname6, join as join17 } from "node:path";
import { StringDecoder } from "node:string_decoder";
var MAX_TERMS_PER_PROJECT = 8;
var BUF_MAX = 2 * 1024 * 1024;
var SNAP_LINES = 5e3;
function isExecFile(file) {
  try {
    accessSync2(file, fsc.X_OK);
    return statSync6(file).isFile();
  } catch {
    return false;
  }
}
function pickShell(o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const find = o.find ?? ((n) => findOnPath(n, { platform, env })[0] ?? null);
  const isExec = o.isExec ?? isExecFile;
  if (platform === "win32") {
    for (const s of ["pwsh", "powershell"]) {
      const hit = find(s);
      if (hit) return hit;
    }
    const sysRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
    const ps = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (isExec(ps)) return ps;
    return env.ComSpec || env.COMSPEC || "cmd.exe";
  }
  if (env.SHELL && env.SHELL.startsWith("/") && isExec(env.SHELL)) return env.SHELL;
  const order = platform === "darwin" ? ["/bin/zsh", "/bin/bash", "/bin/sh"] : ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"];
  for (const s of order) if (isExec(s)) return s;
  return "/bin/sh";
}
function simpleShellArgs(shell, platform = process.platform) {
  if (platform === "win32") {
    if (/(^|[\\/])cmd(\.exe)?$/i.test(shell)) return ["/Q"];
    return ["-NoLogo"];
  }
  return ["-i"];
}
function fixSpawnHelper() {
  if (process.platform !== "darwin") return;
  try {
    const req = moduleRequire(import.meta.url);
    const root = dirname6(req.resolve("node-pty/package.json"));
    for (const sub of [`prebuilds/darwin-${process.arch}`, "build/Release"]) {
      const f = join17(root, sub, "spawn-helper");
      if (existsSync11(f) && !isExecFile(f)) {
        chmodSync(f, 493);
        log("info", "\u5DF2\u4FEE\u590D node-pty spawn-helper \u7684\u53EF\u6267\u884C\u4F4D", { file: f });
      }
    }
  } catch {
  }
}
function conptyInfo() {
  const build = Number(release().split(".")[2]);
  return { backend: "conpty", buildNumber: Number.isFinite(build) ? build : 0 };
}
var nextIndex = 1;
var rid5 = () => "t_" + Math.random().toString(36).slice(2, 10);
var TerminalService = class {
  constructor(gw) {
    this.gw = gw;
    gw.onTerminalInput = (conn, index, op, payload) => this.onInput(conn, index, op, payload);
  }
  gw;
  terms = /* @__PURE__ */ new Map();
  byIndex = /* @__PURE__ */ new Map();
  ptyLib;
  async loadPty() {
    if (this.ptyLib !== void 0) return this.ptyLib;
    try {
      fixSpawnHelper();
      this.ptyLib = await import("node-pty");
    } catch (e) {
      log("warn", "node-pty \u52A0\u8F7D\u5931\u8D25\uFF0C\u7EC8\u7AEF\u9000\u5316\u65E0 PTY \u65B9\u6848", { err: String(e) });
      this.ptyLib = null;
    }
    return this.ptyLib;
  }
  list(projectId) {
    return [...this.terms.values()].filter((t) => !projectId || t.projectId === projectId).map((t) => ({ id: t.id, index: t.index, projectId: t.projectId, title: t.title, alive: t.alive, simple: t.simple }));
  }
  get count() {
    return [...this.terms.values()].filter((t) => t.alive).length;
  }
  async create(projectId, cwd, cols, rows) {
    const alive = [...this.terms.values()].filter((t) => t.projectId === projectId && t.alive);
    if (alive.length >= MAX_TERMS_PER_PROJECT) return { error: `\u6BCF\u4E2A\u9879\u76EE\u6700\u591A ${MAX_TERMS_PER_PROJECT} \u4E2A\u7EC8\u7AEF` };
    const shell = pickShell();
    const term = {
      id: rid5(),
      index: nextIndex++,
      projectId,
      cwd,
      title: `\u7EC8\u7AEF ${alive.length + 1}`,
      alive: true,
      simple: false,
      pty: null,
      proc: null,
      buf: "",
      pend: "",
      timer: null
    };
    const pty = await this.loadPty();
    if (pty) {
      try {
        const p = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols: Math.max(20, cols),
          rows: Math.max(5, rows),
          cwd,
          env: process.env
        });
        term.pty = { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), kill: () => p.kill(), onData: (cb) => p.onData(cb), onExit: (cb) => p.onExit(cb), pid: p.pid };
        term.pty.onData((d) => this.onData(term, d));
        term.pty.onExit(() => this.onExit(term));
      } catch (e) {
        log("warn", "pty.spawn \u5931\u8D25\uFF0C\u9000\u5316\u65E0 PTY \u65B9\u6848", { err: String(e) });
      }
    }
    if (!term.pty) {
      term.simple = true;
      const args = simpleShellArgs(shell);
      const proc = spawn3(shell, args, {
        cwd,
        stdio: "pipe",
        windowsHide: true,
        env: process.env,
        detached: process.platform !== "win32"
      });
      term.proc = proc;
      const outDec = new StringDecoder("utf8");
      const errDec = new StringDecoder("utf8");
      proc.stdout.on("data", (d) => this.onData(term, outDec.write(d)));
      proc.stderr.on("data", (d) => this.onData(term, errDec.write(d)));
      proc.on("exit", () => this.onExit(term));
      proc.on("error", () => this.onExit(term));
    }
    this.terms.set(term.id, term);
    this.byIndex.set(term.index, term);
    return { id: term.id, index: term.index, simple: term.simple };
  }
  attach(id) {
    const t = this.terms.get(id);
    if (!t) return { error: "\u7EC8\u7AEF\u4E0D\u5B58\u5728" };
    const lines = t.buf.split("\n");
    const snapshot = lines.length > SNAP_LINES ? lines.slice(-SNAP_LINES).join("\n") : t.buf;
    const windowsPty = process.platform === "win32" && t.pty ? conptyInfo() : void 0;
    return { index: t.index, snapshot, simple: t.simple, ...windowsPty ? { windowsPty } : {} };
  }
  indexOf(id) {
    return this.terms.get(id)?.index ?? null;
  }
  resize(id, cols, rows) {
    const t = this.terms.get(id);
    if (!t || !t.alive) return { ok: false };
    t.pty?.resize(Math.max(20, cols), Math.max(5, rows));
    return { ok: true };
  }
  kill(id) {
    const t = this.terms.get(id);
    if (!t) return { ok: false };
    this.killTerm(t);
    return { ok: true };
  }
  killAll() {
    for (const t of this.terms.values()) this.killTerm(t, true);
  }
  // ---- internals ----
  // Killing only the shell would orphan the npm run dev etc. it started → on Windows taskkill /T kills the whole tree
  killTree(pid, sync, group) {
    if (!pid) return;
    if (process.platform !== "win32") {
      if (group) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
        }
        const t = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
          }
        }, 1500);
        t.unref?.();
      }
      return;
    }
    const args = ["/pid", String(pid), "/T", "/F"];
    try {
      if (sync) execFileSync2("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: 5e3 });
      else spawn3("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {
      });
    } catch {
    }
  }
  killTerm(t, sync = false) {
    t.alive = false;
    this.killTree(t.pty?.pid ?? t.proc?.pid, sync, !t.pty && !!t.proc);
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    try {
      t.pty?.kill();
    } catch {
    }
    try {
      t.proc?.kill();
    } catch {
    }
    this.terms.delete(t.id);
    this.byIndex.delete(t.index);
  }
  onExit(t) {
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
      if (t.pend) {
        this.gw.publishTerminal(t.index, Buffer.from(t.pend, "utf8"));
        t.pend = "";
      }
    }
    if (t.exited) return;
    t.exited = true;
    t.alive = false;
    this.terms.delete(t.id);
    this.byIndex.delete(t.index);
    this.gw.publish("terminals", { type: "terminal.exit", id: t.id, index: t.index });
  }
  onData(t, d) {
    t.buf += d;
    if (t.buf.length > BUF_MAX) t.buf = t.buf.slice(-BUF_MAX / 2);
    t.pend += d;
    if (!t.timer) {
      t.timer = setTimeout(() => {
        t.timer = null;
        if (t.pend) {
          this.gw.publishTerminal(t.index, Buffer.from(t.pend, "utf8"));
          t.pend = "";
        }
      }, 16);
    }
  }
  // Input frames: op 2=input, 3=resize
  onInput(conn, index, op, payload) {
    const t = this.byIndex.get(index);
    if (!t || !t.alive) return;
    if (!conn.subs.has(`terminal:${index}`)) return;
    if (op === 2) {
      const s = payload.toString("utf8");
      if (t.pty) t.pty.write(s);
      else t.proc?.stdin.write(s);
    } else if (op === 3) {
      try {
        const { cols, rows } = JSON.parse(payload.toString("utf8"));
        if (cols && rows) this.resize(t.id, cols, rows);
      } catch {
      }
    }
  }
};

// daemon/src/util/proc.ts
init_pathscan();
import { delimiter } from "node:path";
function pidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function augmentPath(env, nodeDir, platform = process.platform, home) {
  const win = platform === "win32";
  const sep4 = win ? ";" : platform === process.platform ? delimiter : ":";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const cur = (env[key] ?? "").split(sep4).filter(Boolean);
  const norm = (d) => win ? d.replace(/[\\/]+$/, "").toLowerCase() : d.replace(/\/+$/, "");
  const seen = new Set(cur.map(norm));
  const out = [...cur];
  for (const d of [nodeDir, ...extraBinDirs({ platform, env, home })]) {
    if (!d || seen.has(norm(d))) continue;
    seen.add(norm(d));
    out.push(d);
  }
  return out.join(sep4);
}

// daemon/src/main.ts
var nodeMajor = Number(/^v?(\d+)/.exec(process.versions.node ?? "")?.[1] ?? 0);
if (nodeMajor < 20) {
  console.error(`[agent-console] \u9700\u8981 Node.js 20 \u6216\u66F4\u9AD8\u7248\u672C\uFF0C\u5F53\u524D ${process.version}\uFF08${process.execPath}\uFF09`);
  process.exit(3);
}
process.env.PATH = augmentPath(process.env, dirname7(process.execPath));
var cfg = parseConfig(process.argv.slice(2));
process.on("uncaughtException", (e) => {
  log("error", "uncaughtException", { err: String(e?.stack ?? e) });
});
process.on("unhandledRejection", (e) => {
  log("error", "unhandledRejection", { err: String(e) });
});
async function main() {
  initLog(cfg.dataDir);
  for (const d of ["threads", "attachments", "trash", "logs"]) {
    mkdirSync2(join19(cfg.dataDir, d), { recursive: true });
  }
  const appDir = join19(dirname7(fileURLToPath3(import.meta.url)), "..", "..", "app");
  const attachments = new AttachmentStore(join19(cfg.dataDir, "attachments"));
  const { bindAttachmentStore: bindAttachmentStore2 } = await Promise.resolve().then(() => (init_attachmentRefs(), attachmentRefs_exports));
  bindAttachmentStore2(attachments);
  const settings = new SettingsStore(cfg.dataDir);
  const projects = new ProjectsStore(cfg.dataDir);
  const threads = new ThreadsStore(cfg.dataDir);
  const gateway = new Gateway(cfg);
  initProviders(cfg.version);
  const { migrateLegacy: migrateLegacy2 } = await Promise.resolve().then(() => (init_legacy(), legacy_exports));
  try {
    await migrateLegacy2(cfg.dataDir, { settings, projects, threads });
  } catch (e) {
    log("error", "\u65E7\u6570\u636E\u8FC1\u79FB\u5931\u8D25", { err: String(e) });
  }
  const manager = new AgentManager(gateway, threads, projects, settings, attachments);
  await manager.recoverOnStart();
  const terminals = new TerminalService(gateway);
  registerMethods(gateway, {
    cfg,
    settings,
    gateway,
    projects,
    threads,
    manager,
    git: new GitService(),
    files: new FileService(),
    terminals,
    runtime: (id) => manager.runtimeInfo(id)
  });
  const server = createHttpServer(cfg, appDir, attachments, {
    onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head)
  });
  let attempts = 0;
  await new Promise((resolveListen, rejectListen) => {
    const tryListen = () => {
      attempts++;
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && attempts < 6) {
          log("warn", `\u7AEF\u53E3 ${cfg.port} \u88AB\u5360\u7528\uFF0C500ms \u540E\u91CD\u8BD5\uFF08\u7B2C ${attempts} \u6B21\uFF09`);
          setTimeout(tryListen, 500);
        } else {
          rejectListen(e);
        }
      });
      server.listen(cfg.port, "127.0.0.1");
    };
    server.once("listening", () => resolveListen());
    tryListen();
  }).catch((e) => {
    log("error", `\u7AEF\u53E3 ${cfg.port} \u65E0\u6CD5\u76D1\u542C`, { err: String(e) });
    process.exit(2);
  });
  const bound = server.address();
  if (bound && typeof bound === "object") cfg.port = bound.port;
  process.stdout.write(JSON.stringify({ agentConsoleReady: true, port: cfg.port, pid: process.pid }) + "\n");
  void (async () => {
    const { warmProviderCache: warmProviderCache2 } = await Promise.resolve().then(() => (init_warm(), warm_exports));
    await warmProviderCache2(await settings.get());
  })().catch((e) => log("warn", "Provider \u9884\u70ED\u5931\u8D25", { err: String(e) }));
  const daemonJsonPath = join19(cfg.dataDir, "daemon.json");
  await writeJsonAtomic(daemonJsonPath, {
    pid: process.pid,
    port: cfg.port,
    token: cfg.token,
    version: cfg.version,
    buildStamp: cfg.buildStamp,
    startedAt: Date.now()
  });
  chmodSync2(daemonJsonPath, 384);
  log("info", `daemon \u5DF2\u542F\u52A8 \u7AEF\u53E3 ${cfg.port} \u6570\u636E\u76EE\u5F55 ${cfg.dataDir} \u7248\u672C ${cfg.version} pid ${process.pid}`);
  if (!cfg.parentPid) console.log(`[agent-console] \u6253\u5F00 http://127.0.0.1:${cfg.port}/#t=${cfg.token}`);
  let idleSince = Date.now();
  setInterval(() => {
    const busy = gateway.connectionCount > 0 || manager.anyBusy() || terminals.count > 0;
    if (busy) idleSince = Date.now();
    if (Date.now() - idleSince > cfg.idleExitMinutes * 60 * 1e3) {
      log("info", "\u7A7A\u95F2\u8D85\u65F6\uFF0Cdaemon \u9000\u51FA");
      shutdown(0);
    }
  }, 60 * 1e3).unref();
  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "daemon \u5173\u95ED\u4E2D");
    terminals.killAll();
    gateway.closeAll();
    try {
      rmSync2(daemonJsonPath, { force: true });
    } catch {
    }
    const sessionsClosed = Promise.race([manager.shutdown(), new Promise((r) => setTimeout(r, 2500))]);
    void sessionsClosed.then(() => server.close(() => process.exit(code)));
    setTimeout(() => process.exit(code), 4e3).unref();
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  if (cfg.parentPid) {
    const parentPid = cfg.parentPid;
    const parentWatch = setInterval(() => {
      if (!pidAlive(parentPid)) {
        clearInterval(parentWatch);
        log("info", `\u7236\u8FDB\u7A0B ${parentPid} \u5DF2\u9000\u51FA\uFF0Cdaemon \u8DDF\u968F\u9000\u51FA`);
        shutdown(0);
      }
    }, 2e3);
    parentWatch.unref();
    process.stdin.on("end", () => shutdown(0));
    process.stdin.on("close", () => shutdown(0));
    process.stdin.on("error", () => shutdown(0));
    process.stdin.resume();
  }
}
main().catch((e) => {
  console.error("[agent-console] \u542F\u52A8\u5931\u8D25", e);
  process.exit(1);
});
//# sourceMappingURL=main.js.map
