// Amazon Quick cloud outpost lifecycle.
//
// The desktop app ships a frozen Python backend (`quickwork-agent`, extracted
// from resources/agent.zip into the app's userData dir on Windows). In cloud
// mode it runs as `--outpost-only`, serves /auth/* and /local/* on a loopback
// port, and holds the user's sign-in state (OS credential store + profile).
//
// This module finds that binary — preferring the copy the app already
// extracted, falling back to extracting agent.zip ourselves — spawns it on a
// free port with OUR OWN instance token piped to stdin (the same contract
// Electron's AgentBridge uses), and exposes the small HTTP surface the plugin
// needs: /health, /auth/status, /auth/sncs-session.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export class OutpostError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message)
    this.name = 'OutpostError'
    this.status = status
    this.kind = kind // 'auth' | 'spawn' | 'http' | 'timeout'
  }
}

const EXE_NAME = process.platform === 'win32' ? 'quickwork-agent.exe' : 'quickwork-agent'

/** Candidate directories that may already contain an extracted agent/. */
function extractedAgentDirs(options = {}) {
  const dirs = []
  if (options.userDataDir) dirs.push(path.join(options.userDataDir, 'agent'))
  const home = os.homedir()
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA
    const ad = process.env.APPDATA
    if (lad) dirs.push(path.join(lad, 'quickwork', 'agent'))
    if (ad) dirs.push(path.join(ad, 'quickwork', 'agent'), path.join(ad, 'Amazon Quick', 'agent'))
  } else if (process.platform === 'darwin') {
    dirs.push(
      path.join(home, 'Library', 'Application Support', 'quickwork', 'agent'),
      path.join(home, 'Library', 'Application Support', 'Amazon Quick', 'agent'),
    )
  } else {
    dirs.push(
      path.join(home, '.config', 'quickwork', 'agent'),
      path.join(home, '.local', 'share', 'quickwork', 'agent'),
    )
  }
  return [...new Set(dirs)]
}

/** Candidate agent.zip files shipped inside the installed app. */
function agentZipCandidates(options = {}) {
  const zips = []
  if (options.agentZip) zips.push(options.agentZip)
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
    const pfx = process.env['ProgramFiles(x86)'] || ''
    for (const root of [lad && path.join(lad, 'Programs', 'quickwork'), path.join(pf, 'quickwork'), pfx && path.join(pfx, 'quickwork')]) {
      if (root) zips.push(path.join(root, 'resources', 'agent.zip'))
    }
  } else if (process.platform === 'darwin') {
    zips.push('/Applications/Amazon Quick.app/Contents/Resources/agent.zip')
  } else {
    for (const root of ['/opt/quickwork', '/usr/lib/quickwork', '/usr/local/lib/quickwork']) {
      zips.push(path.join(root, 'resources', 'agent.zip'))
    }
  }
  return [...new Set(zips)]
}

/** In-bundle (non-Windows) layouts where the binary sits unpacked in Resources. */
function bundledBinaryCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Amazon Quick.app/Contents/Resources/agent/' + EXE_NAME,
      '/Applications/Amazon Quick.app/Contents/Resources/' + EXE_NAME,
    ]
  }
  return []
}

/** Extract a .zip using whatever the platform ships (bsdtar / Expand-Archive / unzip). */
function extractedBinary(dir) {
  return [path.join(dir, EXE_NAME), path.join(dir, '_internal', EXE_NAME)].find(existsSync)
}

export function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const attempts = []
  if (process.platform === 'win32') {
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]])
    attempts.push(['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`]])
  } else {
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]])
    attempts.push(['unzip', ['-o', zipPath, '-d', destDir]])
  }
  let lastErr = null
  for (const [cmd, args] of attempts) {
    try {
      const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 10 * 60 * 1000 })
      if (r.status === 0 && extractedBinary(destDir)) return destDir
      lastErr = new Error(`${cmd} exited ${r.status ?? r.error}`)
    } catch (e) {
      lastErr = e
    }
  }
  throw new OutpostError(`无法解压 agent.zip 到 ${destDir}: ${lastErr?.message ?? 'unknown'}`, { kind: 'spawn' })
}

/**
 * Locate quickwork-agent. Returns { path, source } or throws OutpostError.
 * Order: explicit option → app's extracted copy → in-bundle binary → extract agent.zip.
 */
export function findAgent(options = {}) {
  if (options.agentPath) {
    if (existsSync(options.agentPath)) return { path: options.agentPath, source: 'option' }
    options.log?.(`[outpost] agentPath does not exist: ${options.agentPath}; falling back to auto-discovery`)
  }
  for (const dir of extractedAgentDirs(options)) {
    const p = path.join(dir, EXE_NAME)
    if (existsSync(p)) return { path: p, source: `extracted:${dir}` }
  }
  for (const p of bundledBinaryCandidates()) {
    if (existsSync(p)) return { path: p, source: 'bundle' }
  }
  // Explicit zip first, then install-location candidates; extract into a stable cache dir.
  const userCache = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
      : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'))
  const cacheRoot = options.cacheDir || path.join(userCache, 'magpie-aws-quick')
  for (const zip of agentZipCandidates(options)) {
    if (!existsSync(zip)) continue
    const stat = statSync(zip)
    const stamp = `${stat.size}-${Math.floor(stat.mtimeMs)}`
    const dest = path.join(cacheRoot, 'agent', stamp.replace(/[^\w.-]/g, '_'))
    if (!extractedBinary(dest)) {
      const parent = path.dirname(dest)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      const staging = mkdtempSync(path.join(parent, '.extract-'))
      try {
        extractZip(zip, staging)
        try { renameSync(staging, dest) } catch (e) {
          if (!extractedBinary(dest)) throw e
        }
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    }
    return { path: extractedBinary(dest), source: `zip:${zip}` }
  }
  throw new OutpostError(
    '找不到 Amazon Quick 后端（quickwork-agent）。请先安装并登录 Amazon Quick 桌面端，' +
    '或用插件选项 agentPath / agentZip 指定。',
    { kind: 'spawn', status: 503 },
  )
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Outpost {
  /**
   * @param {object} options plugin options
   * @param {string} [options.agentPath] explicit quickwork-agent path
   * @param {string} [options.agentZip] explicit agent.zip to extract
   * @param {string} [options.userDataDir] app userData dir to probe for agent/
   * @param {string} [options.cacheDir] extraction cache dir
   * @param {number} [options.port] fixed outpost port (default: free port)
   * @param {string} [options.buildStage] QUICKWORK_BUILD_STAGE (default prod)
   * @param {string} [options.profileStage] QUICKWORK_PROFILE_STAGE
   * @param {object} [options.env] extra env for the child
   * @param {Function} [options.log]
   */
  constructor(options = {}) {
    this.options = options
    this.log = options.log ?? (() => {})
    this.token = null
    this.child = null
    this.port = null
    this.base = null
    this.sessionCache = null // {data, until}
    this._sessionPending = null
    this.starting = null
    this._stdoutBuf = ''
    this._stderrBuf = ''
    this._onExit = null
  }

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed
  }

  async ensure() {
    if (this.starting) return this.starting
    if (this.running && this.base) return this
    this.starting = this._start().finally(() => { this.starting = null })
    return this.starting
  }

  async _start() {
    if (this.running) return this
    const agent = findAgent(this.options)
    this.port = this.options.port || (await freePort())
    this.token = this.options.instanceToken || randomBytes(32).toString('base64url')
    const env = {
      ...process.env,
      ...(this.options.env || {}),
      QUICKWORK_BUILD_STAGE: this.options.buildStage || 'prod',
      QUICKWORK_CLOUD_MODE: '1',
      QUICKWORK_OUTPOST_PORT: String(this.port),
      QUICKWORK_PROFILE_STAGE: this.options.profileStage || this.options.buildStage || 'prod',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
    }
    this.log(`[outpost] spawning ${agent.path} on 127.0.0.1:${this.port} (${agent.source})`)
    const child = spawn(agent.path, ['--outpost-only', '--manifest', 'desktop', '--port', String(this.port)], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this._stdoutBuf = ''
    this._stderrBuf = ''
    this._detachExitHook()
    const onExit = () => { try { child.kill() } catch {} }
    this._onExit = onExit
    process.once('exit', onExit)
    child.stdout?.on('data', (d) => this._onStdout(String(d)))
    child.stderr?.on('data', (d) => this._onStderr(String(d)))
    child.on('exit', (code, sig) => {
      this.log(`[outpost] exited code=${code} sig=${sig}`)
      if (this._onExit === onExit) this._detachExitHook()
      if (this.child === child) { this.child = null; this.base = null; this.sessionCache = null; this._sessionPending = null }
    })
    child.on('error', (e) => {
      this.log(`[outpost] spawn error: ${e.message}`)
      if (this._onExit === onExit) this._detachExitHook()
      if (this.child === child && !child.pid) { this.child = null; this.base = null; this.sessionCache = null; this._sessionPending = null }
    })
    child.stdin?.on('error', () => {}) // the child can exit before reading the first line
    // instance token contract: first line on stdin (AgentBridge.pipeToken)
    try { child.stdin?.write(`${this.token}\n`); child.stdin?.end() } catch {}
    this.base = `http://127.0.0.1:${this.port}`
    try { await this._waitHealthy() } catch (e) {
      if (this.child === child) await this.stop()
      throw e
    }
    return this
  }

  _detachExitHook() {
    if (this._onExit) {
      process.off('exit', this._onExit)
      this._onExit = null
    }
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk
    const lines = this._stdoutBuf.split(/\r?\n/)
    this._stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      const m = line.match(/OUTPOST_PORT:\s*(\d+)/)
      if (m) {
        this.port = Number(m[1])
        this.base = `http://127.0.0.1:${this.port}`
      }
      if (/LEP_PORT:/.test(line)) this.log(`[outpost] ${line.trim()}`)
    }
  }

  _onStderr(chunk) {
    // PyInstaller boot logs are noisy; keep only warnings/errors, redacted length
    this._stderrBuf += chunk
    const lines = this._stderrBuf.split(/\r?\n/)
    this._stderrBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (/error|Error|ERROR|Traceback|failed|Failed/.test(line)) this.log(`[outpost:err] ${line.slice(0, 300)}`)
    }
  }

  async _waitHealthy(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs
    let lastErr = null
    while (Date.now() < deadline) {
      if (!this.running) throw new OutpostError('outpost 进程提前退出', { kind: 'spawn' })
      try {
        const r = await this._fetch('/health', { timeoutMs: 3000 })
        if (r.ok) return
      } catch (e) { lastErr = e }
      await sleep(400)
    }
    throw new OutpostError(`outpost 启动超时: ${lastErr?.message ?? 'no response'}`, { kind: 'timeout' })
  }

  async _fetch(pathname, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    t.unref?.()
    try {
      const res = await fetch(`${this.base}${pathname}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = text }
      return { ok: res.ok, status: res.status, data, headers: res.headers }
    } finally {
      clearTimeout(t)
    }
  }

  /** GET /auth/status → { logged_in, user, provider, … } */
  async status() {
    await this.ensure()
    const r = await this._fetch('/auth/status')
    if (!r.ok) throw new OutpostError(`auth/status ${r.status}`, { status: r.status, kind: 'http' })
    return r.data
  }

  /** GET /local/outpost-id → {outpostId} (device id the chat WS expects). */
  async outpostId() {
    await this.ensure()
    const r = await this._fetch('/local/outpost-id')
    if (!r.ok) throw new OutpostError(`outpost-id ${r.status}`, { status: r.status, kind: 'http' })
    return r.data?.outpostId || ''
  }

  /**
   * GET /auth/sncs-session → { id_token, ws_host, tenant_url, actor_arn, provider,
   * aws_account_id, embed_host, usable_until, … }. Cached until shortly before
   * usable_until; pass {fresh:true} to force a re-mint.
   */
  async session({ fresh = false } = {}) {
    await this.ensure()
    const now = Date.now() / 1000
    if (!fresh && this.sessionCache && this.sessionCache.until > now + 30) return this.sessionCache.data
    if (!fresh && this._sessionPending) return this._sessionPending
    const fetchSession = (async () => {
      const r = await this._fetch('/auth/sncs-session')
      if (r.status === 401) throw new OutpostError('会话已失效，请在 Amazon Quick 桌面端重新登录', { status: 401, kind: 'auth' })
      if (!r.ok) throw new OutpostError(`sncs-session ${r.status}`, { status: r.status, kind: 'http' })
      if (!r.data || typeof r.data !== 'object' || !r.data.id_token || !r.data.ws_host) {
        throw new OutpostError('outpost 返回了无效的 sncs-session 载荷', { status: 502, kind: 'http' })
      }
      const until = Number(r.data.usable_until) || Date.now() / 1000 + 300
      this.sessionCache = { data: r.data, until }
      return r.data
    })()
    const pending = fetchSession.finally(() => {
      if (this._sessionPending === pending) this._sessionPending = null
    })
    this._sessionPending = pending
    return pending
  }

  async stop() {
    this._detachExitHook()
    const c = this.child
    this.child = null
    this.base = null
    this.sessionCache = null
    this._sessionPending = null
    if (c) {
      try { c.stdin?.end() } catch {}
      try { c.kill() } catch {}
      // give it a moment then force
      setTimeout(() => { if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL') } catch {} } }, 3000).unref?.()
    }
  }
}

/** Shared per-plugin-instance outpost (created lazily by the loader). */
export function createOutpostManager(options = {}) {
  let current = null
  return {
    options,
    get() {
      if (!current) current = new Outpost(options)
      return current
    },
    async ensure() {
      if (!current) current = new Outpost(options)
      return current.ensure()
    },
    async stop() { if (current) await current.stop() },
  }
}
