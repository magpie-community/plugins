/**
 * magpie-aws-quick — your Amazon Quick (AWS Quick desktop) login as a magpie / OpenCode provider.
 *
 * magpie sends this provider OpenAI Chat Completions (npm "@ai-sdk/openai-compatible");
 * the loader's fetch answers them by driving the same bidi WebSocket the desktop
 * client uses (see lib/quickws.mjs + lib/handler.mjs).
 *
 * Two keyless sign-in methods:
 *   1. Browser OAuth (default choice, no desktop app): replays the app's own
 *      OIDC+PKCE flow — opens quick.aws.com/sn, catches the localhost callback,
 *      registers a dynamic OIDC client, exchanges the code, reads user-info —
 *      then chats over the stored token directly with auto-refresh.
 *   2. Local credentials: on Windows reads the desktop app's stored session
 *      straight from Credential Manager (refresh via OIDC, written back so the
 *      app keeps working); otherwise spawns the bundled agent's
 *      `quickwork-agent --outpost-only` and reuses its sign-in via
 *      /auth/sncs-session. Needs the desktop app installed + signed in.
 *
 * Options (magpie plugin options aws-quick '{…}'), all optional:
 *   agentPath    explicit path to quickwork-agent(.exe)
 *   agentZip     explicit path to the app's resources/agent.zip (extracted on demand)
 *   userDataDir  app userData dir to probe for an already-extracted agent/
 *   cacheDir     where to extract agent.zip (default OS user cache dir/magpie-aws-quick)
 *   port         fixed outpost port (default: a free loopback port)
 *   buildStage   QUICKWORK_BUILD_STAGE for the spawned backend (default prod)
 *   profileStage QUICKWORK_PROFILE_STAGE (default = buildStage)
 *   surfaceType  WS surfaceType (default QUICK_WORK_DESKTOP_WINDOWS)
 *   appVersion   WS appVersion (default 1.2.4660)
 *   channel      WS channel hint (beta|prod)
 *   sessionReuse continue Quick threads across turns (default true)
 *   sessionTtlMs forget a cached thread state after this long unused (default 1800000)
 *   sessionMax   at most this many cached thread states (default 200)
 *   sessionDir   where OAuth sessions are stored (default: platform config dir)
 *   oauthPort    fixed localhost callback port for OAuth login (default: free port)
 *   oauthTimeoutMs how long to wait for the browser login (default 600000)
 *   openBrowser  function(url) to open the sign-in page (default: OS default)
 *   log          function(line) for plugin diagnostics
 *
 * Models are Quick's agent modes, not raw model ids:
 *   fast / balanced / smart / advanced  (X-Magpie-Effort maps to thinking_effort)
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOutpostManager } from './lib/outpost.mjs'
import { makeFetch, makeSessions } from './lib/fetch.mjs'
import { MODELS } from './lib/translate.mjs'
import {
  createSessionStore as createOAuthStore, createDirectBackend,
  startOAuthLogin, buildSession, keyForSession, OAuthError,
} from './lib/oauth.mjs'
import { createCredManBackend, loadCredManSession } from './lib/credman.mjs'

function pluginIcon() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.png')
  if (!existsSync(file)) return undefined
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`
}

const PROVIDER = 'aws-quick'
const ICON = pluginIcon()
// Requests never reach this address: the loader's fetch intercepts them.
const BASE = 'https://quick.aws.com/magpie-aws-quick/v1'

const BASE_MODEL = {
  // turn_usage.context_window on 1.2.4660 is 1_000_000. A smaller number makes
  // magpie drop history before it ever reaches Quick.
  limit: { context: 1_000_000, output: 64_000 },
  // Quick's own agent tools run server-side; OpenAI-style function calling is
  // layered on top as a <tool_call> text convention (lib/tools.mjs).
  tool_call: true,
  api: { url: BASE, npm: '@ai-sdk/openai-compatible' },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true },
    interleaved: false,
  },
}

export const AwsQuickAuthPlugin = async (_input, options) => {
  const opts = options && typeof options === 'object' ? options : {}
  const outpostMgr = createOutpostManager(opts)
  const sessions = makeSessions(opts)
  // Reuse per-(mode, key) backends across loader() calls so sockets/ping timers
  // and in-memory refreshed tokens are not duplicated or leaked.
  const backends = new Map()
  const getDirectMgr = (cacheKey, factory) => {
    let mgr = backends.get(cacheKey)
    if (!mgr) {
      const backend = factory()
      mgr = { backend, ensure: () => backend.ensure() }
      backends.set(cacheKey, mgr)
    }
    return mgr
  }
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'AWS Quick',
        npm: '@ai-sdk/openai-compatible',
        api: BASE,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 2,
      methods: [
        {
          // type oauth is what Magpie draws as a login button. It opens `url`
          // and waits on callback while the local page finishes OIDC+PKCE.
          type: 'oauth',
          label: '浏览器登录',
          labels: { zh: '浏览器登录', 'zh-TW': '瀏覽器登錄', en: 'Sign in with browser' },
          authorize: async (_inputs, { signal } = {}) => {
            const stage = opts.buildStage || 'prod'
            let url
            let flow
            try {
              flow = await startOAuthLogin({
                stage,
                port: Number(opts.oauthPort) || undefined,
                timeoutMs: Number(opts.oauthTimeoutMs) || undefined,
                signal,
                fetchImpl: opts.fetchImpl,
                openBrowser: opts.openBrowser || null,
                log: opts.log,
              })
              url = (await flow.ready).url
            } catch (e) {
              return { type: 'failed', error: `无法打开登录：${String(e?.message ?? e).slice(0, 300)}` }
            }
            return {
              url,
              instructions: '在浏览器里登录 AWS Quick 账号。完成后回到 Magpie，这个按钮会自己结束。',
              method: 'auto',
              async callback() {
                try {
                  const sess = buildSession(await flow.result, { stage })
                  const store = createOAuthStore({ dir: opts.sessionDir })
                  const key = keyForSession(sess)
                  store.set(key, sess)
                  const who = sess.email || sess.display_name || sess.aws_account_id || ''
                  return { type: 'success', key, accountId: who || key, metadata: { mode: 'oauth', account: who } }
                } catch (e) {
                  const msg = String(e?.message ?? e)
                  if (e instanceof OAuthError && e.kind === 'abort') return { type: 'failed', error: '登录已取消' }
                  return { type: 'failed', error: `Amazon Quick 账号登录失败：${msg.slice(0, 300)}` }
                }
              },
            }
          },
        },
        {
          type: 'oauth',
          label: '桌面端登录',
          labels: { zh: '桌面端登录', 'zh-TW': '桌面端登錄', en: 'Use the desktop sign-in' },
          authorize: async () => ({
            url: '',
            instructions: '读取本机 Amazon Quick 已经保存的登录态，不会再打开浏览器。',
            method: 'auto',
            async callback() {
              if (process.platform === 'win32') {
                try {
                  const sess = await loadCredManSession({ fresh: true })
                  if (sess?.jwt) {
                    const { backend } = getDirectMgr('local-credman:aws-quick-local', () => createCredManBackend({ fetchImpl: opts.fetchImpl, log: opts.log }))
                    await backend.ensure()
                    const freshSess = await backend.session()
                    const who = freshSess.email || sess.email || sess.display_name || freshSess.account_name || freshSess.aws_account_id || sess.aws_account_id || ''
                    return { type: 'success', key: 'aws-quick-local', accountId: who || 'aws-quick-local', metadata: { mode: 'local-credman', account: who } }
                  }
                } catch (e) {
                  opts.log?.(`[credman] fallback to outpost: ${e?.message ?? e}`)
                }
              }
              try {
                const outpost = await outpostMgr.ensure()
                const st = await outpost.status()
                if (!st?.logged_in && !st?.user) {
                  return { type: 'failed', error: 'Amazon Quick 桌面端未登录：请先打开 Amazon Quick 登录，再重试' }
                }
                const s = await outpost.session({ fresh: true })
                const stUser = typeof st?.user === 'string' ? st.user : (st?.user?.email || st?.user?.display_name || st?.user?.user_name || '')
                const who = stUser || s?.email || s?.account_name || s?.aws_account_id || ''
                return { type: 'success', key: 'aws-quick-local', accountId: who || 'aws-quick-local', metadata: { mode: 'local-outpost', ...(who ? { account: who } : {}) } }
              } catch (e) {
                return {
                  type: 'failed',
                  error: `无法连接 Amazon Quick 后端：${String(e?.message ?? e).slice(0, 300)}。请确认已安装并登录 Amazon Quick 桌面版。`,
                }
              }
            },
          }),
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth?.type === 'api' ? auth.key : undefined
        if (!key) return {}
        // OAuth-provisioned account: chat over the stored token directly, no
        // outpost spawn. Session file handles refresh-token rotation.
        if (auth?.metadata?.mode === 'oauth') {
          const mgr = getDirectMgr(`oauth:${key}`, () => {
            const store = createOAuthStore({ dir: opts.sessionDir })
            return createDirectBackend({
              load: () => store.get(key),
              persist: (s) => store.set(key, s),
              fetchImpl: opts.fetchImpl,
              log: opts.log,
            })
          })
          return { baseURL: BASE, apiKey: 'aws-quick-oauth', fetch: makeFetch(mgr, { ...opts, identityKey: key }, sessions) }
        }
        // Credential-Manager session (Windows): same direct-WS path, tokens
        // refreshed via OIDC and written back to the app's own credential.
        if (auth?.metadata?.mode === 'local-credman') {
          const mgr = getDirectMgr(`local-credman:${key}`, () => createCredManBackend({ fetchImpl: opts.fetchImpl, log: opts.log }))
          return { baseURL: BASE, apiKey: 'aws-quick-local', fetch: makeFetch(mgr, { ...opts, identityKey: key }, sessions) }
        }
        return { baseURL: BASE, apiKey: 'aws-quick-local', fetch: makeFetch(outpostMgr, { ...opts, identityKey: key }, sessions) }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api' || !auth.key) return provider.models
        const out = {}
        for (const m of MODELS) out[m.id] = { ...structuredClone(BASE_MODEL), id: m.id, name: m.name }
        return out
      },
    },
  }
}
