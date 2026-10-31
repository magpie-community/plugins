import { expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { appleScriptQuote, buildJumpPlan, createJumper, parseHerdrPanes, parsePs, parseTmuxPanes, resolveTarget, validTty, walkAncestors } from "./lib/jump.mjs"

const dir = import.meta.dir
const scope = {}
new Function("globalThis", readFileSync(join(dir, "page", "agents.js"), "utf8"))(scope)
new Function("globalThis", readFileSync(join(dir, "page", "model.js"), "utf8"))(scope)
const M = scope.AgentOfficeModel

const SAMPLE_PS = [
  "  100     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2 /Applications/iTerm.app/Contents/MacOS/iTerm2",
  "  101   100 ttys004  -zsh -zsh",
  "  102   101 ttys004  claude claude --resume s-iterm",
  "  200     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
  "  201   200 ttys008  -zsh -zsh",
  "  202   201 ttys008  tmux tmux new -s dev",
  "  203     1 ??       tmux tmux -s dev",
  "  204   203 ttys009  -zsh -zsh",
  "  205   204 ttys009  claude claude",
  "  300     1 ??       /Users/me/.local/bin/herdr /Users/me/.local/bin/herdr server",
  "  301   300 ttys016  -zsh -zsh",
  "  302   301 ttys016  claude claude",
  "  400     1 ??       /Applications/Otty.app/Contents/MacOS/Otty /Applications/Otty.app/Contents/MacOS/Otty",
  "  401   400 ttys001  -zsh -zsh",
  "  402   401 ttys001  herdr herdr",
  "  500     1 ??       /Users/me/.local/bin/herdr-core /Users/me/.local/bin/herdr-core hold --socket /tmp/h.sock",
  "  501   500 ttys012  /bin/zsh /bin/zsh -l",
  "  502   501 ttys012  herdr herdr",
  "  600     1 ??       /Applications/Alacritty.app/Contents/MacOS/alacritty /Applications/Alacritty.app/Contents/MacOS/alacritty",
  "  601   600 ttys020  -zsh -zsh",
  "  602   601 ttys020  claude claude",
  "  700     1 ??       /Applications/Cursor.app/Contents/MacOS/Cursor /Applications/Cursor.app/Contents/MacOS/Cursor",
  "  701   700 ttys021  -zsh -zsh",
  "  702   701 ttys021  claude claude",
].join("\n")

const BINS = {
  herdr: "/usr/local/bin/herdr",
  herdrApp: "/usr/local/bin/herdr-app",
  ottyCli: "/Applications/Otty.app/Contents/MacOS/otty-cli",
  tmux: "/opt/homebrew/bin/tmux",
  osascript: "/usr/bin/osascript",
  open: "/usr/bin/open",
}

test("parsePs and walkAncestors find the controlling tty and outer terminal app", () => {
  const procs = parsePs(SAMPLE_PS)
  expect(walkAncestors(102, procs)).toMatchObject({
    tty: "/dev/ttys004",
    ttyShort: "ttys004",
    inHerdr: false,
    inTmux: false,
    app: { id: "iterm2", kind: "iterm2", app: "iTerm2", bundleId: "com.googlecode.iterm2" },
  })
  expect(walkAncestors(302, procs)).toMatchObject({
    tty: "/dev/ttys016",
    ttyShort: "ttys016",
    inHerdr: true,
  })
})

test("resolveTarget and buildJumpPlan focus iTerm2, Terminal.app and tmux panes", () => {
  const procs = parsePs(SAMPLE_PS)
  const tmuxByTty = parseTmuxPanes("%3\t/dev/ttys009\tdev\t2\n", "/dev/ttys008\t202\tdev\n")
  const liveFiles = new Map([
    ["s-iterm", { pid: 102, alive: true, sessionId: "s-iterm", entrypoint: "cli" }],
    ["s-tmux", { pid: 205, alive: true, sessionId: "s-tmux", entrypoint: "cli" }],
  ])
  const state = { platform: "darwin", liveFiles, procs, tmuxByTty }

  const itermTarget = resolveTarget({ session: "s-iterm" }, state)
  expect(itermTarget).toMatchObject({ kind: "iterm2", badge: "iTerm2 · ttys004", tty: "/dev/ttys004" })
  const itermPlan = buildJumpPlan({ session: "s-iterm" }, state, BINS)
  expect(itermPlan.ok).toBe(true)
  expect(itermPlan.steps[0].cmd).toBe("/usr/bin/osascript")
  expect(itermPlan.steps[0].args[1]).toContain('else if "/dev/ttys004" is not "" and (tty of aSess as text) is "/dev/ttys004" then')

  const tmuxTarget = resolveTarget({ session: "s-tmux" }, state)
  expect(tmuxTarget).toMatchObject({ kind: "tmux", badge: "Terminal · %3", tmuxPane: "%3", tmuxWindow: "dev:2", clientTty: "/dev/ttys008", outerKind: "terminal" })
  const tmuxPlan = buildJumpPlan({ session: "s-tmux" }, state, BINS)
  expect(tmuxPlan.steps.map((x) => x.desc)).toEqual([
    "tmux select-window -t dev:2",
    "tmux select-pane -t %3",
    "osascript Terminal select (/dev/ttys008)",
  ])
  expect(tmuxPlan.steps[2].args[1]).toContain('if (tty of aTab as text) is "/dev/ttys008" then')
})

test("a request carrying its own target or cwd in options gets no steps from it", async () => {
  const procs = parsePs(SAMPLE_PS)
  const liveFiles = new Map([
    ["s-cursor", { pid: 702, alive: true, sessionId: "s-cursor", entrypoint: "cli" }],
  ])
  const state = { platform: "darwin", liveFiles, procs }
  const jumper = createJumper({ state })

  // 1. Unknown session with an injected AppleScript tty payload in req.target
  const injectedTtyReq = {
    session: "non-existent",
    target: {
      kind: "iterm2",
      tty: 'x" then\ndo shell script "touch ~/runs/pwned552"\nend if\nif "a" is "b',
    },
  }
  expect(buildJumpPlan(injectedTtyReq, state, BINS)).toEqual({ ok: false, reason: "no_target", target: null, steps: [] })
  expect(await jumper.jump(injectedTtyReq, true)).toEqual({ ok: false, reason: "no_target", target: null, steps: [] })

  // 2. Unknown session with an injected IDE bundleId + cwd payload in req.target
  const injectedIdeReq = {
    session: "non-existent",
    cwd: "/Users/me/Downloads/run.command",
    target: {
      kind: "ide",
      bundleId: "com.apple.Terminal",
    },
  }
  expect(buildJumpPlan(injectedIdeReq, state, BINS)).toEqual({ ok: false, reason: "no_target", target: null, steps: [] })
  expect(await jumper.jump(injectedIdeReq, true)).toEqual({ ok: false, reason: "no_target", target: null, steps: [] })

  // 3. Real IDE session ignores req.target and never passes req.cwd to `open -b`
  const cursorPlan = buildJumpPlan({
    session: "s-cursor",
    cwd: "/Users/me/Downloads/run.command",
    target: { kind: "terminal", tty: 'x" then\ndo shell script "pwn"\n' },
  }, state, BINS)
  expect(cursorPlan.ok).toBe(true)
  expect(cursorPlan.steps).toEqual([
    { cmd: "/usr/bin/open", args: ["-b", "com.todesktop.230313mzl4w4u92"], desc: "open -b com.todesktop.230313mzl4w4u92" },
  ])

  expect(validTty("/dev/ttys004")).toBe(true)
  expect(validTty("/dev/pts/8")).toBe(false)
  expect(validTty('x" then do shell script "y"')).toBe(false)
  expect(appleScriptQuote('a"b\\c\nd')).toBe('a\\"b\\\\cd')
})

test("Linux and unrecognized macOS terminals resolve to null instead of Terminal.app", () => {
  const procs = parsePs(SAMPLE_PS)
  const liveFiles = new Map([
    ["s-iterm", { pid: 102, alive: true, sessionId: "s-iterm", entrypoint: "cli" }],
    ["s-alacritty", { pid: 602, alive: true, sessionId: "s-alacritty", entrypoint: "cli" }],
  ])
  expect(resolveTarget({ session: "s-iterm" }, { platform: "linux", liveFiles, procs })).toBeNull()
  expect(resolveTarget({ session: "s-alacritty" }, { platform: "darwin", liveFiles, procs })).toBeNull()
})

test("Herdr sessions expose all attached hosts (Herdr.app, Otty) and switch between them", () => {
  const procs = parsePs(SAMPLE_PS)
  const herdrJson = JSON.stringify({
    result: {
      panes: [
        { pane_id: "wM:p8C", tab_id: "wM:t73", workspace_id: "wM", cwd: "/Users/me/repo", agent_session: { value: "s-herdr" } },
      ],
    },
  })
  const { bySession: herdrBySession, byCwd: herdrByCwd } = parseHerdrPanes(herdrJson)
  const herdrHosts = [
    { id: "herdr-app", app: "Herdr.app", bundleId: "dev.herdr.app", herdrAppSpace: "sp1", herdrAppTab: "tb1" },
    { id: "otty", app: "Otty", bundleId: "io.appmakes.otty", ottyPane: "p_1" },
  ]
  const liveFiles = new Map([["s-herdr", { pid: 302, alive: true, sessionId: "s-herdr", entrypoint: "cli" }]])
  const state = { platform: "darwin", liveFiles, procs, herdrBySession, herdrByCwd, herdrHosts }
  const target = resolveTarget({ session: "s-herdr" }, state)
  expect(target.kind).toBe("herdr")
  expect(target.badge).toBe("Herdr.app · wM:p8C")
  expect(target.hosts.map((h) => h.id)).toEqual(["herdr-app", "otty"])

  const planHerdrApp = buildJumpPlan({ session: "s-herdr", preferredHostId: "herdr-app" }, state, BINS)
  expect(planHerdrApp.steps.map((x) => x.desc)).toEqual([
    "herdr workspace focus wM",
    "herdr tab focus wM:t73",
    "herdr agent focus wM:p8C",
    "open -b dev.herdr.app",
  ])

  const planOtty = buildJumpPlan({ session: "s-herdr", preferredHostId: "otty" }, state, BINS)
  expect(planOtty.steps.map((x) => x.desc)).toEqual([
    "herdr workspace focus wM",
    "herdr tab focus wM:t73",
    "herdr agent focus wM:p8C",
    "otty-cli pane focus p_1",
    "open -b io.appmakes.otty",
  ])
})

test("Claude Desktop sessions jump via claude://resume deep link", () => {
  const desktopIdx = new Map([["cli-1", "local_abc123"]])
  const state = { platform: "darwin", desktopIdx }
  const target = resolveTarget({ session: "cli-1" }, state)
  expect(target).toMatchObject({ kind: "claude-desktop", badge: "Claude Desktop", hostSessionId: "local_abc123" })
  const plan = buildJumpPlan({ session: "cli-1" }, state, BINS)
  expect(plan.steps.map((x) => x.desc)).toEqual([
    "open claude://resume?session=local_abc123",
    "open -b com.anthropic.claudefordesktop",
  ])
})

test("page/model.js preserves session target metadata and target fields match page/app.js", () => {
  const now = 1_000_000
  const procs = parsePs(SAMPLE_PS)
  const herdrJson = JSON.stringify({
    result: { panes: [{ pane_id: "wM:p8C", tab_id: "wM:t73", workspace_id: "wM", cwd: "/Users/me/repo", agent_session: { value: "s-herdr" } }] },
  })
  const { bySession: herdrBySession, byCwd: herdrByCwd } = parseHerdrPanes(herdrJson)
  const herdrHosts = [
    { id: "herdr-app", app: "Herdr.app", bundleId: "dev.herdr.app" },
    { id: "otty", app: "Otty", bundleId: "io.appmakes.otty" },
  ]
  const liveFiles = new Map([["s-herdr", { pid: 302, alive: true, sessionId: "s-herdr", entrypoint: "cli" }]])
  const target = resolveTarget({ session: "s-herdr" }, { platform: "darwin", liveFiles, procs, herdrBySession, herdrByCwd, herdrHosts })
  expect(target.label).toBe("Herdr.app · wM:p8C")
  expect(target.badge).toBe("Herdr.app · wM:p8C")
  expect(target.paneId).toBe("wM:p8C")
  expect(target.hosts.map((h) => [h.id, h.label, h.app])).toEqual([
    ["herdr-app", "Herdr.app", "Herdr.app"],
    ["otty", "Otty", "Otty"],
  ])

  const [a] = M.agents({ sessions: [{ key: "claude|s-herdr", source: "files", agent: "claude", session: "s-herdr", phase: "tool", touched: now - 1000, target }] }, now)
  expect(a.target).toEqual(target)

  // Verify the exact button-text derivation used in page/app.js fillPanel()
  const w = M.text("en")
  const paneId = a.target.paneId || a.target.herdrPane || a.target.tmuxPane || ""
  const buttons = a.target.hosts.map((h, idx) => {
    const text = idx === 0 && paneId && !h.label.includes(paneId) ? `${h.label} · ${paneId}` : h.label
    return M.fill(w.jumpTo, text)
  })
  expect(buttons).toEqual(["↗ Herdr.app · wM:p8C", "↗ Otty"])
  expect(buttons.join(" ")).not.toContain("undefined")
})

test("office.hooks.mjs imported without MAGPIE_AGENT_OFFICE_PAGE writes page/live.js and never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-office-host-probe-"))
  try {
    const home = join(root, "home")
    const pkgDir = join(root, "pkg")
    mkdirSync(join(pkgDir, "page"), { recursive: true })
    cpSync(join(dir, "lib"), join(pkgDir, "lib"), { recursive: true })
    cpSync(join(dir, "office.hooks.mjs"), join(pkgDir, "office.hooks.mjs"))
    cpSync(join(dir, "package.json"), join(pkgDir, "package.json"))

    const project = join(home, ".claude", "projects", "-tmp-probe")
    mkdirSync(project, { recursive: true })
    const ts = new Date().toISOString()
    writeFileSync(join(project, "s1.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "s1", cwd: "/tmp/probe", timestamp: ts, message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", sessionId: "s1", cwd: "/tmp/probe", timestamp: ts, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } }),
    ].join("\n"))

    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") }
    delete env.MAGPIE_AGENT_OFFICE_PAGE
    const hookUrl = pathToFileURL(join(pkgDir, "office.hooks.mjs")).href
    const code = `
      const h = await import(${JSON.stringify(hookUrl)});
      const snap = h.snapshot();
      h.write();
      h.stop();
      console.log(JSON.stringify({ count: snap.sessions.length, id: snap.sessions[0]?.session }));
    `
    const r = Bun.spawnSync({ cmd: [process.execPath, "-e", code], cwd: pkgDir, env, stdout: "pipe", stderr: "pipe" })
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(new TextDecoder().decode(r.stdout).trim())
    expect(out).toEqual({ count: 1, id: "s1" })
    const livePath = join(pkgDir, "page", "live.js")
    expect(existsSync(livePath)).toBe(true)
    const live = readFileSync(livePath, "utf8")
    expect(live.startsWith("globalThis.AgentOfficeLive = ")).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("magpie host restart on options.set executes a fresh jumpRequest once and never touches plugins.json", () => {
  if (process.platform !== "darwin") return
  const root = mkdtempSync(join(tmpdir(), "agent-office-restart-probe-"))
  try {
    const home = join(root, "home")
    const cfg = join(root, "cfg")
    const cache = join(root, "cache")
    const pkgDir = join(root, "pkg")
    mkdirSync(join(pkgDir, "page"), { recursive: true })
    cpSync(join(dir, "lib"), join(pkgDir, "lib"), { recursive: true })
    cpSync(join(dir, "office.hooks.mjs"), join(pkgDir, "office.hooks.mjs"))
    cpSync(join(dir, "package.json"), join(pkgDir, "package.json"))

    // Fake herdr in $HOME/.local/bin/herdr logging every invocation
    const binDir = join(home, ".local", "bin")
    const herdrLog = join(home, "herdr.log")
    mkdirSync(binDir, { recursive: true })
    const fakeHerdr = join(binDir, "herdr")
    writeFileSync(fakeHerdr, `#!/bin/sh
echo "$@" >> "${herdrLog}"
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  echo '{"result":{"panes":[{"pane_id":"wM:p8C","tab_id":"wM:t73","workspace_id":"wM","cwd":"/tmp/probe","agent_session":{"value":"11111111-2222-3333-4444-555555555555"}}]}}'
fi
`)
    chmodSync(fakeHerdr, 0o755)

    // plugins.json written 0600 with another plugin's apiKey + fresh jumpRequest
    const magpieCfg = join(cfg, "magpie")
    mkdirSync(magpieCfg, { recursive: true })
    const pluginsFile = join(magpieCfg, "plugins.json")
    const pluginsContent = JSON.stringify({
      plugins: [
        { spec: "other-plugin", options: { apiKey: "secret-api-key" } },
        {
          spec: "@magpie-community/page-agent-office",
          options: {
            text: true,
            jumpRequest: {
              key: "claude|11111111-2222-3333-4444-555555555555",
              session: "11111111-2222-3333-4444-555555555555",
              preferredHostId: "herdr-cli",
              at: Date.now(),
            },
          },
        },
      ],
    }, null, 2)
    writeFileSync(pluginsFile, pluginsContent, { mode: 0o600 })
    chmodSync(pluginsFile, 0o600)

    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, XDG_CACHE_HOME: cache }
    delete env.MAGPIE_AGENT_OFFICE_PAGE
    const hookUrl = pathToFileURL(join(pkgDir, "office.hooks.mjs")).href
    const code = `
      const h = await import(${JSON.stringify(hookUrl)});
      await h.waitForJump();
      h.stop();
    `
    // First host startup (right after magpie's SetOptions -> Restart)
    const r1 = Bun.spawnSync({ cmd: [process.execPath, "-e", code], cwd: pkgDir, env, stdout: "pipe", stderr: "pipe" })
    expect(r1.exitCode).toBe(0)
    const log1 = readFileSync(herdrLog, "utf8")
    expect(log1).toContain("workspace focus wM")
    expect(log1).toContain("tab focus wM:t73")
    expect(log1).toContain("agent focus wM:p8C")

    // plugins.json mode (0600) and content must be untouched
    expect(statSync(pluginsFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(pluginsFile, "utf8")).toBe(pluginsContent)

    // Second host startup with the same plugins.json must not replay the jump
    writeFileSync(herdrLog, "")
    const r2 = Bun.spawnSync({ cmd: [process.execPath, "-e", code], cwd: pkgDir, env, stdout: "pipe", stderr: "pipe" })
    expect(r2.exitCode).toBe(0)
    const log2 = readFileSync(herdrLog, "utf8")
    expect(log2).not.toContain("workspace focus wM")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


