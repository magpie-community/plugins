// Task texts carrying the words and shapes a keyword rule would look for. The highest rule says none of them may change anything: with the
// same answer from the model, every one of these routes exactly like BASE_TASK. Add a word here when a new keyword rule is imagined.
export const BASE_TASK = "Rename foo to bar in util.py.";

const WORDS = [
  // loops and pace
  "抢票", "秒杀", "挂机", "盯盘", "直播间", "flash sale", "order book", "polling", "game", "real-time",
  // fast requests and urgency
  "urgent", "URGENT", "加急", "asap", "紧急", "尽快", "fast mode", "not urgent",
  // multi_task
  "同时", "并且", "另外", "and also", "both", "as well as",
  // read-only review: access, read_only_review
  "review", "Review", "审查", "只读审查", "audit", "read-only", "(read-only)", "independent review", "diagnose", "诊断", "do not change any code",
  // short follow-ups
  "继续", "好的", "按这个改", "ok", "lgtm", "continue", "go ahead", "ship it",
  // compaction
  "/compact", "<compact_instruction>", "Summarize the conversation so far", "Provide a detailed summary of the conversation so far",
  // needs_gui, needs_visual, local_only
  "screenshot", "image", "图片", "截图", "设计稿", "figma", "mockup", "visual diff", "click the", "点击", "用鼠标", "operate the browser",
  "D:/work/x", "localhost", "pytest", "worktree", "public web",
  // reasoning_depth and the demand on each category
  "prove", "formal proof", "形式化证明", "architecture", "架构", "refactor", "重构", "deadlock", "死锁", "race condition", "root cause", "根因",
  "brainstorm", "头脑风暴", "发散", "creative", "first principles", "whole repository", "cross-module", "跨模块", "分布式",
  // work_kind
  "bug", "修复", "fix ", "translate", "翻译", "web research", "backtest", "回测", "runbook", "checklist", "巡检", "deploy", "react", "css", "前端",
  "batch rename", "codemod", "批量", "explore", "调研", "standalone", "algorithm", "migration plan",
];

export const KEYWORD_CORPUS = [
  ...WORDS.map((word) => `${BASE_TASK} ${word}`),
  ...WORDS.map((word) => `${word} ${BASE_TASK}`),
  ...WORDS,
  // Shapes: a question, a list, a heading, a code file, nearly nothing, and a long brief.
  "What is a mutex?",
  "什么是互斥锁？",
  "1. Fix the parser\n2. Translate the docs\n3. Ship the release",
  "- Fix the parser\n- Translate the docs",
  "Task 1: Fix the parser.\nTask 2: Translate the docs.",
  "# Task\n\n## Step one\n\n- a\n- b\n",
  "Click the Save button handler in settings.tsx is broken",
  "x",
  "x".repeat(39),
  "x".repeat(96),
  "x".repeat(240),
  `${"line\n".repeat(4)}${"x".repeat(300)}`,
  "x".repeat(15000),
  `抢票 urgent 同时 review ${"x".repeat(14000)} ?`,
].filter((text) => text !== BASE_TASK);
