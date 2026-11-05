// 上游的本地 fake：一个 Bun.serve 站着 ai.yun.139.com（openclaw）、
// ypqy.mcloud.139.com（benefit）和 vip.yun.139.com（vip）——fakeUpstream()
// 把 _internal.HOSTS 三个 origin 都指到本地，按路径路由（三台上游的路径
// 互不重叠）。route("POST /api/llm/apikey/get", handler) 追加/覆盖处理器；
// seen 记录每个请求（方法、路径、头、body），供断言。close() 还原 HOSTS。
import { _internal } from './index.mjs'

export function fakeUpstream() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = { method: req.method, path: url.pathname, headers: req.headers, text }
      if (text) try { r.json = JSON.parse(text) } catch {}
      seen.push(r)
      const handler = routes.get(`${req.method} ${url.pathname}`)
      if (!handler) return new Response('no route ' + req.method + ' ' + url.pathname, { status: 404 })
      return handler(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const was = { ..._internal.HOSTS }
  _internal.HOSTS.openclaw = origin
  _internal.HOSTS.benefit = origin
  _internal.HOSTS.vip = origin
  _internal.HOSTS.userNjs = origin
  const f = {
    origin,
    seen,
    route: (key, handler) => routes.set(key, handler),
    close() {
      server.stop(true)
      Object.assign(_internal.HOSTS, was)
    },
  }
  // 上游三条数据面的默认应答：agent/list（实例 + 可用模型）、apikey/get v1
  // （key + 倍率）、aitokens 权益池。用例里 route() 同名覆盖。
  f.route('POST /api/adapter/assistant/agent/list', () => json({
    success: true,
    data: { agentList: [{ agentType: 'mclaw', agentId: 'oclaw-1', modelList: ['blian_qwen38_flash', 'huoshan_glm_5_3'].map((code) => ({ modelCode: code, description: code })) }] },
  }))
  f.route('POST /api/llm/apikey/get', () => json({
    success: true,
    data: { apikey: 'na-test-key', modelUrl: 'x', modelList: [
      { modelCode: 'blian_qwen38_flash', modelName: 'Qwen3.8-Flash', tokenRatio: 0.18 },
      { modelCode: 'huoshan_glm_5_3', modelName: 'GLM-5.3', tokenRatio: 3.5 },
    ] },
  }))
  f.route('POST /isbo2/openApi/queryAvailableBenefitV2', () => json({
    result: { resultCode: '0', resultDesc: 'SUCCESS' },
    userAvailableBenefitList: [{ benefitNo: 'RHR135', benefitName: 'aitokens', benefitValue: '30500000', benefitUsed: '11375000' }],
  }))
  // SSO 换票链默认应答：出票 + ssoLogin 下发 6 个 mc_* cookie（.139.com，24h，
  // mc_at/mc_pat 是 httpOnly——和真实抓包一致；插件从 getSetCookie() 整段收）。
  f.route('POST /user/querySpecTokenV2', () => json({
    success: true, code: '0000', message: '请求成功', data: { token: 'YZsid-fake-ticket', resultCode: '104000' },
  }))
  f.route('POST /m4c/login/ssoLogin', () => new Response(JSON.stringify({ resultCode: '0', resultDesc: 'SUCCESS' }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': [
        'mc_at=fake-at; Domain=.139.com; Path=/; HttpOnly; Expires=Wed, 06 Nov 2026 00:00:00 GMT',
        'mc_bt=fake-bt; Domain=.139.com; Path=/; Expires=Wed, 06 Nov 2026 00:00:00 GMT',
        'mc_pat=fake-pat; Domain=.139.com; Path=/; HttpOnly; Expires=Wed, 06 Nov 2026 00:00:00 GMT',
        'mc_pbt=fake-pbt; Domain=.139.com; Path=/; Expires=Wed, 06 Nov 2026 00:00:00 GMT',
        'mc_ac=fake-ac; Domain=.139.com; Path=/; Expires=Wed, 06 Nov 2026 00:00:00 GMT',
        'mc_pac=fake-pac; Domain=.139.com; Path=/; Expires=Wed, 06 Nov 2026 00:00:00 GMT',
      ],
    },
  }))
  return f
}

export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

// 两张 pc: Basic 票（浏览器登录收割的形态）：掩码手机号不同，票文本内嵌
// 13 位到期 ms（basicExpiryMs 读的就是它）。值即 authorization Cookie/头。
export const TICKET_A = 'Basic ' + Buffer.from(`pc:13112349239:x|1|RCS|${Date.now() + 30 * 86400e3}|sig`, 'utf8').toString('base64')
export const TICKET_B = 'Basic ' + Buffer.from(`pc:18687654321:y|1|RCS|${Date.now() + 30 * 86400e3}|sig`, 'utf8').toString('base64')
export const PHONE_A = '131****9239'
export const PHONE_B = '186****4321'
