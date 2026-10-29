// What the page shows, worked out from live.js (globalThis.AgentOfficeLive,
// written by the plugin's host part) without the DOM, so a test can check
// it. A classic script: it sets globalThis.AgentOfficeModel.
//
// A session from an agent's own files says its phase outright (thinking,
// tool, approval, ask, done, aborted, error); the page only adds that a
// session whose file has not moved for a long while, mid-turn, is stuck.
// A session only the gateway saw (an agent whose files aren't read) is
// worked out from its requests, as before.
(() => {
  const TEXT = {
    en: {
      title: "What are my agents doing", needYou: "Need you", working: "Working", doneN: "Done",
      office: "Office", list: "List", pip: "Picture in picture", settings: "Settings",
      thinking: "Thinking", executing: "Running tools", replying: "Replying", waiting: "Waiting for you",
      done: "Done", error: "Error", stopped: "Stopped", idle: "Idle",
      approval: "Waiting for your approval", ask: "Asked you something", stuck: "No word for {n}",
      copyResume: "Copy resume command", copySession: "Copy session id", copied: "Copied",
      justNow: "just now", sAgo: "{n}s ago", mAgo: "{n} min ago", hAgo: "{n} h ago", dAgo: "{n} d ago",
      empty: "No agent has been at work in the last two days. Start Claude Code, Codex, DeepSeek Harness, Gemini CLI… and it walks in here.",
      noFile: "Starting… the plugin reads your agents' sessions in magpie's plugin host.",
      demo: "Sample agents", showDone: "Show finished agents", showText: "Show prompts and replies",
      hideAfter: "Leave the office after", h1: "1 hour", h6: "6 hours", h24: "24 hours", never: "Never",
      demoOn: "Showing sample agents", turns: "{n} turns", noPrompt: "(no prompt)",
      project: "Folder", model: "Model", status: "Status", task: "Task", last: "Last active", agent: "Agent",
      quiet: "Text off: only statuses are kept",
      floating: "The office has its own window here: move it, reshape it, or ✕ it to put it back",
      pipOn: "Put it back", ran: "running {n}", via: "seen through magpie's gateway", fromFiles: "from its own session file",
      live: "live", stale: "Last update {n}",
    },
    zh: {
      title: "我的 Agent 在干嘛", needYou: "需要你", working: "工作中", doneN: "已完成",
      office: "办公室", list: "列表", pip: "画中画", settings: "设置",
      thinking: "思考中", executing: "执行中", replying: "回复中", waiting: "等你回应",
      done: "已完成", error: "错误", stopped: "已中断", idle: "摸鱼中",
      approval: "等你批准", ask: "在问你问题", stuck: "已 {n} 没有动静",
      copyResume: "复制续接命令", copySession: "复制会话 ID", copied: "已复制",
      justNow: "刚刚", sAgo: "{n}秒前", mAgo: "{n}分钟前", hAgo: "{n}小时前", dAgo: "{n}天前",
      empty: "最近两天没有 Agent 在干活。打开 Claude Code、Codex、DeepSeek Harness、Gemini CLI……它就会走进这间办公室。",
      noFile: "正在启动……插件在 magpie 的插件宿主里读取各个 Agent 的会话。",
      demo: "示例 Agent", showDone: "显示已完成的 Agent", showText: "显示提问和回复",
      hideAfter: "多久后离开办公室", h1: "1 小时", h6: "6 小时", h24: "24 小时", never: "从不",
      demoOn: "正在显示示例 Agent", turns: "{n} 轮", noPrompt: "（没有提问）",
      project: "目录", model: "模型", status: "状态", task: "任务", last: "最近活动", agent: "Agent",
      quiet: "已关闭文本：只记录状态",
      floating: "办公室在这里的小窗中：可拖动、可缩放，点 ✕ 放回去",
      pipOn: "放回去", ran: "已运行 {n}", via: "经 magpie 网关看到", fromFiles: "来自它自己的会话文件",
      live: "实时", stale: "最近更新 {n}",
    },
  }
  // the six the page draws, in the legend's order
  const STATUSES = ["thinking", "executing", "replying", "waiting", "done", "error"]
  const COLORS = { thinking: "#8b6cf6", executing: "#3b82f6", replying: "#10b981", waiting: "#f59e0b", done: "#22a35a", error: "#ef4444", idle: "#9ca3af" }
  const HIDE = { "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3, never: Infinity }
  const DEFAULTS = { mode: "office", dim: "3d", demo: false, showDone: true, hideAfter: "6h", approvalAfterSec: 90 }
  // a turn whose file hasn't moved this long is stuck, not working
  const STUCK_MS = 10 * 60e3

  function text(lang) {
    return String(lang || "").toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en
  }
  function fill(s, n) { return String(s).replace("{n}", n) }

  function hash(s) {
    let h = 2166136261
    for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619)
    return h >>> 0
  }

  // an agent as magpie names it, with its own icon (page/agents.js)
  function brand(agent) {
    const all = globalThis.AgentOfficeAgents || {}
    const id = String(agent || "agent")
    const a = all[id] || all[id.replace(/-cli$/, "")] || null
    const color = a?.color || `hsl(${hash(id) % 360} 55% 45%)`
    return { id, name: a?.name || id, icon: a?.icon || "", color }
  }

  // { status, sub }: status one of STATUSES; sub says more (approval, ask,
  // stopped, stuck) for the card and the list
  function state(s, now, opts = {}) {
    if (s.source === "files" || s.phase) {
      const quiet = now - (s.touched || s.updated || now)
      switch (s.phase) {
        case "approval": return { status: "waiting", sub: "approval" }
        case "ask": return { status: "waiting", sub: "ask" }
        case "error": return { status: "error", sub: "" }
        case "aborted": return { status: "done", sub: "stopped" }
        case "done": return { status: "done", sub: "" }
        case "tool": return quiet > STUCK_MS ? { status: "error", sub: "stuck" } : { status: "executing", sub: "" }
        case "thinking": default:
          if (quiet > STUCK_MS) return { status: "error", sub: "stuck" }
          // a reply being written: the model has the word and the file moves
          return { status: s.reply && quiet < 4000 ? "replying" : "thinking", sub: "" }
      }
    }
    // only the gateway saw it: from its requests
    const approval = (Number(opts.approvalAfterSec) || DEFAULTS.approvalAfterSec) * 1000
    if (s.inflight > 0) return { status: now - (s.inflightSince || now) > 8000 ? "replying" : "thinking", sub: "" }
    const l = s.last
    if (!l) return { status: "thinking", sub: "" }
    if (l.outcome === "error") return { status: "error", sub: "" }
    if (l.outcome === "ask") return { status: "waiting", sub: "ask" }
    if (l.outcome === "tools") return now - l.at > approval ? { status: "waiting", sub: "approval" } : { status: "executing", sub: "" }
    return { status: "done", sub: "" }
  }
  function status(s, now, opts) { return state(s, now, opts).status }

  function ago(ms, lang) {
    const t = text(lang)
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 10) return t.justNow
    if (s < 60) return fill(t.sAgo, s)
    if (s < 3600) return fill(t.mAgo, Math.floor(s / 60))
    if (s < 86400) return fill(t.hAgo, Math.floor(s / 3600))
    return fill(t.dAgo, Math.floor(s / 86400))
  }

  // 45 000 → "45s"; 130 000 → "2m 10s"; 3 900 000 → "1h 5m"
  function duration(ms, lang) {
    const zh = text(lang) === TEXT.zh
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return zh ? s + "秒" : s + "s"
    const m = Math.floor(s / 60), r = s % 60
    if (m < 60) return zh ? `${m}分${r ? r + "秒" : ""}` : `${m}m${r ? " " + r + "s" : ""}`
    const h = Math.floor(m / 60), mm = m % 60
    return zh ? `${h}小时${mm ? mm + "分" : ""}` : `${h}h${mm ? " " + mm + "m" : ""}`
  }

  function shellQuote(s) {
    return /^[A-Za-z0-9._:@%+=/-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
  }

  // the command that picks the session up again, where the agent has one
  function resume(s) {
    const id0 = String(s.session || "")
    if (!id0 || id0.startsWith("cwd:") || id0.startsWith("model:")) return ""
    const id = shellQuote(id0)
    const cd = s.cwd ? `cd ${shellQuote(s.cwd)} && ` : ""
    switch (s.agent) {
      case "claude": return `${cd}claude --resume ${id}`
      case "codex": return `${cd}codex resume ${id}`
      case "opencode": return `${cd}opencode --session ${id}`
      case "gemini": return `${cd}gemini --resume ${id}`
      case "qwen": return `${cd}qwen --resume ${id}`
      case "pi": return `${cd}pi --session ${id}`
      case "dsh": return `${cd}dsh --resume ${shellQuote(id0.replace(/^session-/, ""))}`
      default: return ""
    }
  }

  // the agents to draw: [{ key, agent, brand, title, status, sub, at, … }]
  function agents(snap, now, opts = {}) {
    const o = { ...DEFAULTS, ...opts }
    const hide = HIDE[o.hideAfter] ?? HIDE["6h"]
    const out = []
    for (const s of Array.isArray(snap?.sessions) ? snap.sessions : []) {
      if (!s || typeof s.key !== "string") continue
      const { status: st, sub } = state(s, now, o)
      const at = Math.max(s.updated || 0, s.touched || 0, s.last?.at || 0)
      const quiet = now - at
      if ((st === "done" || st === "error") && quiet > hide) continue
      if (st === "done" && !o.showDone) continue
      const b = brand(s.agent)
      // how long the current step has gone on
      const since = s.pendingSince ? now - s.pendingSince : quiet
      out.push({
        key: s.key, agent: s.agent, brand: b, session: s.session || "", status: st, sub, source: s.source || "gateway",
        idle: st === "done" && quiet > 20 * 60e3,
        title: s.title || s.project || b.name, project: s.project || "", cwd: s.cwd || "",
        query: s.query || "", step: s.step || s.last?.step || "", reply: s.reply || s.last?.text || "", error: s.error || "",
        model: s.model || "", at, since, started: s.started || at, turns: s.turns || 0,
        resume: resume(s), seed: hash(s.key),
      })
    }
    return out
  }

  function counts(list) {
    const c = { needYou: 0, working: 0, done: 0 }
    for (const a of list) {
      // an agent that failed or stalled needs you as much as one that asked
      if (a.status === "waiting" || a.status === "error") c.needYou++
      else if (a.status === "thinking" || a.status === "executing" || a.status === "replying") c.working++
      else if (a.status === "done") c.done++
    }
    return c
  }

  // the list's order: what needs you, what works, then the rest, latest first
  const RANK = { waiting: 0, error: 1, thinking: 2, executing: 2, replying: 2, done: 3 }
  function sorted(list) {
    return list.slice().sort((a, b) => (RANK[a.status] - RANK[b.status]) || (b.at - a.at))
  }

  // the page's own side of text off: whatever live.js holds, no prompt,
  // reply, error or tool argument is shown. A tool step keeps its name only.
  function redact(list) {
    return list.map((a) => {
      const step = String(a.step || "")
      const name = step.includes(" · ") ? step.split(" · ")[0]
        : /^[A-Za-z0-9_.-]{1,40}$/.test(step) ? step : ""
      return { ...a, title: a.project || a.brand?.name || a.agent || "", query: "", reply: "", error: "", step: name }
    })
  }

  // what the page draws: what the host wrote, and, with sample agents on,
  // theirs beside it — never instead of it
  function merge(real, demo) {
    const sessions = [...(Array.isArray(real?.sessions) ? real.sessions : []), ...(Array.isArray(demo?.sessions) ? demo.sessions : [])]
    return { ...(real || {}), sessions, demo: true }
  }

  // sample agents, for a first look (Settings › Sample agents)
  function demo(now) {
    const m = 60e3
    const S = (agent, session, cwd, title, query, model, phase, extra) => ({
      key: `demo|${agent}|${session}`, source: "files", agent, session, cwd, project: cwd.split("/").pop(), title, query, model,
      started: now - 50 * m, updated: now - 1000, touched: now - 1000, phase, turns: 3, ...extra,
    })
    return { v: 2, written: now, text: true, demo: true, sessions: [
      S("codex", "demo-1", "/Users/me/blog", "封面图", "用 punk skill 生成文章封面", "gpt-6-astra", "done",
        { touched: now - 28 * m, updated: now - 28 * m, step: "image_gen · cover.png", reply: "已用内置生图完成「方块世界」封面，PNG · 1600×900，放进 assets/cover.png。" }),
      S("claude", "demo-2", "/Users/me/oh-my-x", "oh-my-x", "给 CLI 加一个 --json 输出", "claude-opus-5", "tool",
        { touched: now - 3000, pendingSince: now - 42000, step: "Bash · bun test" }),
      S("claude", "demo-3", "/Users/me/x", "X 选题", "下周发什么？给我 5 个选题", "claude-sonnet-5", "ask",
        { touched: now - 2 * m, step: "AskUserQuestion · 工具测评还是工作流？", reply: "我列了 5 个方向。你更想写工具测评，还是写自己的工作流？" }),
      S("dsh", "demo-4", "/Users/me/site", "站点部署", "部署到 Cloudflare Pages", "deepseek-flash", "approval",
        { touched: now - 40000, step: "bash · wrangler pages deploy ./dist" }),
      S("gemini", "demo-5", "/Users/me/music", "自动修歌", "把副歌的节拍对齐到 120 BPM", "gemini-3-pro", "thinking",
        { touched: now - 1500, reply: "" }),
      S("qwen", "demo-6", "/Users/me/notes", "工具整理", "整理这周收藏的工具和思路", "qwen3-coder", "done",
        { touched: now - 40 * m, updated: now - 40 * m, reply: "整理好了：12 个工具、5 条思路，按「写作 / 编程 / 效率」分组写进 weekly.md。" }),
      S("codex", "demo-7", "/Users/me/app", "支付接入", "接入 Stripe 订阅", "gpt-6.1-terra", "error",
        { touched: now - 6 * m, error: "429: usage limit reached", step: "exec · npm run test:e2e" }),
    ] }
  }

  globalThis.AgentOfficeModel = { TEXT, STATUSES, COLORS, DEFAULTS, HIDE, STUCK_MS, text, fill, hash, brand, state, status, ago, duration, resume, agents, counts, sorted, demo, merge, redact }
})()
