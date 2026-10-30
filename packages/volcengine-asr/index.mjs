// Volcengine Doubao ASR (豆包语音识别) on magpie's /v1/audio/transcriptions.
//
// magpie hands this plugin's fetch the multipart form a client sent to
// POST /v1/audio/transcriptions, with the model as this plugin names it, and
// gives the call at most three minutes. Two ways in:
//
//   bigasr-flash   (volc.bigasr.auc_turbo) a standard OpenAI request: `file`
//                  (or `audio_url`), `language`, `response_format` json | text
//                  | verbose_json. One call, up to 2 h / 100 MB of audio.
//   seed-asr-2.0   (volc.seedasr.auc) and bigasr-1.0 (volc.bigasr.auc): long
//                  audio by URL, up to 5 h, as a job whose steps are separate
//                  calls named by `volc_operation`: submit, query, readiness.
//
// The Speech API key is the signed-in account's (Volcengine console > API Key).
const PROVIDER = "volcengine-asr"
const NAME = "Volcengine ASR"
const SDK = "@ai-sdk/openai-compatible"
const VOLCENGINE = "https://openspeech.bytedance.com"
// where magpie sends this provider's requests; fetch below answers them and
// never forwards to this address
const BASE = VOLCENGINE + "/magpie"
const ROUTE = BASE + "/audio/transcriptions"
const FLASH = VOLCENGINE + "/api/v3/auc/bigmodel/recognize/flash"
const SUBMIT = VOLCENGINE + "/api/v3/auc/bigmodel/submit"
const QUERY = VOLCENGINE + "/api/v3/auc/bigmodel/query"
const UPSTREAM_TIMEOUT_MS = 30_000
const FLASH_TIMEOUT_MS = 170_000

const MODELS = {
  "seed-asr-2.0": { name: "Doubao Seed ASR 2.0 (long audio, URL job)", resource: "volc.seedasr.auc", job: true },
  "bigasr-1.0": { name: "Doubao BigASR 1.0 (long audio, URL job)", resource: "volc.bigasr.auc", job: true },
  "bigasr-flash": { name: "Doubao BigASR flash (upload, one call)", resource: "volc.bigasr.auc_turbo", job: false },
}

const SUCCESS = "20000000"
const SILENT = "20000003"
const POLLING = { "20000001": "processing", "20000002": "queued" }
// an unknown task under a key Volcengine accepted: 45000000 before, now
// 45000092 ("The task was not found for this application")
const AUTHENTICATED_UNKNOWN = new Set(["45000000", "45000092"])
const REJECTED = new Set(["45000010", "45000030"])

// the standard edition's full job: speaker, language, emotion and gender
// detection, punctuation, inverse text normalisation, disfluency removal
const JOB_REQUEST = Object.freeze({
  model_name: "bigmodel",
  enable_itn: true,
  enable_punc: true,
  enable_ddc: true,
  enable_speaker_info: true,
  show_utterances: true,
  enable_lid: true,
  enable_emotion_detection: true,
  enable_gender_detection: true,
  show_speech_rate: true,
  show_volume: true,
})
// what the flash edition takes of it
const FLASH_REQUEST = Object.freeze({
  model_name: "bigmodel",
  enable_itn: true,
  enable_punc: true,
  enable_ddc: true,
  enable_speaker_info: true,
  show_utterances: true,
})

// OpenAI clients send ISO 639-1; Volcengine wants its locale
const LOCALES = {
  zh: "zh-CN", en: "en-US", ja: "ja-JP", ko: "ko-KR", id: "id-ID", es: "es-MX", pt: "pt-BR", de: "de-DE",
  fr: "fr-FR", ms: "ms-MY", th: "th-TH", ar: "ar-SA", it: "it-IT", bn: "bn-BD", el: "el-GR", nl: "nl-NL",
  ru: "ru-RU", tr: "tr-TR", vi: "vi-VN", pl: "pl-PL", ro: "ro-RO", ne: "ne-NP", uk: "uk-UA",
}
const LOCALE = /^[a-z]{2,3}-[A-Za-z]{2,4}$/
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FORMATS = new Set(["raw", "wav", "mp3", "ogg"])
const RESPONSE_FORMATS = new Set(["json", "text", "verbose_json"])

const configModel = (id) => ({
  name: MODELS[id].name,
  limit: { context: 0, output: 0 },
  tool_call: false,
  modalities: { input: ["audio"], output: ["text"] },
})

const runtimeModel = (id) => ({
  id,
  providerID: PROVIDER,
  name: MODELS[id].name,
  api: { id, url: BASE, npm: SDK },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, output: 0 },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: false,
    input: { text: false, image: false, audio: true, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  release_date: "",
  variants: {},
})

const answer = (body, status = 200) => Response.json(body, { status })
const refuse = (status, type, message, code) => answer({ error: { message, type, ...(code ? { code } : {}) } }, status)
const bad = (message) => refuse(400, "invalid_request_error", message)

// a language as Volcengine takes it, null for none, false when it isn't one
function locale(value) {
  if (value == null || value === "") return null
  if (typeof value !== "string") return false
  if (LOCALES[value]) return LOCALES[value]
  return LOCALE.test(value) ? value : false
}

function httpsURL(value) {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:"
}

// Volcengine's finished payload as OpenAI's json, text or verbose_json
function transcript(payload, format, language) {
  const result = payload?.result ?? {}
  const text = result.text ?? ""
  if (format === "text") return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } })
  if (format !== "verbose_json") return answer({ text })
  const segments = (result.utterances ?? []).map((u, id) => ({
    id,
    start: (u.start_time ?? 0) / 1000,
    end: (u.end_time ?? 0) / 1000,
    text: u.text ?? "",
    ...(u.additions?.speaker != null ? { speaker: String(u.additions.speaker) } : {}),
  }))
  const duration = (payload?.audio_info?.duration ?? 0) / 1000
  return answer({ task: "transcribe", language: language || "unknown", duration, text, segments })
}

export async function VolcengineASRPlugin(_input, options = {}) {
  const upstream = options.fetch ?? fetch

  // a provider's text never carries the key, whatever it says
  const scrub = (text, key) => (key ? String(text).split(key).join("<redacted>") : String(text))

  async function volcengine(url, headers, body, timeout = UPSTREAM_TIMEOUT_MS) {
    const res = await upstream(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    })
    return { http: res.status, code: res.headers.get("X-Api-Status-Code") ?? "", message: res.headers.get("X-Api-Message") ?? "", res }
  }

  async function flash(fields, key) {
    const format = fields.get("response_format") || "json"
    if (!RESPONSE_FORMATS.has(format)) return bad("response_format must be json, text or verbose_json")
    const language = locale(fields.get("language"))
    if (language === false) return bad("language must be an ISO 639-1 code Volcengine supports or a locale such as zh-CN")
    const file = fields.get("file")
    const url = fields.get("audio_url")
    let audio
    if (file && typeof file === "object" && typeof file.arrayBuffer === "function") {
      audio = { data: Buffer.from(await file.arrayBuffer()).toString("base64") }
    } else if (url) {
      if (!httpsURL(url)) return bad("audio_url must be an https URL")
      audio = { url }
    } else {
      return bad("send the audio as `file`, or its https address as `audio_url`")
    }
    if (language) audio.language = language
    const out = await volcengine(
      FLASH,
      { "X-Api-Key": key, "X-Api-Resource-Id": MODELS["bigasr-flash"].resource, "X-Api-Request-Id": crypto.randomUUID(), "X-Api-Sequence": "-1" },
      { user: { uid: "magpie" }, audio, request: { ...FLASH_REQUEST } },
      FLASH_TIMEOUT_MS,
    )
    if (out.code === SILENT) return transcript({ audio_info: { duration: 0 }, result: { text: "", utterances: [] } }, format, fields.get("language"))
    if (out.code !== SUCCESS) {
      return refuse(502, "volcengine_asr_error", scrub(`Volcengine ASR flash failed: status=${out.code}, message=${out.message}`, key), out.code)
    }
    return transcript(await out.res.json(), format, fields.get("language"))
  }

  async function job(model, fields, key) {
    const operation = fields.get("volc_operation")
    const resource = MODELS[model].resource
    if (operation === "readiness") return readiness(resource, key)
    const task = fields.get("volc_task_id")
    if (operation !== "submit" && operation !== "query") {
      if (fields.get("file")) {
        return bad(
          `${model} transcribes audio by URL as a job: send volc_operation=submit with volc_task_id (a lowercase UUID), ` +
            "audio_url and audio_format, then volc_operation=query until it is completed. For an upload in one call, use bigasr-flash.",
        )
      }
      return bad("volc_operation must be submit, query or readiness")
    }
    if (!TASK_ID.test(task ?? "")) return bad("volc_task_id must be a lowercase UUID")
    const headers = { "X-Api-Key": key, "X-Api-Resource-Id": resource, "X-Api-Request-Id": task }
    if (operation === "submit") {
      const url = fields.get("audio_url")
      const format = fields.get("audio_format")
      const language = locale(fields.get("language"))
      if (!httpsURL(url)) return bad("audio_url must be an https URL")
      if (!FORMATS.has(format)) return bad("audio_format must be raw, wav, mp3 or ogg")
      if (language === false) return bad("language must be an ISO 639-1 code Volcengine supports or a locale such as zh-CN")
      const audio = { url, format }
      if (language) audio.language = language
      const out = await volcengine(SUBMIT, { ...headers, "X-Api-Sequence": "-1" }, { user: { uid: task }, audio, request: { ...JOB_REQUEST } })
      if (out.code !== SUCCESS) {
        return refuse(502, "volcengine_asr_error", scrub(`Volcengine ASR submit failed: status=${out.code}, message=${out.message}, request_id=${task}`, key), out.code)
      }
      return answer({ object: "volcengine.asr.task", task_id: task, status: "submitted" })
    }
    const out = await volcengine(QUERY, headers, {})
    const status = (s) => ({ object: "volcengine.asr.task", task_id: task, status: s, provider_status: out.code })
    if (out.code === SUCCESS) return answer({ ...status("completed"), payload: await out.res.json() })
    if (out.code === SILENT) return answer(status("silent"))
    if (POLLING[out.code]) return answer(status(POLLING[out.code]))
    return refuse(502, "volcengine_asr_error", scrub(`Volcengine ASR query failed: status=${out.code}, message=${out.message}, request_id=${task}`, key), out.code)
  }

  async function readiness(resource, key) {
    const ready = (ok, provider_status, reason) => answer({ object: "volcengine.asr.readiness", ready: ok, provider_status, reason })
    let out
    try {
      out = await volcengine(QUERY, { "X-Api-Key": key, "X-Api-Resource-Id": resource, "X-Api-Request-Id": crypto.randomUUID() }, {})
    } catch {
      return ready(false, "", "transport_error")
    }
    if (out.http === 200 && AUTHENTICATED_UNKNOWN.has(out.code)) return ready(true, out.code, "authenticated_unknown_request")
    if (REJECTED.has(out.code)) return ready(false, out.code, "provider_rejected")
    return ready(false, out.code, "unexpected_response")
  }

  async function serve(input, init, key) {
    const req = new Request(input, init)
    if (req.method !== "POST" || req.url !== ROUTE) return refuse(404, "invalid_request_error", `${NAME} serves POST /v1/audio/transcriptions only`)
    let fields
    try {
      fields = await req.formData()
    } catch {
      return bad("send a multipart form, as OpenAI's /v1/audio/transcriptions takes it")
    }
    const model = fields.get("model")
    if (!MODELS[model]) return refuse(404, "invalid_request_error", `${NAME} has no model ${model}; it has ${Object.keys(MODELS).join(", ")}`)
    try {
      return MODELS[model].job ? await job(model, fields, key) : await flash(fields, key)
    } catch (e) {
      return refuse(502, "transport_error", scrub(`Volcengine ASR did not answer: ${e?.message ?? e}`, key))
    }
  }

  const keyOf = (auth) => (auth?.type === "api" && typeof auth.key === "string" && auth.key.trim() ? auth.key.trim() : "")

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: NAME,
        npm: SDK,
        api: BASE,
        models: Object.fromEntries(Object.keys(MODELS).map((id) => [id, configModel(id)])),
      }
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "Volcengine Speech API key (console › 豆包语音 › API Key)" }],
      async loader(getAuth) {
        if (!keyOf(await getAuth())) return {}
        return {
          baseURL: BASE,
          apiKey: "volcengine-asr",
          fetch: async (input, init) => {
            const key = keyOf(await getAuth())
            if (!key) throw new Error(`${NAME} is signed out`)
            return serve(input, init, key)
          },
        }
      },
    },
    provider: {
      id: PROVIDER,
      models: async () => Object.fromEntries(Object.keys(MODELS).map((id) => [id, runtimeModel(id)])),
    },
  }
}
