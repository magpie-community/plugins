// 书灵墨宝 MoBook（mobook.me）for OpenCode 与 magpie。
//
// 登录复用网页端登录态（Cookie 里的 _tk）：模型目录、墨滴积分、每日签到和成长计划
// 任务都走同一份网页接口。对话不花 API Key：每次请求在墨宝里开一个临时会话，
// 把 messages 压成一段文本发给「墨宝」智能体，轮询消息列表直到拿到最终回答，
// 结束时把会话删掉——网页端用 WebSocket 收流，这里用消息列表轮询达到同样效果。
//
// 说明：墨宝的对话入口面向出版编辑场景，是“一问一答”的智能体会话，没有工具调用、
// 图片输入和多模态输出，因此模型一律声明 toolcall/attachment 为 false。
import {
  DEFAULT_AGENT_ID,
  GATEWAY,
  MEDIA_GATEWAY_V3,
  MODEL_GATEWAY,
  MoBookError,
  ORG_ID,
  ask,
  checkinActivity,
  fetchGatewayModelIds,
  fetchLedgerTotals,
  fetchActiveMap,
  beijingTimeLabel,
  fetchRecordingQuota,
  fetchRecordingUsage,
  recordActivityChat,
  runTasks,
  ensureBot,
  ensureDeviceBot,
  listBots,
  exchangeUserToken,
  isActiveToday,
  fetchApiKeyConfig,
  fetchModelShow,
  generateImage,
  readClientState,
  appIdForApi,
  parseMultipartAudio,
  parseWavToPcm16k,
  speak,
  transcribePcm16k,
  claimCheckin,
  claimTask,
  fetchBalance,
  fetchTasks,
  fetchUser,
  joinTask,
  defaultInviteChannel,
  loginBySms,
  sendSmsCode,
  parseSession,
  promptFromMessages,
} from './api.mjs'
import { allModels, bootstrapModels, curatedModels } from './models.mjs'
import { deviceIdFrom, localHostName, resolveDevice, windowsClientName } from './device.mjs'
import { claimDaily, readDoneAt, taskProgressText } from './task-state.mjs'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PROVIDER_ID = 'mobook'
export const PROVIDER_NAME = '书灵墨宝 MoBook'
export const NPM = '@ai-sdk/openai-compatible'
// 墨宝自己的 OpenAI 兼容模型网关：接口就在这，但对话要求 API Key；
// 本插件用网页登录态走智能体会话，所以只把它当作 loader 的 baseURL。
export const API_BASE = GATEWAY + '/modelgw/v1'
export const OFFICIAL_SITE = 'https://mobook.me'

// accountNameOf 取账号显示名：墨宝昵称优先，其次手机号脱敏，最后给个占位。
// 这个名字会作为 magpie 的 accountId，用来区分同一 provider 的多个账号。
// 测试用：把硬件探测换成桩，避免单测真的去跑 PowerShell。
let deviceDetectOverride = null
export function setDeviceDetector(fn) {
  deviceDetectOverride = typeof fn === 'function' ? fn : null
}

export function accountNameOf(user, fallback = '') {
  const name = String(user?.name ?? '').trim()
  if (name) return name
  const tail = String(fallback ?? '').trim()
  return tail || '书灵墨宝'
}

// 测试用：替掉“本机客户端账号”的判断，避免单测受真实 ~/.mobook-harness 影响。
let localAccountOverride = null
export function setLocalClientAccount(fn) {
  localAccountOverride = typeof fn === 'function' ? fn : null
}

// localClientAccount 读本机客户端的登录态，只用来判断“这次登录的是不是本机桌面端那个账号”。
async function localClientAccount() {
  if (localAccountOverride) {
    try {
      return (await localAccountOverride()) ?? null
    } catch {
      return null
    }
  }
  try {
    const state = await readClientState({})
    return state?.uid ? state : null
  } catch {
    return null
  }
}

// resolveHostDevice 决定这次登录登记哪套设备身份（只本地记录，不发给墨宝）：
//   - 登录账号就是本机桌面端那个账号 → reuse：照搬它的硬件指纹 + 本机 hostname；
//   - 其它（手机号、别的账号的 Cookie）→ web：按账号派生，代表“网页版”这个接入端。
async function resolveHostDevice(uid) {
  const local = await localClientAccount()
  if (local && String(local.uid) === String(uid)) {
    return resolveDevice({
      uid,
      mode: 'reuse',
      clientState: local,
      ...(deviceDetectOverride ? { detect: deviceDetectOverride } : {}),
    }).catch(() => null)
  }
  return resolveDevice({
    uid,
    mode: 'web',
    ...(deviceDetectOverride ? { detect: deviceDetectOverride } : {}),
  }).catch(() => null)
}

// credOf 把 OpenCode/magpie 保存的凭据还原成网页会话。OpenCode 2.x 将原凭据包在 metadata.v1。
// 老账号/手写 auth.json 只有 key 没有 metadata 时，key 就是 _tk。
export function credOf(auth) {
  if (!auth) return null
  const outer = auth.metadata && typeof auth.metadata === 'object' ? auth.metadata : {}
  const meta = outer.v1?.metadata && typeof outer.v1.metadata === 'object' ? outer.v1.metadata : outer
  const v1 = outer.v1 && typeof outer.v1 === 'object' ? outer.v1 : {}
  const tk = String(meta.tk ?? v1.access ?? auth.key ?? auth.access ?? '').trim()
  const apiKey = String(meta.apiKey ?? '').trim()
  if (!tk && !apiKey) return null
  const uid = String(meta.uid ?? v1.uid ?? '').trim()
  const device = meta.device && typeof meta.device === 'object' ? meta.device : {}
  const platform = String(meta.platform ?? (device.clientType === 'desktop' ? 'desktop' : 'web'))
  const appId = Number(meta.appId) || Number(device.appId) || (platform === 'desktop' ? appIdForApi(110) : 0)
  return {
    tk,
    apiKey,
    uid,
    orgId: Number(meta.orgId) || ORG_ID,
    appId,
    agentId: Number(meta.agentId) || DEFAULT_AGENT_ID,
    botToken: String(meta.botToken ?? '').trim(),
    platform,
    expiresAt: Number(meta.expiresAt ?? v1.expires) || 0,
    source: String(meta.source ?? ''),
    name: String(meta.name ?? '').trim(),
    mobile: String(meta.mobile ?? '').trim(),
  }
}

function errResponse(message, { expired = false, status = 502 } = {}) {
  return new Response(JSON.stringify({ error: { message, type: expired ? 'authentication_error' : 'api_error' } }), {
    status: expired ? 401 : status,
    headers: {
      'content-type': 'application/json',
      ...(expired ? { 'x-magpie-sign-in': 'expired' } : {}),
    },
  })
}

// chatFetch 是 loader 交给 AI SDK 的 fetch：它把 OpenAI 的 /chat/completions
// 请求翻成墨宝智能体会话，再把回答写成 OpenAI 的 JSON 或 SSE。
export function chatFetch(cred, input, init = {}, deps = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
  const request = input instanceof Request ? input : null
  const method = String(init?.method ?? request?.method ?? 'POST').toUpperCase()
  if (method === 'GET' || /\/models(\?|$)/.test(url)) {
    return listModelsResponse(cred, deps)
  }
  // 画图 / 语音合成 / 语音识别都要账号级 API Key（走 model-gateway）。只有网页会话（_tk）的
  // 账号会被 loader 指到本函数：这里先自动补取一次 key，拿到就重试，用户侧不该看到这一步。
  if (/\/(?:images|audio)\//.test(url)) {
    return (async () => {
      const keyed = await ensureApiKey(cred, deps)
      if (!keyed.apiKey) {
        return errResponse('墨宝的画图 / 语音能力需要账号级 API Key（dcg-…）：插件已尝试自动补取但仍未取到，请重新登录墨宝一次')
      }
      cred.apiKey = keyed.apiKey
      return gatewayFetch(cred, input, init, deps)
    })()
  }
  return chatResponse(cred, input, request, init, deps)
}

// gatewayUrlForChat 把网页网关上的对话地址换成 model-gateway 上的同名路径：
// https://api-gateway…/modelgw/v1/chat/completions → https://model-gateway…/v1/chat/completions。
// 只有「懒补到 API Key 之后要把会话请求改走原生网关」这条路径会用到它。
function gatewayUrlForChat(url) {
  const path = String(url ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '')
  const at = path.indexOf('/v1/')
  const tail = at >= 0 ? path.slice(at + 4) : path
  return String(MODEL_GATEWAY).replace(/\/+$/, '') + (tail.startsWith('/') ? tail : '/' + tail)
}

// gatewayFetch 是走客户端 API Key 时的 fetch：请求本身由 AI SDK 发到 model-gateway，
// 这里补两件事：把响应里被网关改写过的模型名换回用户请求的那个；
// 把 magpie 的 /images/generations 转到墨宝的 /v3/images/generations。
export function gatewayFetch(cred, input, init = {}, deps = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
  const request = input instanceof Request ? input : null
  const method = String(init?.method ?? request?.method ?? 'POST').toUpperCase()
  if (method !== 'POST') return (deps.fetchImpl ?? fetch)(input, init)
  return (async () => {
    const bodyText = await bodyTextOf(request, init)
    let parsed = null
    try {
      parsed = JSON.parse(bodyText)
    } catch {}
    // 图片请求两种形态都接：路径是 /images/generations，或者 magpie 把画图请求
    // 折成了只有 prompt、没有 messages 的调用。
    if (/\/images\/generations(\?|$)/.test(url) || (parsed && !parsed.messages && typeof parsed.prompt === 'string')) {
      return imageResponseBody(cred, parsed ?? {}, deps)
    }
    // magpie 的 /v1/audio/speech：转成墨宝的 /v3/tts/create，回 MP3 字节。
    if (/\/audio\/speech(\?|$)/.test(url)) {
      return speechResponse(cred, parsed ?? {}, deps)
    }
    // magpie 的 /v1/audio/transcriptions / translations：走墨宝的腾讯实时转写。
    if (/\/audio\/(transcriptions|translations)(\?|$)/.test(url)) {
      return transcriptionResponse(cred, request, init, deps)
    }
    return chatGatewayResponse(cred, input, init, request, deps, bodyText, parsed)
  })()
}

async function chatGatewayResponse(cred, input, init, request, deps, bodyText, parsed) {
  let requested = ''
  if (typeof parsed?.model === 'string') requested = parsed.model
  const send = deps.fetchImpl ?? fetch
  const res = await send(request ? request.url : input, {
    ...init,
    method: 'POST',
    headers: (() => {
      const headers = new Headers(init?.headers ?? request?.headers ?? undefined)
      headers.set('authorization', 'Bearer ' + cred.apiKey)
      headers.set('content-type', 'application/json')
      return headers
    })(),
    body: bodyText,
  })
  if (!requested || !res.ok) return res
  const contentType = String(res.headers.get('content-type') ?? '')
  if (contentType.includes('text/event-stream') && res.body) {
    return new Response(res.body.pipeThrough(sseModelRewriter(requested)), {
      status: res.status,
      statusText: res.statusText,
      headers: rewrittenHeaders(res.headers),
    })
  }
  const text = await res.text()
  try {
    const payload = JSON.parse(text)
    if (payload && typeof payload === 'object') {
      if (typeof payload.model === 'string') payload.model = requested
      normalizeChatPayload(payload)
    }
    return new Response(JSON.stringify(payload), { status: res.status, headers: rewrittenHeaders(res.headers) })
  } catch {
    return new Response(text, { status: res.status, headers: rewrittenHeaders(res.headers) })
  }
}

// rewrittenHeaders 给「换了正文的响应」重新算头部：
// 上游的 content-length / content-encoding 描述的是它那份正文，改写后长度与编码都可能不同
// （模型名换回用户请求的那个，长度必然不同），原样带过去会让客户端按旧长度/旧编码读，
// 直接报 incorrect header check 或把明文当 gzip 解。故这两个头一律丢掉，让宿主按实际正文重算。
function rewrittenHeaders(source) {
  const headers = new Headers(source)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return headers
}

// normalizeChatPayload 把墨宝网关的非流式回答改成 OpenAI 的 chat.completion：
// 它在非流式下也把文本放在 choices[].delta，而不是 message。
export function normalizeChatPayload(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : []
  for (const choice of choices) {
    if (choice?.message && typeof choice.message === 'object') continue
    const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : null
    if (!delta) continue
    const message = { role: 'assistant', content: delta.content ?? '' }
    if (typeof delta.reasoning_content === 'string') message.reasoning_content = delta.reasoning_content
    choice.message = message
    delete choice.delta
  }
  if (payload && payload.object === 'chat.completion.chunk') payload.object = 'chat.completion'
  return payload
}

// sseModelRewriter 逐条重写 SSE 里的 model 字段（网关会换成上游模型名）。
export function sseModelRewriter(requestedModel) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const rewrite = (event) =>
    event
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') return line
        try {
          const payload = JSON.parse(data)
          if (payload && typeof payload === 'object') {
            payload.model = requestedModel
            return 'data: ' + JSON.stringify(payload)
          }
        } catch {}
        return line
      })
      .join('\n')
  // 上游可能用 CRLF 分帧（SSE 规范允许）。只按 '\n\n' 切会把整条流一直缓冲到结束才吐，
  // 客户端看起来就是「不流式」。先把行尾统一成 LF 再切帧（data 行里不该有裸 CR）。
  const splitEvents = (text) => {
    const events = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')
    return { events, rest: events.pop() ?? '' }
  }
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const { events, rest } = splitEvents(buffer)
      buffer = rest
      for (const event of events) controller.enqueue(encoder.encode(rewrite(event) + '\n\n'))
    },
    flush(controller) {
      if (buffer.trim()) controller.enqueue(encoder.encode(rewrite(buffer)))
    },
  })
}

// 尺寸档位：OpenAI 习惯像素，墨宝的图片网关吃 1K / 1.5K / 2K。
export function imageSizeFor(size) {
  const value = String(size ?? '').trim().toLowerCase()
  if (!value) return undefined
  if (/^\d+(?:\.\d+)?k$/.test(value)) return value.toUpperCase()
  const match = value.match(/^(\d+)\s*[x*]\s*(\d+)$/)
  if (!match) return value
  const long = Math.max(Number(match[1]), Number(match[2]))
  if (!Number.isFinite(long) || long <= 0) return undefined
  if (long <= 1024) return '1K'
  if (long <= 1536) return '1.5K'
  return '2K'
}

async function requestAudioBytes(request, init) {
  const h = init?.headers
  const plainCT = h && typeof h === 'object' && typeof h.get !== 'function'
    ? Object.entries(h).find(([k]) => k.toLowerCase() === 'content-type')?.[1]
    : undefined
  const headerCT = String(h?.get?.('content-type') ?? plainCT ?? '')
  const body = init?.body ?? null
  if (body == null) {
    if (!request) return { bytes: Buffer.alloc(0), contentType: '', filename: '' }
    return {
      bytes: Buffer.from(await request.clone().arrayBuffer()),
      contentType: String(request.headers.get('content-type') ?? ''),
      filename: '',
    }
  }
  if (typeof body === 'object' && typeof body.get === 'function') {
    const file = body.get('file')
    if (file && typeof file.arrayBuffer === 'function') {
      return { bytes: Buffer.from(await file.arrayBuffer()), contentType: String(file.type ?? ''), filename: String(file.name ?? '') }
    }
  }
  if (typeof body === 'string') {
    return { bytes: Buffer.from(body, 'binary'), contentType: headerCT, filename: '' }
  }
  if (body instanceof Uint8Array) {
    return { bytes: Buffer.from(body), contentType: headerCT, filename: '' }
  }
  if (typeof body.arrayBuffer === 'function') {
    return { bytes: Buffer.from(await body.arrayBuffer()), contentType: headerCT, filename: '' }
  }
  return { bytes: Buffer.from(body), contentType: headerCT, filename: '' }
}

// 3 小时 16k/16bit/单声道 PCM ≈ 346MB，上限盖住平台上限。
const MAX_DECODED_PCM_BYTES = 384 * 1024 * 1024
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000

async function decodeAudioToPcm16k(bytes, contentType) {
  const wav = parseWavToPcm16k(bytes)
  if (wav) return wav
  // 走异步 spawn，不用 spawnSync：几十分钟的音频会把宿主的事件循环整个卡住，
  // 同期所有插件调用（包括 magpie 自己的用量卡刷新）一起停摆。
  const fail = () => new MoBookError('音频解码失败：需要 WAV(PCM16) 或本机 ffmpeg（' + String(contentType || '').slice(0, 40) + '）')
  const chunks = []
  let total = 0
  let timer = null
  await new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(value)
    }
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { windowsHide: true })
    timer = setTimeout(() => {
      try { ffmpeg.kill('SIGKILL') } catch {}
      settle(reject, new MoBookError('音频解码超时（ffmpeg 跑了 ' + Math.round(FFMPEG_TIMEOUT_MS / 1000) + 's）'))
    }, FFMPEG_TIMEOUT_MS)
    timer.unref?.()
    ffmpeg.on('error', (error) => settle(reject, new MoBookError(fail().message + '：' + String(error?.message ?? error))))
    ffmpeg.stdout.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_DECODED_PCM_BYTES) {
        try { ffmpeg.kill('SIGKILL') } catch {}
        settle(reject, new MoBookError('音频解码结果超过 ' + MAX_DECODED_PCM_BYTES + ' 字节'))
        return
      }
      chunks.push(chunk)
    })
    // ffmpeg 提前退出时继续写 stdin 会 EPIPE：吞掉，让 close/error 去定性。
    ffmpeg.stdin.on('error', () => {})
    ffmpeg.on('close', (code) => {
      if (code === 0 && total > 0) settle(resolve, undefined)
      else settle(reject, fail())
    })
    ffmpeg.stdin.end(bytes)
  })
  return Buffer.concat(chunks, total)
}

async function transcriptionResponse(cred, request, init, deps) {
  try {
    const media = await requestAudioBytes(request, init)
    let bytes = media.bytes
    let contentType = media.contentType
    if (contentType.includes('multipart')) {
      const parsed = parseMultipartAudio(contentType, bytes)
      bytes = parsed.bytes
      contentType = parsed.contentType || media.filename || contentType
    }
    if (!bytes?.length) throw new MoBookError('转写请求里没有音频')
    const pcm = await decodeAudioToPcm16k(bytes, media.contentType)
    const out = await transcribePcm16k(cred, pcm, { deps })
    return Response.json({ text: String(out.text ?? '').trim() })
  } catch (error) {
    return new Response(JSON.stringify({ error: { message: error?.message ?? '语音识别失败', type: 'api_error' } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}

async function speechResponse(cred, parsed, deps) {
  try {
    const out = await speak(cred, { text: parsed?.input, voice: parsed?.voice, speed: parsed?.speed }, deps)
    return new Response(out.bytes, {
      status: 200,
      headers: { 'content-type': out.contentType, 'content-length': String(out.bytes.length) },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: { message: error?.message ?? '语音合成失败', type: 'api_error' } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}

async function imageResponseBody(cred, parsed, deps) {
  try {
    // magpie 传的是插件自己的模型 id（mobook-image）；想直接点具体模型时
    // 也可以传网关认的模型 id，这里原样透传。
    const requested = String(parsed?.model ?? '').replace(/^mobook\//, '')
    const model = requested && requested !== 'mobook-image' ? requested : ''
    const result = await generateImage(
      cred,
      {
        model,
        prompt: String(parsed?.prompt ?? ''),
        size: imageSizeFor(parsed?.size),
        image: parsed?.image,
        responseFormat: parsed?.response_format === 'b64_json' ? 'b64_json' : 'url',
      },
      deps,
    )
    return Response.json({ created: Math.floor(Date.now() / 1000), model: result.model, data: result.images })
  } catch (error) {
    return new Response(JSON.stringify({ error: { message: error?.message ?? '图片生成失败', type: 'api_error' } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
}
async function bodyTextOf(request, init) {
  if (init?.body != null) return typeof init.body === 'string' ? init.body : await new Response(init.body).text()
  if (request) return await request.clone().text()
  return ''
}

async function listModelsResponse(cred, deps) {
  try {
    // 与 provider.models 一致：缺 Key 时先补一次，否则「显示全部模型」只会列在售的 23 个。
    cred = await ensureApiKey(cred, deps)
    const show = cred?.tk ? await fetchModelShow(cred, { deps }).catch(() => new Map()) : new Map()
    let rows = curatedModels(show)
    // 与 provider.models 一致：开关打开且有 API Key 时列网关全部 id。
    if (deps?.showAll && cred?.apiKey) {
      const ids = await fetchGatewayModelIds(cred, deps).catch(() => [])
      rows = allModels(ids, show)
    }
    return Response.json({
      object: 'list',
      data: Object.keys(rows).map((id) => ({ id, object: 'model', owned_by: PROVIDER_ID })),
    })
  } catch (error) {
    return errResponse(error?.message ?? '模型目录读取失败', { expired: error?.signIn === 'expired' })
  }
}

async function chatResponse(cred, input, request, init, deps) {
  const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
  let body = {}
  try {
    body = JSON.parse(await bodyTextOf(request, init))
  } catch {
    return errResponse('请求体不是 JSON')
  }
  const model = String(body?.model ?? '').replace(new RegExp('^' + PROVIDER_ID + '/'), '')
  if (!model) return errResponse('缺少 model')
  // 图片输入走不了智能体会话（promptFromMessages 只会丢图），要原生网关。缺 key 时先自动
  // 补取一次并重试，用户侧不该看到这一步；真取不到才报错。
  const hasImage = (Array.isArray(body?.messages) ? body.messages : []).some((m) =>
    Array.isArray(m?.content) && m.content.some((part) => {
      const type = String(part?.type ?? '')
      return type.startsWith('image') || Boolean(part?.image_url) || Boolean(part?.image)
    }))
  if (hasImage) {
    const keyed = await ensureApiKey(cred, deps)
    if (!keyed.apiKey) {
      return errResponse('图片输入需要账号级 API Key（dcg-…）：插件已尝试自动补取但仍未取到，请重新登录墨宝一次；或去掉图片改用网页会话通道')
    }
    cred.apiKey = keyed.apiKey
    // 这里的 input 指向网页网关（本函数的 baseURL），原生对话在 model-gateway 上，
    // 先把路径换过去再重试；否则会把 /modelgw/v1/... 发错主机。
    return gatewayFetch(cred, gatewayUrlForChat(requestUrl), { ...init, method: 'POST', body: JSON.stringify(body) }, deps)
  }
  const prompt = promptFromMessages(body?.messages)
  if (!prompt.trim()) return errResponse('messages 里没有可发送的文本')
  const agentId = Number(cred?.agentId) || DEFAULT_AGENT_ID
  const signal = combineSignal(init?.signal, request?.signal)
  if (body?.stream === true) return sseResponse(cred, { model, prompt, agentId, signal, deps })
  try {
    const result = await ask(cred, { model, prompt, agentId, signal, ...(deps.ask ?? {}) }, deps)
    return Response.json({
      id: 'chatcmpl-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  } catch (error) {
    return errResponse(error?.message ?? '墨宝对话失败', { expired: error?.signIn === 'expired' })
  }
}

function combineSignal(a, b) {
  if (a && b) return AbortSignal.any([a, b])
  return a ?? b ?? undefined
}

// sseResponse 边轮询边把增量写进 SSE，客户端看起来和普通流式回答一样。
export function sseResponse(cred, { model, prompt, agentId, signal, deps }) {
  const encoder = new TextEncoder()
  const startedAt = Math.floor(Date.now() / 1000)
  const id = 'chatcmpl-' + Date.now().toString(36)
  const chunk = (delta, finish = null) => ({
    id,
    object: 'chat.completion.chunk',
    created: startedAt,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  // 客户端断开（取消流）时要主动中止轮询：否则后台会继续把一个没人要的回答跑完，
  // 白建一次会话、白花一次墨滴。取消信号与调用方传入的 signal 合并使用。
  const aborter = new AbortController()
  const cancelled = combineSignal(signal, aborter.signal)
  const stream = new ReadableStream({
    async start(controller) {
      // 取消之后 controller 不再接受写入：所有写都过这个闸，避免二次抛错。
      let closed = false
      const write = (text) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(text)) } catch { closed = true }
      }
      const send = (payload) => write('data: ' + JSON.stringify(payload) + '\n\n')
      send(chunk({ role: 'assistant', content: '' }))
      try {
        const result = await ask(
          cred,
          {
            model,
            prompt,
            agentId,
            signal: cancelled,
            onDelta: (delta) => send(chunk({ content: delta })),
            ...(deps?.ask ?? {}),
          },
          deps,
        )
        if (!result.text) send(chunk({ content: '' }))
        send(chunk({}, 'stop'))
        write('data: [DONE]\n\n')
      } catch (error) {
        const message = error?.message ?? '墨宝对话失败'
        // 错误帧按 OpenAI 的错误事件形状发，并且**要补发 [DONE]**：
        // 客户端靠这个哨兵结束流，缺了它就一直等着（正常路径是有的，错误路径原来没有）。
        send({ error: { message, type: error?.signIn === 'expired' ? 'authentication_error' : 'api_error' } })
        write('data: [DONE]\n\n')
      } finally {
        closed = true
        try { controller.close() } catch {}
      }
    },
    // 客户端中途断开：把 ask 的轮询一起停掉（ask 会把会话删掉再退出）。
    cancel() {
      aborter.abort()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

// syncTasks 把能自动做的任务做掉：未领取的领取，已完成的领墨滴。
// 需要“真的用一次专家/技能/批注”的任务，只能等用户在网页或客户端里做完再领。
export async function syncTasks(cred, deps = {}) {
  const list = await fetchTasks(cred, deps)
  const joined = []
  const claimed = []
  let credit = 0
  for (const task of list) {
    try {
      if (task.status === 'todo') {
        await joinTask(cred, task.activityId, deps)
        joined.push(task.title)
      } else if (task.status === 'claimable' && task.userTaskId) {
        const got = await claimTask(cred, task, deps)
        credit += got.point
        claimed.push(task.title)
      }
    } catch (error) {
      if (error?.signIn === 'expired') throw error
    }
  }
  return { joined, claimed, credit, total: list.length }
}

// imageModels 声明图片模型，magpie 会把它放进“图像模型”（设置 › 模型 › 图像），
// 而不混进对话模型列表。照 minimax 的写法：完整 OpenCode Model、显式 api、
// 不写 modalities/provider，output.text 为 false。
// imageConfigModels 是 config 里声明的那份：多一个 provider.npm（minimax 的 mediaConfigModels 也这样），
// magpie 靠它把模型归到“图像模型”。
export function imageConfigModels() {
  // config 里这份比 provider.models 多 provider.npm 与 modalities：magpie 靠它们把模型归到
  // 「图像模型」（drawIds），不混进对话模型列表。
  const models = imageModels()
  models['mobook-image'].provider = { npm: NPM }
  models['mobook-image'].modalities = { input: ['text', 'image'], output: ['image'] }
  return models
}

export function imageModels() {
  // magpie 用模型行里的 modalities.output=["image"] 判断“这是图像模型”，把它记进 drawIds
  // （设置 › 模型 › 图像模型）。对话模型列表（exposed）以 magpie 的刷新为准 —— 插件这边
  // 只要 modalities 正确，重载后 magpie 会把它从对话列表移到图像模型。
  return {
    'mobook-image': {
      id: 'mobook-image',
      name: 'Doubao-Seedream-5.0-Pro',
      api: { id: 'doubao-seedream-5-0-pro-260628', url: MEDIA_GATEWAY_V3, npm: NPM },
      status: 'active',
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      modalities: { input: ['text', 'image'], output: ['image'] },
      reasoning: false,
      tool_call: false,
      attachment: true,
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: true,
        toolcall: false,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: false, image: true, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: '',
      variants: {},
    },
  }
}
// speechModels 声明语音合成模型：magpie 的 /v1/audio/speech 按模型路由，
// 得有一个 output.audio=true 的模型，请求才会落到我们的 fetch。
export function speechModels() {
  return {
    'mobook-tts': {
      id: 'mobook-tts',
      name: 'Doubao Seed-Audio 1.0',
      api: { id: 'seed-audio-1.0', url: MEDIA_GATEWAY_V3, npm: NPM },
      status: 'active',
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: false, image: false, audio: true, video: false, pdf: false },
        interleaved: false,
      },
      release_date: '',
      variants: {},
    },
  }
}

export const SHOW_ALL_MODELS = 'show_all_models'

// 成长计划任务的运行状态按账号（uid）分目录：多账号登录时各自的日志与 pid 不打架。
// 状态放在插件自己的目录，不借客户端的数据目录（没装客户端也能用）：
//   有 magpie 配置目录 → <directory>/mobook-tasks；没有（OpenCode 宿主）→ ~/.mobook-plugin/tasks。
const TASKS_DIR = 'mobook-tasks'
const LEGACY_TASK_ROOT = path.join(os.homedir(), '.mobook-harness', TASKS_DIR)
export function pluginTaskRoot(directory) {
  const base = String(directory ?? '').trim()
  return base ? path.join(base, TASKS_DIR) : path.join(os.homedir(), '.mobook-plugin', 'tasks')
}
let taskRoot = LEGACY_TASK_ROOT
let taskRootExplicit = false
const RUNNER = fileURLToPath(new URL('./task-runner.mjs', import.meta.url))

// 测试用：把任务目录指到临时目录（显式设置后插件初始化不再覆盖）。
export function setTaskRoot(dir) {
  taskRoot = String(dir ?? '') || LEGACY_TASK_ROOT
  taskRootExplicit = true
}

// migrateTaskRoot 老版本写在 ~/.mobook-harness/mobook-tasks，首次启动复制到插件自己的目录。
function migrateTaskRoot(next) {
  try {
    if (existsSync(next) || !existsSync(LEGACY_TASK_ROOT)) return
    cpSync(LEGACY_TASK_ROOT, next, { recursive: true })
  } catch {}
}

// 测试用：替掉后台 runner 的启动（单测里不能真的 spawn 子进程）。
let taskRunnerOverride = null
export function setTaskRunner(fn) {
  taskRunnerOverride = typeof fn === 'function' ? fn : null
}

export function taskPaths(uid) {
  const id = String(uid ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '') || 'default'
  const dir = path.join(taskRoot, id)
  return {
    dir,
    log: path.join(dir, 'latest.jsonl'),
    previous: path.join(dir, 'previous.jsonl'),
    // runner 每 15 秒刷新一次；父进程看它判断 runner 是否还在跑（见 taskRunAlive）。
    heartbeat: path.join(dir, 'run.heartbeat'),
    // 当天任务全部完成时写这里；签到看到它就不再起任务线程。
    done: path.join(dir, 'done.json'),
  }
}

// HEARTBEAT_STALE_MS：心跳超过这个时间没更新，就认为 runner 已经不在了。
// runner 每 15 秒写一次，90 秒（约 6 次）没更新足够区分「进程被杀」与「机器睡了一会儿」。
const HEARTBEAT_STALE_MS = 90 * 1000

function readTaskLog(uid, limit = 30) {
  try {
    const text = readFileSync(taskPaths(uid).log, 'utf8').trim()
    if (!text) return []
    return text.split('\n').slice(-limit).map((line) => { try { return JSON.parse(line) } catch { return { line } } })
  } catch {
    return []
  }
}
// taskRunAlive 判断「这个账号的 runner 是不是还在跑」。
// 不用 kill(pid,0) 判活：PID 会被系统回收再分配给别的进程，
// 那时 kill(pid,0) 仍然成功，会把「别人的进程」当成「自己的 runner 还在跑」，
// 于是今天的成长任务永远起不来。
// 改看**心跳文件**：runner 自己每 15 秒刷新一次 run.heartbeat 的时间戳，
// 父进程只认「心跳在 90 秒内更新过」的才算活着；进程被杀时心跳自然停更，过期即视为没在跑。
export function taskRunAlive(uid) {
  const paths = taskPaths(uid)
  try {
    // 看心跳里写的时间戳，不是文件 mtime：
    // runner 每 15 秒重写一次文件，mtime 永远是「现在」，
    // 进程被杀后 mtime 也会停在最后一次写入的那刻——但那次写入可能就在几分钟前，
    // 判断不出「它已经死了多久」。心跳里记的是**当时**的时刻，进程死了就停在那一刻。
    const stamp = Number(readFileSync(paths.heartbeat, 'utf8').trim()) || 0
    if (!stamp) return false
    return Date.now() - stamp < HEARTBEAT_STALE_MS
  } catch {
    return false
  }
}
// ---- 后台 runner 的启动：必须离开 magpie 的 Job 对象 ----
//
// magpie 把插件宿主放进一个 Windows Job（实测宿主的 IsProcessInJob=True）。宿主退出时整个
// Job 被回收，宿主的子进程一起消失——原来 spawn(detached) 的 runner 就是这么死的：心跳停在
// 宿主退出那一刻、run.lock 残留、13 条任务只做完 2 条（2026-11-27 19:30 的真实事故）。
//
// 现在改由 WMI 创建进程：wscript（隐藏窗口）→ .cmd → runner。WMI 创建的进程父级是
// WmiPrvSE.exe，既不在宿主的 Job 里、也不在宿主的进程树里（实测 inJob=False），宿主回收后
// 继续跑；runner 需要的东西（代理/CA 环境、凭据）由 .cmd 和凭据文件带过去。
// WMI 不可用时退回原来的直接 spawn：还能跑，只是活不过宿主回收。
const LAUNCH_PS_TIMEOUT_MS = 15000
const LAUNCH_STALE_MS = 2 * 3600 * 1000
const CRED_STALE_MS = 10 * 60 * 1000
const ENV_PASSTHROUGH = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY']

// passThroughEnv 只带网络相关的环境变量：任务调度器/WMI 拉起的进程不会继承宿主的环境，
// 代理和自签 CA 不带过去，runner 会连不上墨宝。
function passThroughEnv(env = process.env) {
  const out = {}
  for (const key of ENV_PASSTHROUGH) {
    const value = String(env[key] ?? '').replace(/"/g, '').replace(/%/g, '%%')
    if (value) out[key] = value
  }
  return out
}

// sweepLauncherFiles 清掉上次留下的启动器与凭据文件（runner 正常起会自己删凭据）。
export function sweepLauncherFiles(dir, now = Date.now()) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('launch-') && !name.startsWith('cred-')) continue
      const full = path.join(dir, name)
      const maxAge = name.startsWith('cred-') ? CRED_STALE_MS : LAUNCH_STALE_MS
      try {
        if (now - statSync(full).mtimeMs > maxAge) unlinkSync(full)
      } catch {}
    }
  } catch {}
}

// writeTaskLaunchers 写三件套：.cmd 是真正的命令行与代理环境，.vbs 负责隐藏窗口，
// .ps1 用 WMI 创建进程。凭据只放独立的 JSON 文件（路径写进命令行），不落进这三个文件。
export function writeTaskLaunchers(paths, credPath, stamp = Date.now(), { execPath = process.execPath, runner = RUNNER, env = process.env } = {}) {
  const base = path.join(paths.dir, 'launch-' + stamp)
  const cmdPath = base + '.cmd'
  const vbsPath = base + '.vbs'
  const ps1Path = base + '.ps1'
  const lines = ['@echo off']
  for (const [key, value] of Object.entries(passThroughEnv(env))) lines.push('set "' + key + '=' + value + '"')
  lines.push('"' + execPath + '" "' + runner + '" "' + paths.log + '" "' + paths.heartbeat + '" "' + credPath + '"')
  writeFileSync(cmdPath, lines.join('\r\n') + '\r\n')
  writeFileSync(vbsPath, 'CreateObject("WScript.Shell").Run """' + cmdPath + '""", 0, False\r\n')
  const ps1 = [
    'param([string]$vbs)',
    "$ErrorActionPreference = 'Stop'",
    "$cmd = 'wscript.exe \"' + $vbs + '\"'",
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    'if (-not $r -or $r.ReturnValue -ne 0) { exit 1 }',
    'exit 0',
    '',
  ].join('\r\n')
  writeFileSync(ps1Path, ps1)
  return { cmdPath, vbsPath, ps1Path }
}

// runPowerShell 等 powershell 退出，只关心成功与否（异步，不阻塞宿主的其它插件调用）。
function runPowerShell(scriptPath, args = [], timeoutMs = LAUNCH_PS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], { windowsHide: true, stdio: 'ignore' })
    } catch {
      done(false)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      done(false)
    }, timeoutMs)
    timer.unref?.()
    child.on('error', () => { clearTimeout(timer); done(false) })
    child.on('close', (code) => { clearTimeout(timer); done(code === 0) })
  })
}

// startTaskRun 把这次账号的凭据交给 runner（不再让它去读本机客户端），日志也按 uid 分开。
// 锁：run.lock 用 wx 独占创建，抢不到就说明已经有 runner 在跑（看心跳判断它是不是还活着）。
// 不用 PID 判活——PID 会被回收再分配，kill(pid,0) 会把别人的进程当成自己的 runner，
// 于是今天的任务永远起不来。改用 runner 自己刷新的心跳文件（见 taskRunAlive）。
// 凭据写进 per-run 的 JSON 文件（mode 600），runner 读到就删；不再依赖环境变量，
// 因为 WMI/任务计划拉起的进程拿不到宿主的环境。
async function startTaskRun(cred) {
  if (!String(cred?.tk ?? '').trim() || !String(cred?.uid ?? '').trim()) {
    throw new MoBookError('启动成长计划任务需要有效的登录态和账号 uid')
  }
  const paths = taskPaths(cred.uid)
  mkdirSync(paths.dir, { recursive: true })
  const lockPath = path.join(paths.dir, 'run.lock')
  const grab = () => { try { writeFileSync(lockPath, String(Date.now()), { flag: 'wx' }); return true } catch { return false } }
  if (!grab()) {
    // 抢不到锁：心跳是新的 → runner 还活着，不重复起；心跳过期 → 上次异常退出，清理后重抢。
    if (taskRunAlive(cred?.uid)) return false
    try { unlinkSync(lockPath) } catch {}
    if (!grab()) return false
  }
  const stamp = Date.now()
  try {
    try { const old = readFileSync(paths.log, 'utf8'); if (old.trim()) writeFileSync(paths.previous, old) } catch {}
    writeFileSync(paths.log, '')
    // 心跳先写一次：父进程在 runner 真正起来之前就能看到「有东西在跑」。
    writeFileSync(paths.heartbeat, String(stamp))
    sweepLauncherFiles(paths.dir)
    const credPath = path.join(paths.dir, 'cred-' + stamp + '.json')
    writeFileSync(credPath, JSON.stringify(cred ?? {}), { mode: 0o600 })
    const { vbsPath, ps1Path } = writeTaskLaunchers(paths, credPath, stamp)
    // 在日志里留一行「怎么起的」：以后排查「runner 到底活没活过宿主回收」不用再猜。
    const noteLaunch = (mode) => {
      try { appendFileSync(paths.log, JSON.stringify({ time: new Date().toISOString(), step: 'launch', status: mode }) + '\n') } catch {}
    }
    if (await runPowerShell(ps1Path, [vbsPath])) {
      noteLaunch('wmi-outside-job')
      return true
    }
    // WMI 被策略禁用等：退回直接 spawn，至少这一次还能跑（活不过宿主回收，但不至于完全不做）。
    const child = spawn(process.execPath, [RUNNER, paths.log, paths.heartbeat, credPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MOBOOK_TASK_CRED: JSON.stringify(cred ?? {}) },
    })
    child.unref()
    noteLaunch('direct-fallback')
    return true
  } catch (error) {
    // 起不来就把心跳一并撤掉：否则接下来 90 秒都会被当成「已有任务在跑」，当天起不来新的。
    try { unlinkSync(paths.heartbeat) } catch {}
    try { unlinkSync(lockPath) } catch {}
    throw error
  }
}

// magpieCred 读 magpie 的账号存储（配置目录的 plugin-auth.json，与 minimax 插件同一模式），
// 让工具跟着插件里登录的账号走：默认取主账号（裸 mobook，否则按名字排第一个 mobook#…）。
// account 参数可显式指定账号；不属于本 provider 的账号一律拒绝。
async function magpieCred(directory, account) {
  if (!directory) return null
  let store
  try {
    store = JSON.parse(await readFile(path.join(directory, 'plugin-auth.json'), 'utf8'))
  } catch {
    return null
  }
  if (!store || typeof store !== 'object') return null
  const belongs = (key) => typeof key === 'string' && (key === PROVIDER_ID || key.startsWith(PROVIDER_ID + '#'))
  if (account !== undefined && account !== '' && !belongs(account)) {
    throw new MoBookError('account 必须是 mobook 或 mobook#… 账号')
  }
  const id = account || Object.keys(store).filter(belongs).sort((x, y) => (x === PROVIDER_ID ? -1 : y === PROVIDER_ID ? 1 : x < y ? -1 : x > y ? 1 : 0))[0]
  if (!id || !Object.hasOwn(store, id)) return null
  const cred = credOf(store[id])
  if (!cred?.tk) return null
  if (!cred.uid) {
    try { cred.uid = String((await fetchUser(cred)).id) } catch { return null }
  }
  return { ...cred, accountKey: id }
}

// toolCred 解析工具用哪份凭据：magpie 账号存储优先（插件里登录的账号），
// 没有 magpie 存储（纯 OpenCode 宿主）时退回本机桌面客户端登录态换用户令牌（只在内存里）。
async function toolCred(directory, account) {
  const fromStore = await magpieCred(directory, account)
  if (fromStore) return { cred: fromStore, source: 'magpie', accountKey: fromStore.accountKey }
  if (account) throw new MoBookError('magpie 账号存储不可用，无法按账号选择；请先在设置里登录墨宝')
  const state = await readClientState({})
  const token = await exchangeUserToken(state)
  return {
    source: 'desktop',
    accountKey: '',
    cred: {
      tk: token.token,
      apiKey: state.apiKey,
      uid: state.uid,
      name: '',
      orgId: ORG_ID,
      appId: 40,
      platform: 'web',
      botToken: state.botToken,
    },
  }
}
export const SKIP_ACTIVITY_CHAT = 'skip_activity_chat'

// 老凭据/登录时没拿到 key 的账号：首次用到时按桌面作用域自动补取一次，放内存里缓存 10 分钟。
// 取不到也记一笔（60 秒内不再重试）：宁可当次失败，也不要每个请求都去撞一次接口。
const lazyKeys = new Map()
const lazyKeyMisses = new Map()
const LAZY_KEY_TTL = 10 * 60 * 1000
const LAZY_KEY_MISS_TTL = 60 * 1000
async function ensureApiKey(cred, deps = {}) {
  if (cred?.apiKey) return cred
  const id = String(cred?.uid ?? '') || 'anonymous'
  const hit = lazyKeys.get(id)
  if (hit && Date.now() - hit.at < LAZY_KEY_TTL) return { ...cred, apiKey: hit.key }
  const miss = lazyKeyMisses.get(id)
  if (miss && Date.now() - miss < LAZY_KEY_MISS_TTL) return cred
  try {
    const cfg = await fetchApiKeyConfig(cred, deps)
    if (cfg?.apiKey) {
      lazyKeys.set(id, { key: cfg.apiKey, at: Date.now() })
      lazyKeyMisses.delete(id)
      return { ...cred, apiKey: cfg.apiKey }
    }
  } catch {}
  lazyKeyMisses.set(id, Date.now())
  return cred
}

// SIGN_IN_PAGE 是“粘贴 Cookie”方式先打开的页面：墨宝成长中心，登录入口就在那一页，
// 用户登录后可直接在浏览器里复制 Cookie 再粘回来。
export const SIGN_IN_PAGE = 'https://mobook.me/growth-center'

// authorizeBySession 用一段 Cookie（_tk + _uid）完成登录：只复用登录态，不登录、不建设备。
// magpie 的“粘贴 Cookie”流程和 OpenCode 的自有对话框都走这里。
async function authorizeBySession(session) {
  let parsed
  try {
    parsed = parseSession(session)
  } catch (error) {
    return { type: 'failed', error: String(error?.message ?? error) }
  }
  // 只给 _tk 不行：接口签名的 _userId 和后续请求都要 _uid，_uid 就在同一段 Cookie 里。
  if (!parsed.uid) {
    return {
      type: 'failed',
      error: '只给 _tk 不够：请粘贴整段 Cookie（_tk=…; _uid=…），_uid 在同一个 Cookie 里',
    }
  }
  // 智能体固定用默认的“墨宝”（13），登录时不再问。
  const agentId = DEFAULT_AGENT_ID
  const cred = { tk: parsed.tk, uid: parsed.uid, orgId: ORG_ID, agentId }
  let user = null
  try {
    user = await fetchUser(cred)
  } catch (error) {
    if (error?.signIn === 'expired') {
      return { type: 'failed', error: '这个 _tk 已经失效了：请重新打开 ' + SIGN_IN_PAGE + ' 登录，再从 Cookie 里复制 _tk 与 _uid' }
    }
    return { type: 'failed', error: String(error?.message ?? '墨宝登录态校验失败') }
  }
  const uid = String(user?.id ?? cred.uid)
  const name = accountNameOf(user, uid)
  // 账号级 API Key：贴 Cookie 登录也能走原生网关，并解锁图片 / TTS / ASR。
  const apiKeyConfig = await fetchApiKeyConfig(cred).catch(() => null)
  const bot = await ensureBot(cred).catch(() => null)
  const device = await resolveHostDevice(uid)
  // 客户端名称由插件本地生成（Windows 自动命名格式），不被服务端 bot 名覆盖；
  // 服务端 bot 名只作参考存进 webBotName，不参与设备身份。
  if (device && bot?.name) device.webBotName = String(bot.name)
  return {
    type: 'success',
    access: parsed.tk,
    refresh: '',
    expires: Date.now() + 14 * 24 * 3600 * 1000,
    accountId: name,
    uid,
    phone: String(user?.mobile ?? ''),
    metadata: {
      tk: parsed.tk,
      uid,
      orgId: ORG_ID,
      appId: Number(device?.appId) || 40,
      platform: device?.clientType === 'desktop' ? 'desktop' : 'web',
      agentId,
      name,
      mobile: String(user?.mobile ?? ''),
      site: OFFICIAL_SITE,
      method: 'paste',
      ...(bot?.token ? { botToken: bot.token, botId: bot.id } : {}),
      ...(apiKeyConfig
        ? {
            apiKey: apiKeyConfig.apiKey,
            apiKeyBaseUrl: apiKeyConfig.baseUrl,
            apiKeyDefaultModel: apiKeyConfig.defaultModel,
          }
        : {}),
      ...(device ? { device } : {}),
    },
  }
}
// authorizeFromLocalClient 读本机墨宝客户端的登录态并换一份登录态出来（导入本机客户端登录态这条方式）。
// 单独成函数：宿主契约要求 authorize 只返回 {url, instructions, method, callback}，
// 真正的登录放在 callback 里（OpenCode 2.x 的适配器只会走 r.callback()）。
async function authorizeFromLocalClient() {
  let state
  try {
    state = await readClientState({})
  } catch (error) {
    return { type: 'failed', error: String(error?.message ?? error) }
  }
  let result
  try {
    result = await exchangeUserToken(state)
  } catch (error) {
    return { type: 'failed', error: '读取客户端登录态失败：' + String(error?.message ?? error) }
  }
  const cred = {
    tk: result.token,
    uid: state.uid,
    orgId: ORG_ID,
    agentId: DEFAULT_AGENT_ID,
    appId: appIdForApi(state.appId),
    platform: 'desktop',
  }
  const user = await fetchUser(cred).catch(() => null)
  const uid = String(user?.id ?? state.uid ?? '')
  const name = accountNameOf(user, uid)
  const apiKeyConfig = state.apiKey
    ? { apiKey: state.apiKey }
    : await fetchApiKeyConfig(cred).catch(() => null)
  const bot = await ensureBot(cred).catch(() => null)
  // 本机客户端那个账号：resolveHostDevice 会走 reuse，照搬它的硬件指纹。
  const device = await resolveHostDevice(uid)
  const deviceMeta = {
    ...(device ?? {}),
    clientType: 'desktop',
    appId: appIdForApi(state.appId),
    appVersion: String(state.appVersion || ''),
  }
  // 名称：客户端账号名优先；reuse 模式下用本机 hostname 作为设备名。
  if (!deviceMeta.botName) deviceMeta.botName = localHostName()
  return {
    type: 'success',
    access: result.token,
    refresh: '',
    expires: result.expiresAt && result.expiresAt > Date.now() ? result.expiresAt : Date.now() + 14 * 24 * 3600 * 1000,
    accountId: name,
    uid,
    phone: String(user?.mobile ?? ''),
    metadata: {
      tk: result.token,
      uid,
      orgId: ORG_ID,
      appId: appIdForApi(state.appId),
      platform: 'desktop',
      agentId: DEFAULT_AGENT_ID,
      name,
      mobile: String(user?.mobile ?? ''),
      site: OFFICIAL_SITE,
      method: 'local-client',
      ...(state.botToken ? { botToken: state.botToken } : bot?.token ? { botToken: bot.token } : {}),
      ...(bot?.id ? { botId: bot.id } : {}),
      ...(apiKeyConfig?.apiKey
        ? {
            apiKey: apiKeyConfig.apiKey,
            apiKeyBaseUrl: apiKeyConfig.baseUrl,
            apiKeyDefaultModel: apiKeyConfig.defaultModel,
          }
        : {}),
      device: deviceMeta,
    },
  }
}

export const MoBookAuthPlugin = async ({ magpie, directory } = {}) => {
  // 任务状态目录：插件自己的位置（测试里用 setTaskRoot 显式指定时不覆盖）。
  if (!taskRootExplicit) {
    const next = pluginTaskRoot(directory)
    migrateTaskRoot(next)
    taskRoot = next
  }
  // magpie 的插件开关：读当前值，改完不用重载（每次取模型时再读）。
  const showAllModels = () => {
    try {
      return magpie?.option?.(PROVIDER_ID, SHOW_ALL_MODELS) === true
    } catch {
      return false
    }
  }
  const recordActivity = () => {
    // 无 magpie 宿主时按文档默认「发活跃对话」；读选项失败同样按默认走。
    if (!magpie) return true
    try {
      return magpie?.option?.(PROVIDER_ID, SKIP_ACTIVITY_CHAT) !== true
    } catch {
      return true
    }
  }
  return {
    config: async (config) => {
      config.provider ??= {}
      const previous = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: NPM,
        api: API_BASE,
        ...previous,
        // 图像模型在 config 中声明以进入 Images 抽屉；当前宿主也可能将其留在对话列表，
        // 这是宿主 pluginTalks 的限制（#2792 之前），不能仅靠插件配置分离。
        models: { ...bootstrapModels(), ...(previous.models ?? {}), ...imageConfigModels(), ...speechModels() },
      }
    },
    provider: {
      id: PROVIDER_ID,
      // 按账号实时同步目录：模型上线/下线、上下文窗口变化都会跟着变。
      async models(provider, { auth } = {}) {
        let cred = credOf(auth)
        const fallback = provider?.models ?? bootstrapModels()
        if (!cred) return fallback
        // 老凭据可能没存 API Key：这里也补一次（10 分钟缓存），否则「显示全部模型」会静默只列 23 个。
        cred = await ensureApiKey(cred)
        try {
          // 目录以网页端在售的 23 个模型为准（都有倍率）；model-show 提供实时显示名与倍率。
          const show = cred.tk ? await fetchModelShow(cred).catch(() => new Map()) : new Map()
          let rows = curatedModels(show)
          // 选项打开时把网关的全部 id 也列上（在售的仍用真实倍率/窗口）。
          if (showAllModels() && cred.apiKey) {
            const ids = await fetchGatewayModelIds(cred).catch(() => [])
            rows = allModels(ids, show)
          }
          if (!Object.keys(rows).length) return fallback
          // 图像模型必须经 models hook 声明才能进 Images 抽屉（宿主 Drawers 读 pp.Models）。
          // 当前宿主 pluginTalks 会同时把它留在对话列表；要「只进 Images」需宿主特例（patches/draw_mobook.go，重编译 magpie）。
          return { ...rows, ...imageModels(), ...speechModels() }
        } catch (error) {
          if (error?.signIn === 'expired') throw error
          return fallback
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,
      // 插件选项里的开关（设置 › 插件 › 选项），读的时候用 input.magpie.option
      options: [
        {
          key: SHOW_ALL_MODELS,
          label: '显示全部模型（含历史/内部别名）',
          description:
            '默认只列网页端在售的 23 个模型（都有倍率与厂商窗口）。打开后把网关的 62 个 id 全列出来，' +
            '历史/内部别名（-l3、-unsafe、旧版本号）没有公开倍率，上下文按 262144 / 131072 兜底。改完重新载入插件（或刷新模型列表）生效。',
        },
        {
          key: SKIP_ACTIVITY_CHAT,
          label: '签到时不发活跃对话',
          description: '签到流程默认会用一次短对话把“活跃地图”记成活跃（会花 1-5 墨滴），打开这个开关就跳过。',
        },
      ],
      methods: [
        // 手机号 + 短信验证码，登记为一台客户端。
        // 结构照 magpie-plugin-loomy-auth：authorize 里先发短信，返回 method: 'code'，
        // 由 magpie / OpenCode 再问一次验证码，callback(code) 里换登录态。全程不开网页。
        // 登录带 deviceToken，服务端按设备登记会话，不会顶掉网页端或其它已登录设备；
        // 登录后先拉客户端列表，已有客户端就复用，不重复登记设备。
        {
          type: 'oauth',
          label: '手机号 + 短信验证码（登记为客户端，不顶其他会话）',
          prompts: [
            {
              type: 'text',
              key: 'phone',
              message: '手机号（11 位中国大陆手机号）',
              placeholder: '13800000000',
            },
          ],
          async authorize(inputs = {}) {
            // authorize 不抛异常：失败也返回 failed，用户才看得到原因。
            // 失败也按宿主契约给 {url, instructions, method, callback}：
            // 原因写在 callback 的返回值里（{type:'failed', error}），
            // 免得 OpenCode 2.x 的适配器只看到没有 callback 的对象而报不出原因。
            let phone = ''
            try {
              phone = String(inputs?.phone ?? '').replace(/\D/g, '')
              if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请填写 11 位中国大陆手机号')
            } catch (error) {
              const message = String(error?.message ?? error)
              return { url: '', instructions: message, method: 'auto', callback: async () => ({ type: 'failed', error: message }) }
            }
            try {
              await sendSmsCode(phone)
            } catch (error) {
              const message = '验证码发送失败：' + (error?.message ?? error)
              return { url: '', instructions: message, method: 'auto', callback: async () => ({ type: 'failed', error: message }) }
            }
            const masked = phone.slice(0, 3) + '****' + phone.slice(-4)
            const invite = defaultInviteChannel()
            return {
              url: '',
              method: 'code',
              instructions:
                '验证码已发送至 ' + masked + '，输入短信验证码完成登录。与桌面端相同，本次登录会登记为一台客户端，不会顶掉已登录的网页或其它设备。' +
                (invite ? '新账号首次登录会记到邀请渠道 ' + invite + '。' : ''),
              callback: async (code) => {
                // 客户端登记：deviceToken 只按手机号派生，因此同一个用户在任何机器上都是同一台客户端；
                // 名称按真实 uid 算（登录后才知道），格式 DESKTOP-<MD5(uid) 前 7 位>。
                // 登录时带 deviceToken，服务端按设备登记会话，不再顶掉网页端。
                const deviceId = deviceIdFrom('phone:' + phone)
                let result
                try {
                  // 邀请渠道跟着登录一起交给墨宝：新账号记到该渠道，老账号不受影响。
                  result = await loginBySms(phone, String(code ?? ''), { channel: invite, deviceToken: deviceId })
                } catch (error) {
                  return { type: 'failed', error: '登录失败：' + (error?.message ?? error) }
                }
                // 请求作用域保持 web(40)：成长计划任务清单按 _appId 区分（40=15 项，200=12 项）。
                // deviceToken 只负责把这次登录登记成客户端、不顶网页会话，不改变请求作用域。
                const cred = { tk: result.token, uid: result.uid, orgId: ORG_ID, appId: 40, platform: 'web', agentId: DEFAULT_AGENT_ID, ...(deviceId ? { deviceId } : {}) }
                const user = await fetchUser(cred).catch(() => null)
                const uid = String(user?.id ?? result.uid ?? '')
                const accountId = accountNameOf(user, masked)
                // 客户端名称按用户固定：同一个 uid 永远得到同一个 DESKTOP-XXXXXXX。
                const botName = windowsClientName(uid)
                const preDevice = await resolveDevice({ uid, mode: 'web', ...(deviceDetectOverride ? { detect: deviceDetectOverride } : {}) }).catch(() => null)
                // 会话/笔记仍用 web bot（成长任务是 web 功能）；客户端设备单独登记。
                const bot = await ensureBot(cred).catch(() => null)
                // 客户端登记：在桌面作用域下按稳定 deviceId 复用/登记一台设备（不顶网页端）。
                // 复用按「本插件为这个用户生成的客户端名」精确匹配：同一 uid 永远得到同一个
                // DESKTOP-XXXXXXX。桌面客户端自己登记的 bot 名称不同，不会被误认成插件的客户端；
                // 匹配不到才走登记（deviceToken 恒定，服务端对同一 deviceId 也只会登记一次）。
                const clientCred = { ...cred, appId: appIdForApi(110), platform: 'desktop' }
                const existingClient = await listBots(clientCred).catch(() => [])
                const mine = existingClient.find((b) => String(b?.name ?? '').trim().toUpperCase() === botName.toUpperCase())
                const reused = !!mine
                const deviceBot = reused ? mine : await ensureDeviceBot(clientCred, { deviceId, botName }).catch(() => null)
                const apiKeyConfig = await fetchApiKeyConfig(cred).catch(() => null)
                const device = {
                  mode: 'client',
                  reused,
                  clientType: 'desktop',
                  deviceId,
                  clientId: deviceBot?.id ?? 0,
                  botName: String(deviceBot?.name || botName),
                  localDeviceName: botName,
                  appId: appIdForApi(110),
                  ...(preDevice?.fingerprint ? { fingerprint: preDevice.fingerprint } : {}),
                  ...(preDevice?.fingerprintVersion ? { fingerprintVersion: preDevice.fingerprintVersion } : {}),
                }
                return {
                  type: 'success',
                  access: result.token,
                  refresh: '',
                  expires: Date.now() + 14 * 24 * 3600 * 1000,
                  accountId,
                  uid,
                  phone,
                  metadata: {
                    tk: result.token,
                    uid,
                    orgId: ORG_ID,
                    appId: 40,
                    platform: 'web',
                    agentId: DEFAULT_AGENT_ID,
                    name: accountId,
                    mobile: String(user?.mobile ?? masked),
                    site: OFFICIAL_SITE,
                    method: 'sms',
                    channel: result.channel,
                    isNewUser: result.isNewUser,
                    ...(bot?.token ? { botToken: bot.token, botId: bot.id } : {}),
                    ...(apiKeyConfig
                      ? {
                          apiKey: apiKeyConfig.apiKey,
                          apiKeyBaseUrl: apiKeyConfig.baseUrl,
                          apiKeyDefaultModel: apiKeyConfig.defaultModel,
                        }
                      : {}),
                    ...(device ? { device } : {}),
                  },
                }
              },
            }
          },
        },
        // 复用本机客户端登录态：不用验证码、不顶会话，客户端类型/设备指纹/名称原样沿用。
        {
          type: 'oauth',
          label: '导入本机客户端登录态（复用客户端类型 / 设备指纹 / 名称）',
          prompts: [],
          async authorize() {
            // 宿主的契约是 authorize 返回 {url, instructions, method, callback}（见插件 README）：
            // 登录本身在 callback 里做。OpenCode 2.x 的适配器只会走 r.callback()，
            // authorize 直接返回 {type:'success'} 会在那边抛「r.callback is not a function」。
            // 这里统一按契约返回，1.x / magpie 宿主同样认这个形状。
            return {
              url: '',
              instructions: '正在读取本机墨宝客户端的登录态…',
              method: 'auto',
              callback: async () => await authorizeFromLocalClient(),
            }
          },
        },
        // 可重复的登录：先打开墨宝页面方便登录，再把 Cookie 粘回来，不惊动任何会话。
        {
          type: 'oauth',
          label: '粘贴整段 Cookie（会先打开墨宝页面，可重复使用）',
          prompts: [],
          // authorize 分两种调用：
          //   1) 没有 session（magpie 界面点这个方式）→ 返回一个“打开浏览器 + 回填”的阶段；
          //   2) 直接给了 session（OpenCode 的自有对话框 / 测试）→ 当场校验并登录。
          async authorize(inputs = {}) {
            const typed = String(inputs?.session ?? '').trim()
            if (!typed) {
              // magpie 会把 url 交给系统浏览器打开；method:'code' 时它再给一个输入框，
              // 用户把 Cookie 粘进那个框，就走下面的 callback。
              return {
                url: SIGN_IN_PAGE,
                method: 'code',
                instructions:
                  '已用浏览器打开 ' + SIGN_IN_PAGE + '：先在那里登录（手机号或已有账号都行），' +
                  '然后按 F12 → Application/存储 → Cookies → https://mobook.me，' +
                  '把 _tk 与 _uid 两行一起复制成 `_tk=…; _uid=…` 粘到下面的输入框。' +
                  '这一步只是复用登录态，不会顶掉网页端或其它设备。',
                callback: async (code) => authorizeBySession(String(code ?? '')),
              }
            }
            // 直接给了 session（OpenCode 的自有对话框 / 测试）→ 当场校验并登录。
            // 仍按宿主契约返回 {url, instructions, method, callback}：
            // authorize 直接返回 {type:'success'} 在 OpenCode 2.x 的适配器里会崩
            // （那边只会走 r.callback()）。1.x / magpie 宿主同样认这个形状。
            return {
              url: '',
              instructions: '正在校验墨宝登录态…',
              method: 'auto',
              callback: async () => await authorizeBySession(typed),
            }
          },
        },
      ],
      // loader 只把 baseURL 给 SDK；真正的请求由 chatFetch 接手。
      async loader(getAuth) {
        const auth = await getAuth()
        let cred = credOf(auth)
        if (!cred) return {}
        if (!cred.uid) {
          try {
            cred.uid = String((await fetchUser(cred)).id)
          } catch {
            return {}
          }
        }
        // 老凭据里可能没存 key（登录时还是按网页作用域取的），这里自动补一次并缓存 10 分钟。
        cred = await ensureApiKey(cred)
        // 有桌面客户端的 API Key 就走原生 OpenAI 网关：真流式、有 token 用量。
        if (cred.apiKey) {
          return {
            baseURL: MODEL_GATEWAY,
            apiKey: cred.apiKey,
            fetch: (input, init) => gatewayFetch(cred, input, init),
          }
        }
        // 只有网页会话（_tk）时退回墨宝智能体会话。
        return {
          baseURL: API_BASE,
          apiKey: 'mobook-session',
          fetch: (input, init) => chatFetch(cred, input, init, { showAll: showAllModels() }),
        }
      },
      // 网页会话没有续期接口，过期只能重新登录；
      // 但客户端导入的账号可以拿 botToken 再换一次用户令牌，所以这里能续。
      async refresh(auth) {
        const cred = credOf(auth)
        if (!cred?.botToken) return undefined
        try {
          const next = await exchangeUserToken({ botToken: cred.botToken, uid: cred.uid, appId: cred.appId })
          if (!next?.token) return undefined
          return {
            access: next.token,
            expires: next.expiresAt || Date.now() + 14 * 24 * 3600 * 1000,
            metadata: { ...(auth?.metadata ?? {}), tk: next.token, expiresAt: next.expiresAt },
          }
        } catch {
          return undefined
        }
      },
      // 卡片上显示真实墨滴余额；读取不计费。
      async usage(getAuth) {
        const auth = await getAuth()
        const cred = credOf(auth)
        if (!cred?.tk) return { error: '未登录墨宝', signIn: 'kept' }
        let balance
        try {
          balance = await fetchBalance(cred)
        } catch (error) {
          if (error?.signIn === 'expired') return { error: error.message, signIn: 'expired', windows: [] }
          return { error: error?.message ?? '墨滴余额读取失败', windows: [] }
        }
        // 已消耗：读墨滴流水（flowQueryType 1 获得 / 2 消耗）。
        // 获得 - 消耗 = 余额，所以这条流水天然就是用量进度条：分子消耗、分母获得。
        let ledger = null
        try {
          ledger = await fetchLedgerTotals(cred, { accountId: balance.accountId })
        } catch {
          ledger = null
        }
        const windows = []
        // 墨滴用量只看「还有效的额度」：分母是所有未过期批次的发放总和，
        // 分子 = 分母 − 账户当前余额（余额由 /point/getUserPointAccount 给出，过期批次的额度不进余额）。
        // 这样进度条与卡片上的余额天然对账，不做时间窗口推断。
        // 重置时间用未过期批次里最近的一个到期时间。
        if (ledger && ledger.income > 0) {
          const total = ledger.income ?? 0
          const spent = Math.max(0, total - Number(balance.amount || 0))
          const span = ledger.nearestExpiry > ledger.earliestCreated && ledger.earliestCreated > 0
            ? Math.round((ledger.nearestExpiry - ledger.earliestCreated) / 1000)
            : undefined
          windows.push({
            name: '墨滴用量',
            used: total > 0 ? (100 * spent) / total : 0,
            amount: spent,
            limit: total,
            unit: '墨滴',
            // 到期用 runsOutAt/runsOut（「N 墨滴 将于 <时间> 过期」），不用 resetsAt（那是「重置于」，额度是逐笔过期而非整体重置）。
            ...(ledger.nearestExpiry
              ? {
                  runsOutAt: new Date(ledger.nearestExpiry).toISOString(),
                  runsOut: Math.min(total, ledger.expiringAtNearest || 0),
                }
              : {}),
            ...(span ? { span } : {}),
            display:
              '已用 ' + spent + ' / ' + total + ' 墨滴 · 余额 ' + balance.amount +
              (ledger.nearestExpiry && ledger.expiringAtNearest > 0
                ? ' · ' + ledger.expiringAtNearest + ' 墨滴将于 ' + beijingTimeLabel(ledger.nearestExpiry) + ' 过期'
                : '') +
              (ledger.expiredCount > 0 ? ' · 已过期 ' + ledger.expiredCount + ' 笔' : '') +
              (ledger.truncated ? ' · 流水超出读取上限，数字为近似' : ''),
          })
        }
        if (ledger) {
          // 多个到期批次合并成一行：余额相加，用 runsOutAt/runsOut 标出“最早作废的一笔”，
          // 卡片上就只剩一个到期标记，不再每个池子一行。
          const pools = ledger.pools ?? []
          if (pools.length) {
            const poolBalance = pools.reduce((n, pool) => n + pool.remaining, 0)
            const first = pools[0]
            windows.push({
              name: '充值/礼包（' + pools.length + ' 笔）',
              display: '剩余 ' + poolBalance + ' 墨滴',
              balance: poolBalance,
              unit: '墨滴',
              aside: true,
              ...(first?.expiresAt
                ? { runsOutAt: new Date(first.expiresAt).toISOString(), runsOut: first.remaining }
                : {}),
            })
          }
        }
        // 录音时长：只报「已用时长 + 消耗积分」，免费额度/超出计费这类说明不放在卡片上。
        try {
          const rec = await fetchRecordingQuota(cred)
          const usage = await fetchRecordingUsage(cred)
          if (rec.freeDurationSeconds > 0) {
            const billedMin = usage.points > 0 && rec.exchangePoints > 0
              ? Math.round(usage.points / rec.exchangePoints)
              : 0
            windows.push({
              name: '录音时长',
              display:
                '已用 ' + billedMin + ' 分钟 · ' + usage.points + ' 积分' +
                (usage.truncated ? ' · 流水超出读取上限，数字为近似' : ''),
              unit: '分钟',
              aside: true,
            })
          }
        } catch {}
        // 活跃地图：连续活跃天数 + 补登卡；成长计划没做完时再带一行「任务 x/y」。
        try {
          const active = await fetchActiveMap(cred)
          let progress = ''
          try { progress = taskProgressText(await fetchTasks(cred)) } catch {}
          windows.push({
            name: '活跃地图',
            display: '连续活跃 ' + active.streak + ' 天 · 补登卡 x ' + active.makeupCards + (progress ? ' · ' + progress : ''),
            unit: '天',
            aside: true,
          })
        } catch {}

        const user = cred.name || cred.mobile || ''
        return { ...(user ? { user } : {}), windows }
      },
      // 每日签到 + 成长计划任务：签到活动和任务清单都从账号实时读。
      async checkin(getAuth) {
        const auth = await getAuth()
        const cred = credOf(auth)
        if (!cred?.tk) return { outcome: 'failed', message: '未登录墨宝' }
        // 旧凭据可能没有 uid；先从当前会话解析，解析失败就不启动成长任务，绝不回退到本机另一个账号。
        if (!cred.uid) {
          try { cred.uid = String((await fetchUser(cred)).id ?? '') } catch {}
        }
        // 两个线程同时起：签到流程照旧，成长计划任务交给后台 runner（互不等待、互不干扰）。
        // 当天任务已经在 done.json 里标成全部完成，就不再起任务线程。
        const paths = cred.uid ? taskPaths(cred.uid) : null
        let taskNote = ''
        if (!cred.uid) {
          taskNote = '成长计划任务：账号 uid 无法解析，已安全跳过'
        } else if (readDoneAt(paths.dir)) {
          taskNote = '成长计划任务：今日已全部完成，跳过'
        } else {
          try {
            const start = taskRunnerOverride ?? startTaskRun
            taskNote = (await start(cred)) ? '成长计划任务：后台已开始' : '成长计划任务：已有任务在跑'
          } catch (error) {
            taskNote = '成长计划任务启动失败：' + (error?.message ?? error)
          }
        }
        let activity
        try {
          activity = await checkinActivity(cred)
        } catch (error) {
          if (error?.signIn === 'expired') throw error
          return { outcome: 'failed', message: error?.message ?? '签到活动读取失败' }
        }
        if (!activity) return { outcome: 'inactive', message: '墨宝当前没有进行中的签到活动' }
        const notes = []
        let credit = 0
        // 签到本身由服务端管（一天只让领一次），签到线程与后台 runner 各领一次，
        // 多出来的那次会被服务端拒掉——不会多花钱。所以这里不额外加锁：
        // 加了反而会挡住当天的重试（例如第一次网络失败后还想再试）。
        // 真正会双花墨滴的是下面那条活跃对话，服务端不管，交给当天的标记管。
        if (activity.claimedToday) {
          notes.push('今日已签到（本期 ' + activity.claimedDays + ' 天 / 已领 ' + activity.totalClaimed + ' 墨滴）')
        } else {
          const before = activity
          let claimError = null
          await claimCheckin(cred, activity.activityId).catch((error) => {
            if (error?.signIn === 'expired') throw error
            claimError = error
          })
          // 复查一次再定性：领取成功、或另一条线程（后台 runner）刚刚先领掉了，都算签到成功。
          // 只有复查确认「今天仍未签到、总额也没涨」才是真的失败——否则两个线程抢着领时,
          // 抢输的那一方会把一条「签到请求失败」写进卡片（这正是 1.16.0 想消掉的现象）。
          const after = await checkinActivity(cred).catch(() => null)
          const gained = after ? Math.max(0, after.totalClaimed - before.totalClaimed) : 0
          if (gained > 0) {
            credit += gained
            notes.push('签到 +' + gained + ' 墨滴')
          } else if (after?.claimedToday === true) {
            notes.push(claimError ? '签到已由后台任务完成' : '签到已提交')
          } else if (claimError) {
            notes.push('签到请求失败：' + (claimError?.message ?? claimError))
          } else {
            notes.push('签到已提交')
          }
          // 签到失败不重试第二次（服务端一天只让领一次，重试也是白请求）。
        }
        let tasks = { joined: [], claimed: [], credit: 0, total: 0 }
        try {
          tasks = await syncTasks(cred)
        } catch (error) {
          if (error?.signIn === 'expired') throw error
          notes.push('任务同步失败：' + (error?.message ?? error))
        }
        credit += tasks.credit
        if (tasks.claimed.length) notes.push('领取任务奖励 ' + tasks.claimed.length + ' 项（+' + tasks.credit + ' 墨滴）')
        if (tasks.joined.length) notes.push('已领取任务 ' + tasks.joined.length + ' 项待完成')
        if (recordActivity()) {
          // 活跃对话是真正花钱的那一步（服务端不管一天几次），后台 runner 也会做，
          // 两个进程都做一遍 = 双倍墨滴。用当天的标记决定谁来做：
          //   - 拿不到 → 今天已经有人做了，跳过；
          //   - 拿得到 → 做；只有真的发出去了才留下标记，失败要释放（今天还能重试）。
          const activityClaim = claimDaily(paths?.dir, 'activity')
          try {
            if (!activityClaim) {
              notes.push('活跃地图：今日已活跃，跳过打卡对话')
            } else if (await isActiveToday(cred).catch(() => false)) {
              // 活跃地图打卡前先查今天是否已经活跃：已经是当日活跃就跳过对话，省一笔墨滴。
              notes.push('活跃地图：今日已活跃，跳过打卡对话')
            } else {
              const act = await recordActivityChat(cred)
              notes.push(act.active ? '活跃地图：今日已活跃' : '活跃地图：对话已发，但今天仍未标记活跃')
              if (!act.active) activityClaim.release()
            }
          } catch (error) {
            if (error?.signIn === 'expired') throw error
            notes.push('活跃对话失败：' + (error?.message ?? error))
            activityClaim?.release()
          }
        }
        if (taskNote) notes.push(taskNote)
        const message = notes.join('；')
        if (credit > 0) return { outcome: 'claimed', credit, message }
        return { outcome: 'done', message }
      },
    },
    tool: {
      task_status: {
        description: '墨滴成长计划：列出全部任务、状态和奖励，只读，不花钱。默认操作插件里登录的主账号；没有插件账号时退回本机桌面客户端账号。',
        args: {
          type: 'object',
          properties: { account: { type: 'string', description: '可选：指定账号（mobook 或 mobook#…）；默认主账号' } },
          required: [],
        },
        async execute({ account } = {}) {
          try {
            const { cred, source, accountKey } = await toolCred(directory, account)
            const paths = taskPaths(cred.uid)
            const tasks = await fetchTasks(cred)
            return {
              ok: true,
              account: { uid: String(cred.uid ?? ''), name: String(cred.name ?? ''), source, key: accountKey },
              tasks: tasks.map((task) => ({ id: task.activityId, title: task.title, status: task.status, reward: task.reward })),
              logPath: paths.log,
              log: readTaskLog(cred.uid),
            }
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) }
          }
        },
      },
      tasks: {
        description:
          '做墨滴成长计划任务：补领未领取任务、领已完成奖励（同步，几秒）；actions=true 时把可自动化的动作（签到、活跃对话、图片笔记、录音笔记、知识库、桌面端对话、定时任务、技能、小红书、专家会话）交给后台 runner：从易到难逐条执行，每条「读进度→运行→核验→先领奖→再清理」，相邻动作等待=该类真人最快时间+15–30 秒随机（最后一个不等），进度看返回的 logPath（JSONL）。结束自动删除本次创建的会话/笔记/知识库文件/定时任务；部分动作会临时安装产品并在结束时卸载。会花少量墨滴。默认操作插件里登录的主账号；没有插件账号时退回本机桌面客户端账号。',
        args: {
          type: 'object',
          properties: {
            actions: { type: 'boolean', description: '是否真的执行动作（默认 false，只领任务和奖励）' },
            account: { type: 'string', description: '可选：指定账号（mobook 或 mobook#…）；默认主账号' },
          },
          required: [],
        },
        async execute({ actions = false, account } = {}) {
          try {
            const { cred, source, accountKey } = await toolCred(directory, account)
            const paths = taskPaths(cred.uid)
            if (actions === true) {
              // 上一次运行的日志留在 previous.jsonl 里，供 agent 读取。
              if (taskRunAlive(cred.uid)) return { ok: true, started: false, running: true, logPath: paths.log, log: readTaskLog(cred.uid) }
              const started = await startTaskRun(cred)
              if (!started) return { ok: true, started: false, running: true, logPath: paths.log, log: readTaskLog(cred.uid) }
              await new Promise((r) => setTimeout(r, 600))
              return { ok: true, started: true, running: true, account: { uid: String(cred.uid ?? ''), source, key: accountKey }, logPath: paths.log, log: readTaskLog(cred.uid) }
            }
            const out = await runTasks(cred)
            return {
              ok: true,
              account: { uid: String(cred.uid ?? ''), source, key: accountKey },
              joined: out.joined,
              actions: out.actions,
              claimed: out.claimed,
              credit: out.credit,
              cleanup: out.cleanup,
              logPath: paths.log,
              log: readTaskLog(cred.uid),
              remaining: out.tasks.filter((task) => task.status !== 'claimed').map((task) => ({ id: task.activityId, title: task.title, status: task.status })),
            }
          } catch (error) {
            return { ok: false, error: String(error?.message ?? error) }
          }
        },
      },
    },
  }
}

