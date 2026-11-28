// Magpie-native image, video, and audio (TTS/ASR) for MiniMax Design (China & Global).
//
// MiniMax Design exposes its live image/video/audio model catalog at
//   GET <cloud>/api/v1/models/config
// and executes generation through Cloud Gateway endpoints:
//   - Images:
//       minimax_image: POST /api/v2/image/minimax/generate      -> GET /api/v2/image/minimax/tasks/:id
//       openai:        POST /api/v2/image/openai/generate       -> GET /api/v2/image/openai/tasks/:id
//       nano_banana:   POST /api/v2/image/nano_banana/generate  -> GET /api/v2/image/nano_banana/tasks/:id
//       seedream:      POST /api/v2/image/seedream/generate     -> GET /api/v2/image/seedream/tasks/:id
//       midjourney:    POST /api/v1/image/midjourney/generate   -> GET /api/v1/image/midjourney/tasks/:id
//   - Videos:
//       minimax_v3:    POST /api/v1/video/minimax-v3/generate   -> GET /api/v1/video/minimax-v3/tasks/:id -> GET /api/v1/video/minimax/files/:file_id
//       seedance:      POST /api/v1/video/seedance/generate     -> GET /api/v1/video/seedance/tasks/:id
//       wan_i2v:       POST /api/v1/video/wan3/generate         -> GET /api/v1/video/wan3/tasks/:id
//       kling (omni):  POST /api/v1/video/kling-omni/generate   -> GET /api/v1/video/kling-omni/tasks/:id
//       kling:         POST /api/v1/video/kling/generate        -> GET /api/v1/video/kling/tasks/:id
//       kling_avatar:  POST /api/v1/video/kling/avatar          -> GET /api/v1/video/kling/avatar/:id
//       veo3:          POST /api/v1/video/veo3/generate         -> GET /api/v1/video/veo3/tasks/:id
//   - Audio (TTS & ASR):
//       minimax_tts:   POST /api/v2/audio/tts                   -> GET /api/v2/audio/tts/tasks/:id
//       seedaudio:     POST /api/v2/audio/seedaudio/tts         -> GET /api/v2/audio/seedaudio/tts/tasks/:id
//       minimax_asr:   POST /api/v1/audio/asr
//   - Reference uploads:
//       POST /api/v1/files/upload  { file_data: "data:<mime>;base64,...", file_prefix: "image"|"video"|"audio" }
//
// Domestic compliance aliases (e.g. `g-image-2.6-sunburst` / `Design Image 2.6 Pro`,
// `banana-2` / `General Image 2`, `悠船 8.2`, `SD 2.5`) are normalized to their
// canonical model IDs and names while preserving the exact cloud backend model_name.

const MEDIA_NPM = "@ai-sdk/openai-compatible"
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const IMAGE_POLL_INTERVAL_MS = 2000
const IMAGE_POLL_MAX_WAIT_MS = 5 * 60 * 1000
const AUDIO_POLL_INTERVAL_MS = 1500
const AUDIO_POLL_MAX_WAIT_MS = 165_000
const ASR_TIMEOUT_MS = 165_000
const UPLOAD_TIMEOUT_MS = 120_000
const SUBMIT_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 120_000

const SUPPORTED_IMAGE_BACKENDS = new Set(["minimax_image", "openai", "nano_banana", "seedream", "midjourney"])
const SUPPORTED_VIDEO_BACKENDS = new Set(["minimax_v3", "seedance", "wan_i2v", "kling", "kling_avatar", "veo3"])
const SUPPORTED_AUDIO_BACKENDS = new Set(["minimax_tts", "seedaudio"])
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"])
const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/ogg",
  "audio/flac",
  "audio/opus",
  "audio/webm",
])
const ASR_RESPONSE_FORMATS = new Set(["json", "text", "verbose_json", "srt", "vtt"])
const SEEDAUDIO_FORMATS = {
  mp3: { format: "mp3", contentType: "audio/mpeg" },
  wav: { format: "wav", contentType: "audio/wav" },
  pcm: { format: "pcm", contentType: "audio/pcm" },
  opus: { format: "ogg_opus", contentType: "audio/ogg" },
  ogg_opus: { format: "ogg_opus", contentType: "audio/ogg" },
}
const DEFAULT_TTS_VOICE = "Friendly_Person"

const GPT_IMAGE_2_SIZE_MAP = {
  "1k": {
    "1:1": "1024x1024",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "3:4": "864x1152",
    "4:3": "1152x864",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "5:4": "1120x896",
    "4:5": "896x1120",
    "21:9": "1344x576",
    "2:1": "1440x720",
    "1:2": "720x1440",
    "3:1": "1728x576",
    "1:3": "576x1728",
  },
  "2k": {
    "1:1": "2048x2048",
    "16:9": "2560x1440",
    "9:16": "1440x2560",
    "3:4": "1728x2304",
    "4:3": "2304x1728",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "5:4": "2240x1792",
    "4:5": "1792x2240",
    "21:9": "3024x1296",
    "2:1": "2880x1440",
    "1:2": "1440x2880",
    "3:1": "3552x1184",
    "1:3": "1184x3552",
  },
  "4k": {
    "1:1": "2880x2880",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "3:4": "2448x3264",
    "4:3": "3264x2448",
    "3:2": "3504x2336",
    "2:3": "2336x3504",
    "5:4": "3200x2560",
    "4:5": "2560x3200",
    "21:9": "3696x1584",
    "2:1": "3840x1920",
    "1:2": "1920x3840",
    "3:1": "3840x1280",
    "1:3": "1280x3840",
  },
}

const IMAGE_MODEL_ALIASES = {
  "MiniMax-H3-Image": { id: "MiniMax-H3-Image", name: "MiniMax H3 Image", modelName: "MiniMax-H3-Image" },
  "MiniMax-H3-Image-Highspeed": { id: "MiniMax-H3-Image-Highspeed", name: "MiniMax H3 Image Highspeed", modelName: "MiniMax-H3-Image-Highspeed" },
  "g-image-2.6-sunburst": { id: "gpt-image-2.6-sunburst", name: "GPT Image 2.6 Sunburst", modelName: "gpt-image-2.6-sunburst" },
  "gpt-image-2.6-sunburst": { id: "gpt-image-2.6-sunburst", name: "GPT Image 2.6 Sunburst", modelName: "gpt-image-2.6-sunburst" },
  "g-image-2.6-flare": { id: "gpt-image-2.6-flare", name: "GPT Image 2.6 Flare", modelName: "gpt-image-2.6-flare" },
  "gpt-image-2.6-flare": { id: "gpt-image-2.6-flare", name: "GPT Image 2.6 Flare", modelName: "gpt-image-2.6-flare" },
  "g-image-2.5-sunburst": { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", modelName: "gpt-image-2.5-sunburst" },
  "gpt-image-2.5-sunburst": { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", modelName: "gpt-image-2.5-sunburst" },
  "g-image-2.5-flare": { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", modelName: "gpt-image-2.5-flare" },
  "gpt-image-2.5-flare": { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", modelName: "gpt-image-2.5-flare" },
  "g-image-2": { id: "gpt-image-2", name: "GPT Image 2", modelName: "gpt-image-2" },
  "gpt-image-2": { id: "gpt-image-2", name: "GPT Image 2", modelName: "gpt-image-2" },
  "banana-2": { id: "nano-banana-2", name: "Nano Banana 2", modelName: "nano_banana_2_flash" },
  "nano_banana_2_flash": { id: "nano-banana-2", name: "Nano Banana 2", modelName: "nano_banana_2_flash" },
  "banana-pro": { id: "nano-banana-pro", name: "Nano Banana Pro", modelName: "nano_banana_2" },
  "nano_banana_2": { id: "nano-banana-pro", name: "Nano Banana Pro", modelName: "nano_banana_2" },
  "doubao-seedream-5-0-pro-260628": { id: "doubao-seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", modelName: "doubao-seedream-5-0-pro-260628" },
  "doubao-seedream-4-5-251128": { id: "doubao-seedream-4-5-251128", name: "Seedream 4.5", modelName: "doubao-seedream-4-5-251128" },
  "midjourney-8.2": { id: "midjourney-8.2", name: "Midjourney 8.2", modelName: "midjourney-8.2" },
  "midjourney-8.1": { id: "midjourney-8.1", name: "Midjourney 8.1", modelName: "midjourney-8.1" },
  "midjourney-7": { id: "midjourney-7", name: "Midjourney 7", modelName: "midjourney-7" },
  "midjourney-niji7": { id: "midjourney-niji7", name: "Midjourney Niji 7", modelName: "midjourney-niji7" },
}

const VIDEO_MODEL_ALIASES = {
  "MiniMax-H3": { id: "MiniMax-H3", name: "MiniMax H3", modelName: "MiniMax-H3" },
  "MiniMax-H3-Max": { id: "MiniMax-H3-Max", name: "MiniMax H3 Max", modelName: "MiniMax-H3-Max" },
  "seedance2.5": { id: "seedance-2.5", name: "Seedance 2.5", modelName: "seedance2.5" },
  "seedance2.5-draft": { id: "seedance-2.5-draft", name: "Seedance 2.5 Draft", modelName: "seedance2.5-draft" },
  "seedance2.0": { id: "seedance-2.0", name: "Seedance 2.0", modelName: "seedance2.0" },
  "wan3.0-video": { id: "wan-3.0-video", name: "Wan 3.0", modelName: "wan3.0-video" },
  "wan3.0-video-prime": { id: "wan-3.0-video-prime", name: "Wan 3.0 Prime", modelName: "wan3.0-video-prime" },
  "kling-v3-omni-video": { id: "kling-v3-omni-video", name: "Kling 3.0 Omni", modelName: "kling-v3-omni" },
  "kling-avatar": { id: "kling-avatar", name: "Kling Avatar", modelName: "kling-avatar" },
  "veo-3.1-generate-001": { id: "veo-3.1", name: "Veo 3.1", modelName: "veo-3.1-generate-001" },
  "beta_pro": { id: "veo-3.1", name: "Veo 3.1", modelName: "veo-3.1-generate-001" },
  "veo-3.1-fast-generate-001": { id: "veo-3.1-fast", name: "Veo 3.1 Fast", modelName: "veo-3.1-fast-generate-001" },
  "beta_fast": { id: "veo-3.1-fast", name: "Veo 3.1 Fast", modelName: "veo-3.1-fast-generate-001" },
}

const AUDIO_MODEL_ALIASES = {
  "speech-2.8-hd": { id: "speech-2.8-hd", name: "MiniMax Speech 2.8 HD", modelName: "speech-2.8-hd" },
  "seed-audio-1.0": { id: "seed-audio-1.0", name: "Seed Audio 1.0", modelName: "seed-audio-1.0" },
}

// Verified snapshots from GET /api/v1/models/config on both sites.
// Used before sign-in or when /api/v1/models/config is temporarily unreachable;
// live /api/v1/models/config replaces these in provider.models().
const BOOTSTRAP_MEDIA = [
  // Images (common to CN & Global)
  { id: "MiniMax-H3-Image", upstreamId: "MiniMax-H3-Image", modelName: "MiniMax-H3-Image", name: "MiniMax H3 Image", kind: "image", backend: "minimax_image", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "3:1", "1:3"], resolutions: ["1K", "2K", "4K"], defaultResolution: "2K" },
  { id: "MiniMax-H3-Image-Highspeed", upstreamId: "MiniMax-H3-Image-Highspeed", modelName: "MiniMax-H3-Image-Highspeed", name: "MiniMax H3 Image Highspeed", kind: "image", backend: "minimax_image", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "3:1", "1:3"], resolutions: ["1K", "2K", "4K"], defaultResolution: "2K" },
  { id: "gpt-image-2.6-sunburst", upstreamId: "g-image-2.6-sunburst", modelName: "gpt-image-2.6-sunburst", name: "GPT Image 2.6 Sunburst", kind: "image", backend: "openai", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "3:1", "1:3"], resolutions: ["1k", "2k", "4k"], defaultResolution: "1k", defaultQuality: "high" },
  { id: "gpt-image-2.6-flare", upstreamId: "g-image-2.6-flare", modelName: "gpt-image-2.6-flare", name: "GPT Image 2.6 Flare", kind: "image", backend: "openai", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "3:1", "1:3"], resolutions: ["1k", "2k", "4k"], defaultResolution: "1k", defaultQuality: "high" },
  { id: "gpt-image-2.5-sunburst", upstreamId: "g-image-2.5-sunburst", modelName: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", kind: "image", backend: "openai", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "3:1", "1:3"], resolutions: ["1k", "2k", "4k"], defaultResolution: "1k", defaultQuality: "high" },
  { id: "gpt-image-2.5-flare", upstreamId: "g-image-2.5-flare", modelName: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", kind: "image", backend: "openai", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "3:1", "1:3"], resolutions: ["1k", "2k", "4k"], defaultResolution: "1k", defaultQuality: "high" },
  { id: "gpt-image-2", upstreamId: "g-image-2", modelName: "gpt-image-2", name: "GPT Image 2", kind: "image", backend: "openai", regions: ["domestic", "overseas"], aspectRatios: ["1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "3:1", "1:3"], resolutions: ["1k", "2k", "4k"], defaultResolution: "1k", defaultQuality: "medium" },
  { id: "nano-banana-2", upstreamId: "banana-2", modelName: "nano_banana_2_flash", name: "Nano Banana 2", kind: "image", backend: "nano_banana", regions: ["domestic", "overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"], resolutions: ["1K", "2K", "4K"], defaultResolution: "1K" },
  { id: "nano-banana-pro", upstreamId: "banana-pro", modelName: "nano_banana_2", name: "Nano Banana Pro", kind: "image", backend: "nano_banana", regions: ["domestic", "overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"], resolutions: ["1K", "2K", "4K"], defaultResolution: "1K" },
  { id: "doubao-seedream-5-0-pro-260628", upstreamId: "doubao-seedream-5-0-pro-260628", modelName: "doubao-seedream-5-0-pro-260628", name: "Seedream 5.0 Pro", kind: "image", backend: "seedream", regions: ["domestic", "overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "21:9"], resolutions: ["1K", "2K"], defaultResolution: "2K" },
  { id: "doubao-seedream-4-5-251128", upstreamId: "doubao-seedream-4-5-251128", modelName: "doubao-seedream-4-5-251128", name: "Seedream 4.5", kind: "image", backend: "seedream", regions: ["domestic", "overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "21:9"], resolutions: ["2K", "4K"], defaultResolution: "2K" },
  { id: "midjourney-8.2", upstreamId: "midjourney-8.2", modelName: "midjourney-8.2", name: "Midjourney 8.2", kind: "image", backend: "midjourney", regions: ["domestic", "overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"] },
  { id: "midjourney-8.1", upstreamId: "midjourney-8.1", modelName: "midjourney-8.1", name: "Midjourney 8.1", kind: "image", backend: "midjourney", regions: ["overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"] },
  { id: "midjourney-7", upstreamId: "midjourney-7", modelName: "midjourney-7", name: "Midjourney 7", kind: "image", backend: "midjourney", regions: ["overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"] },
  { id: "midjourney-niji7", upstreamId: "midjourney-niji7", modelName: "midjourney-niji7", name: "Midjourney Niji 7", kind: "image", backend: "midjourney", regions: ["overseas"], aspectRatios: ["auto", "1:1", "16:9", "9:16", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"] },
  // Videos
  { id: "MiniMax-H3", upstreamId: "MiniMax-H3", modelName: "MiniMax-H3", name: "MiniMax H3", kind: "video", backend: "minimax_v3", regions: ["domestic", "overseas"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], resolutions: ["768P", "2K"], defaultResolution: "768P" },
  { id: "MiniMax-H3-Max", upstreamId: "MiniMax-H3-Max", modelName: "MiniMax-H3-Max", name: "MiniMax H3 Max", kind: "video", backend: "minimax_v3", regions: ["domestic", "overseas"], durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], resolutions: ["480P", "768P"], defaultResolution: "480P" },
  { id: "seedance-2.5", upstreamId: "seedance2.5", modelName: "seedance2.5", name: "Seedance 2.5", kind: "video", backend: "seedance", regions: ["domestic"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p" },
  { id: "seedance-2.5-draft", upstreamId: "seedance2.5-draft", modelName: "seedance2.5-draft", name: "Seedance 2.5 Draft", kind: "video", backend: "seedance", regions: ["domestic"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], resolutions: ["480p"], defaultResolution: "480p" },
  { id: "seedance-2.0", upstreamId: "seedance2.0", modelName: "seedance2.0", name: "Seedance 2.0", kind: "video", backend: "seedance", regions: ["domestic"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], resolutions: ["480p", "720p", "1080p", "4k"], defaultResolution: "720p" },
  { id: "wan-3.0-video", upstreamId: "wan3.0-video", modelName: "wan3.0-video", name: "Wan 3.0", kind: "video", backend: "wan_i2v", regions: ["domestic", "overseas"], durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"], resolutions: ["480P", "720P", "1080P"], defaultResolution: "1080P" },
  { id: "wan-3.0-video-prime", upstreamId: "wan3.0-video-prime", modelName: "wan3.0-video-prime", name: "Wan 3.0 Prime", kind: "video", backend: "wan_i2v", regions: ["domestic", "overseas"], durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"], resolutions: ["480P", "720P", "1080P"], defaultResolution: "1080P" },
  { id: "kling-v3-omni-video", upstreamId: "kling-v3-omni-video", modelName: "kling-v3-omni", name: "Kling 3.0 Omni", kind: "video", backend: "kling", regions: ["domestic", "overseas"], durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], defaultDuration: 5, aspectRatios: ["16:9", "9:16", "1:1"], defaultMode: "pro" },
  { id: "kling-avatar", upstreamId: "kling-avatar", modelName: "kling-avatar", name: "Kling Avatar", kind: "video", backend: "kling_avatar", regions: ["domestic", "overseas"], defaultMode: "std" },
  { id: "veo-3.1", upstreamId: "veo-3.1-generate-001", modelName: "veo-3.1-generate-001", name: "Veo 3.1", kind: "video", backend: "veo3", regions: ["overseas"], durations: [8], defaultDuration: 8, aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultResolution: "720p" },
  { id: "veo-3.1-fast", upstreamId: "veo-3.1-fast-generate-001", modelName: "veo-3.1-fast-generate-001", name: "Veo 3.1 Fast", kind: "video", backend: "veo3", regions: ["overseas"], durations: [8], defaultDuration: 8, aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultResolution: "720p" },
  // Audio (TTS & ASR)
  { id: "speech-2.8-hd", upstreamId: "speech-2.8-hd", modelName: "speech-2.8-hd", name: "MiniMax Speech 2.8 HD", kind: "audio", backend: "minimax_tts", regions: ["domestic", "overseas"] },
  { id: "seed-audio-1.0", upstreamId: "seed-audio-1.0", modelName: "seed-audio-1.0", name: "Seed Audio 1.0", kind: "audio", backend: "seedaudio", regions: ["domestic", "overseas"] },
  { id: "minimax-asr", upstreamId: "minimax-asr", modelName: "minimax-asr", name: "MiniMax Design ASR", kind: "transcription", backend: "minimax_asr", regions: ["domestic", "overseas"] },
]

// ---- small helpers -----------------------------------------------------------

const isRecord = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v))
const trimStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })

function gcd(a, b) {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function ratioFromSize(size) {
  const s = trimStr(size)
  if (!s) return undefined
  if (/^\d+:\d+$/.test(s) || s === "auto" || s === "adaptive") return s
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s)
  if (!m) return undefined
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return undefined
  const g = gcd(w, h)
  return `${w / g}:${h / g}`
}

function parseRatioNum(r) {
  const m = /^(\d+):(\d+)$/.exec(trimStr(r))
  if (!m || !Number(m[2])) return null
  return Number(m[1]) / Number(m[2])
}

function nearestRatio(options, want) {
  if (!want || !Array.isArray(options) || !options.length) return want
  if (options.includes(want)) return want
  const target = parseRatioNum(want)
  if (target === null) return undefined
  let best = null
  let bestDiff = Infinity
  for (const opt of options) {
    const n = parseRatioNum(opt)
    if (n === null) continue
    const diff = Math.abs(Math.log(n) - Math.log(target))
    if (diff < bestDiff) {
      bestDiff = diff
      best = opt
    }
  }
  return best ?? undefined
}

function tierFromSizeOrQuality(size, quality) {
  const q = trimStr(quality).toLowerCase()
  const s = trimStr(size)
  if (/^(1|2|4)k$/i.test(s)) return s.toUpperCase()
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s)
  if (m) {
    const long = Math.max(Number(m[1]), Number(m[2]))
    if (long > 0) {
      if (long <= 1440) return "1K"
      if (long <= 2560) return "2K"
      return "4K"
    }
  }
  if (q === "low") return "1K"
  if (q === "medium") return "2K"
  if (q === "high" || q === "xhigh" || q === "max") return "4K"
  return undefined
}

function pickOptionCI(options, want, fallback) {
  if (!Array.isArray(options) || !options.length) return want || fallback
  if (want) {
    const exact = options.find((o) => String(o).toLowerCase() === String(want).toLowerCase())
    if (exact !== undefined) return exact
  }
  if (fallback) {
    const fb = options.find((o) => String(o).toLowerCase() === String(fallback).toLowerCase())
    if (fb !== undefined) return fb
  }
  return options[0]
}

function pickVideoResolution(spec, size, explicitRes) {
  const options = spec.resolutions ?? []
  const want = trimStr(explicitRes)
  if (want) return pickOptionCI(options, want, spec.defaultResolution)
  const s = trimStr(size).toUpperCase()
  if (s) {
    if (["480P", "720P", "768P", "1080P", "2K", "4K"].includes(s)) {
      return pickOptionCI(options, s, spec.defaultResolution)
    }
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s)
    if (m) {
      const short = Math.min(Number(m[1]), Number(m[2]))
      const long = Math.max(Number(m[1]), Number(m[2]))
      if (short <= 540) return pickOptionCI(options, "480P", spec.defaultResolution)
      if (short <= 800) {
        if (options.some((o) => o.toUpperCase() === "768P")) return pickOptionCI(options, "768P", spec.defaultResolution)
        return pickOptionCI(options, "720P", spec.defaultResolution)
      }
      if (long <= 2048) {
        if (options.some((o) => o.toUpperCase() === "1080P")) return pickOptionCI(options, "1080P", spec.defaultResolution)
        return pickOptionCI(options, "2K", spec.defaultResolution)
      }
      if (options.some((o) => o.toUpperCase() === "4K")) return pickOptionCI(options, "4K", spec.defaultResolution)
      return pickOptionCI(options, "2K", spec.defaultResolution)
    }
  }
  return spec.defaultResolution || options[0] || ""
}

function pickDuration(spec, rawSeconds) {
  const allowed = Array.isArray(spec.durations) && spec.durations.length ? spec.durations : null
  const fallback = spec.defaultDuration ?? (allowed ? allowed[0] : 5)
  if (rawSeconds === undefined || rawSeconds === null || rawSeconds === "") return fallback
  const n = Number(rawSeconds)
  if (!Number.isFinite(n) || n <= 0) throw fail(400, "seconds must be a positive number")
  const rounded = Math.round(n)
  if (!allowed) return rounded
  let best = allowed[0]
  let bestDiff = Math.abs(best - rounded)
  for (const d of allowed) {
    const diff = Math.abs(d - rounded)
    if (diff < bestDiff) {
      best = d
      bestDiff = diff
    }
  }
  return best
}

// ---- canonical naming & catalog parsing --------------------------------------

function normalizeMediaDisplayName(rawName, backend, fallbackId) {
  const s = trimStr(rawName) || fallbackId
  if (backend === "midjourney") {
    return s.replace(/^悠船(?:\s*)/, "Midjourney ")
  }
  if (backend === "seedance") {
    return s
      .replace(/^SD\s+/i, "Seedance ")
      .replace(/\s*样片$/, " Draft")
      .replace(/\s*满血版$/, "")
      .trim()
  }
  if (backend === "openai") {
    return s.replace(/^Design Image\b/i, "GPT Image").replace(/^G Image\b/i, "GPT Image")
  }
  if (backend === "nano_banana") {
    return s
      .replace(/^General Image\b/i, "Nano Banana")
      .replace(/^NanoBanana\b/i, "Nano Banana")
  }
  if (backend === "veo3") {
    return s
      .replace(/^Beta Pro$/i, "Veo 3.1")
      .replace(/^Beta Fast$/i, "Veo 3.1 Fast")
      .replace(/^Veo3\.1\b/i, "Veo 3.1")
  }
  return s
}

function normalizeMediaEntry(raw, kind) {
  if (!isRecord(raw)) return null
  if (trimStr(raw.visibility).toLowerCase() === "hidden") return null
  const upstreamId = trimStr(raw.id)
  const backend = trimStr(raw.backend)
  if (!upstreamId || !backend) return null
  if (kind === "image" && !SUPPORTED_IMAGE_BACKENDS.has(backend)) return null
  if (kind === "video" && !SUPPORTED_VIDEO_BACKENDS.has(backend)) return null
  if (kind === "audio" && !SUPPORTED_AUDIO_BACKENDS.has(backend)) return null

  const rawModelName = trimStr(raw.model_name) || upstreamId
  const aliases = kind === "image" ? IMAGE_MODEL_ALIASES : kind === "video" ? VIDEO_MODEL_ALIASES : AUDIO_MODEL_ALIASES
  const alias = aliases[upstreamId] ?? aliases[rawModelName]
  let id = alias?.id ?? upstreamId
  if (!alias && backend === "openai" && /^g-image-/i.test(upstreamId) && /^gpt-image-/i.test(rawModelName)) {
    id = rawModelName
  }
  const modelName = alias?.modelName ?? rawModelName
  const name = alias?.name ?? normalizeMediaDisplayName(trimStr(raw.display_name) || trimStr(raw.name) || id, backend, id)

  const params = isRecord(raw.params) ? raw.params : {}
  const optList = (k) => (Array.isArray(params[k]?.options) ? params[k].options.map(String) : undefined)
  const defVal = (k) => trimStr(params[k]?.default)
  const rawDurations = optList("duration")
  const durations = rawDurations
    ? rawDurations.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
    : undefined
  const defaultDuration = durations?.length ? (Number(defVal("duration")) || durations[0]) : undefined
  const resolutions = optList("resolution")
  // Avoid burning 4K credits by default when a caller passes no size/resolution.
  const rawDefaultRes = defVal("resolution")
  const defaultResolution =
    kind === "image" && backend === "minimax_image" && rawDefaultRes.toUpperCase() === "4K"
      ? "2K"
      : rawDefaultRes || resolutions?.[0]

  return {
    id,
    upstreamId,
    modelName,
    name,
    kind,
    backend,
    aspectRatios: optList("aspect_ratio"),
    resolutions,
    defaultResolution,
    durations,
    defaultDuration,
    defaultQuality: defVal("quality") || undefined,
    defaultMode: defVal("mode") || undefined,
    maxRefs: typeof raw.max_refs === "number" && raw.max_refs >= 0 ? raw.max_refs : undefined,
  }
}

export function parseModelsConfig(body) {
  if (!isRecord(body)) return null
  if (!Array.isArray(body.imageModels) && !Array.isArray(body.videoModels) && !Array.isArray(body.audioModels)) return null
  const specs = []
  const seen = new Set()
  for (const [key, kind] of [
    ["imageModels", "image"],
    ["videoModels", "video"],
    ["audioModels", "audio"],
  ]) {
    const list = Array.isArray(body[key]) ? body[key] : []
    for (const raw of list) {
      const spec = normalizeMediaEntry(raw, kind)
      if (!spec || seen.has(spec.id)) continue
      seen.add(spec.id)
      specs.push(spec)
    }
  }
  return specs
}

export function bootstrapMediaSpecs(site) {
  const region = site?.region ?? "domestic"
  return BOOTSTRAP_MEDIA.filter((m) => m.regions.includes(region)).map(({ regions: _r, ...rest }) => rest)
}

export function mediaConfigEntry(site, spec) {
  const isTranscription = spec.kind === "transcription"
  const isAudio = spec.kind === "audio"
  const input = isTranscription
    ? ["audio"]
    : isAudio
      ? spec.backend === "seedaudio"
        ? ["text", "image", "audio"]
        : ["text"]
      : ["text", "image"]
  // Transcription leaves output empty so magpie's pluginTalks does not add it to chat pickers.
  const output = isTranscription ? [] : [spec.kind]
  return {
    id: spec.id,
    name: spec.name,
    provider: { npm: MEDIA_NPM, api: site.defaultLlmBase },
    reasoning: false,
    attachment: isTranscription || !isAudio || spec.backend === "seedaudio",
    tool_call: false,
    temperature: false,
    modalities: { input, output },
    limit: { context: 0, output: 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    variants: {},
  }
}

export function mediaInternalModel(site, providerID, spec) {
  const isImage = spec.kind === "image"
  const isVideo = spec.kind === "video"
  const isAudio = spec.kind === "audio"
  const isTranscription = spec.kind === "transcription"
  const seedAudio = isAudio && spec.backend === "seedaudio"
  return {
    id: spec.id,
    providerID,
    name: spec.name,
    api: { id: spec.id, url: site.defaultLlmBase, npm: MEDIA_NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: isImage || isVideo || isTranscription || seedAudio,
      toolcall: false,
      input: {
        text: !isTranscription,
        image: isImage || isVideo || seedAudio,
        audio: isTranscription || seedAudio,
        video: false,
        pdf: false,
      },
      output: { text: false, image: isImage, audio: isAudio, video: isVideo, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export function mediaBootstrapConfigModels(site) {
  return Object.fromEntries(bootstrapMediaSpecs(site).map((spec) => [spec.id, mediaConfigEntry(site, spec)]))
}

// ---- OpenAI Images / Videos / Audio route detection --------------------------

export function mediaPath(url) {
  let pathname
  try {
    pathname = new URL(url, "http://local").pathname
  } catch {
    return null
  }
  if (/\/images\/generations$/.test(pathname)) return { kind: "image.generations" }
  if (/\/images\/edits$/.test(pathname)) return { kind: "image.edits" }
  if (/\/audio\/speech$/.test(pathname)) return { kind: "audio.speech" }
  if (/\/audio\/transcriptions$/.test(pathname)) return { kind: "audio.transcriptions" }
  if (/\/videos$/.test(pathname)) return { kind: "video.create" }
  const m = /\/videos\/([^/]+)(?:\/(content))?$/.exec(pathname)
  if (!m) return null
  let id
  try {
    id = decodeURIComponent(m[1])
  } catch {
    id = m[1]
  }
  return { kind: m[2] === "content" ? "video.content" : "video.get", id }
}

export function encodeVideoId(modelId, taskId) {
  return `${modelId}::${taskId}`
}

export function decodeVideoId(rawId) {
  const s = String(rawId ?? "")
  const cut = s.indexOf("::")
  if (cut <= 0) throw fail(404, "not a MiniMax Design video id")
  const modelId = s.slice(0, cut)
  const taskId = s.slice(cut + 2)
  if (!taskId || /[\s/?#\\]|\.\./.test(taskId)) throw fail(404, "not a MiniMax Design video id")
  return { modelId, taskId }
}

// ---- request body & multipart parsing ----------------------------------------

function getHeader(headers, name) {
  if (!headers) return ""
  if (typeof headers.get === "function") return headers.get(name) ?? ""
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? (v[0] ?? "") : (v ?? "")
  }
  return ""
}

function normalizeMime(value) {
  const v = String(value ?? "").trim().toLowerCase()
  if (!v || v === "application/octet-stream") return ""
  if (v === "image/jpg") return "image/jpeg"
  return v
}

function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  return "application/octet-stream"
}

async function bytesOf(body) {
  if (body == null || body === "") return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  throw fail(400, "request body must be a JSON object or multipart form data")
}

function jsonBody(body) {
  if (body == null || body === "") return {}
  if (isRecord(body)) return body
  const text = typeof body === "string" ? body : new TextDecoder().decode(body)
  if (!text.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw fail(400, "request body must be a JSON object")
  }
  if (!isRecord(parsed)) throw fail(400, "request body must be a JSON object")
  return parsed
}

async function fromFormData(form) {
  const fields = {}
  const files = []
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      if (fields[name] === undefined) fields[name] = value
      continue
    }
    const bytes = new Uint8Array(await value.arrayBuffer())
    const mime = normalizeMime(value.type) || sniffMime(bytes)
    files.push({ field: name, bytes, mime, filename: trimStr(value.name) || "upload" })
  }
  return { fields, files }
}

async function parseMediaInput(body, headers) {
  if (body && typeof FormData !== "undefined" && body instanceof FormData) return fromFormData(body)
  const ct = getHeader(headers, "content-type")
  const mime = ct.split(";")[0].trim().toLowerCase()
  if (mime === "multipart/form-data") {
    const bytes = await bytesOf(body)
    let form
    try {
      form = await new Response(bytes, { headers: { "content-type": ct } }).formData()
    } catch {
      throw fail(400, "request body must be multipart form data")
    }
    return fromFormData(form)
  }
  return { fields: jsonBody(body), files: [] }
}

// ---- media reference validation & CDN upload ---------------------------------

export function mediaRef(value) {
  if (typeof value === "string") {
    const url = value.trim()
    if (!url) return undefined
    if (url.startsWith("data:")) return { url }
    if (!/^https:\/\//i.test(url)) {
      throw fail(400, "media reference must be an HTTPS URL or a data: URL")
    }
    return { url }
  }
  if (isRecord(value)) {
    const url = trimStr(value.url)
    if (!url) return undefined
    return mediaRef(url)
  }
  return undefined
}

function sniffAudioMime(bytes, filename = "") {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg"
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return "audio/wav"
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg"
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac"
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "audio/mp4"
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm"
  const ext = /\.([a-z0-9]+)$/i.exec(trimStr(filename))?.[1]?.toLowerCase()
  const byExt = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    opus: "audio/opus",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    aac: "audio/aac",
    webm: "audio/webm",
  }
  return (ext && byExt[ext]) || ""
}

function parseDataUrl(url, kind = "image", { oversizeStatus = 400 } = {}) {
  const m = /^data:([^,]*),(.*)$/s.exec(url)
  if (!m) throw fail(400, "media data: URL is malformed")
  const meta = m[1]
  const payload = m[2]
  const isB64 = /;base64(?:;|$)/i.test(";" + meta)
  const rawMime = normalizeMime(
    meta
      .replace(/;base64$/i, "")
      .replace(/;base64;/gi, ";")
      .replace(/;charset=[^;]*/gi, "")
      .replace(/^;|;$/g, ""),
  )
  let bytes
  try {
    bytes = isB64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload))
  } catch {
    throw fail(400, "media data: URL is invalid")
  }
  if (!bytes.length) throw fail(400, "reference media is empty")
  if (bytes.length > MAX_UPLOAD_BYTES) throw fail(oversizeStatus, "reference media exceeds 64 MB limit")
  const mime = rawMime || (kind === "image" ? sniffMime(bytes) : kind === "audio" ? sniffAudioMime(bytes) || "audio/mpeg" : "application/octet-stream")
  const b64 = Buffer.from(bytes).toString("base64")
  return { bytes: new Uint8Array(bytes), mime, base64: b64, dataUri: `data:${mime};base64,${b64}` }
}

function fileToDataUri(file) {
  if (!file?.bytes?.length) throw fail(400, "reference image is empty")
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw fail(400, "reference image exceeds 64 MB limit")
  const mime = normalizeMime(file.mime) || sniffMime(file.bytes)
  const b64 = Buffer.from(file.bytes).toString("base64")
  return { bytes: file.bytes, mime, base64: b64, dataUri: `data:${mime};base64,${b64}` }
}

async function uploadDataUri(cloudPost, dataUri, filePrefix, signal) {
  const res = await cloudPost("/api/v1/files/upload", { file_data: dataUri, file_prefix: filePrefix }, { signal, timeoutMs: UPLOAD_TIMEOUT_MS, label: "files/upload" })
  const url = trimStr(res?.url)
  if (!url || !/^https:\/\//i.test(url)) throw fail(502, "MiniMax Design file upload returned no HTTPS URL")
  return url
}

async function resolveImageInputs(cloudPost, fields, files, { edits = false, mode = "cdn", signal } = {}) {
  if ((files ?? []).some((f) => f.field === "mask")) {
    throw fail(400, "MiniMax Design image models do not support mask edits")
  }
  const uploadedParts = (files ?? []).filter((f) => f.field === "image" || f.field === "image[]")
  const rawItems = []
  if (uploadedParts.length) {
    for (const part of uploadedParts) rawItems.push({ kind: "file", file: part })
  } else {
    const extra = isRecord(fields.extra) ? fields.extra : {}
    const list = Array.isArray(fields.reference_images)
      ? fields.reference_images
      : Array.isArray(extra.reference_images)
        ? extra.reference_images
        : null
    if (list?.length) {
      for (const item of list) {
        const ref = mediaRef(item)
        if (!ref) throw fail(400, "reference images must be HTTPS or data: URLs")
        rawItems.push({ kind: "ref", url: ref.url })
      }
    } else {
      const one = mediaRef(fields.image ?? fields.image_url ?? extra.image)
      if (one) rawItems.push({ kind: "ref", url: one.url })
    }
  }
  if (edits && !rawItems.length) throw fail(400, "image edits require at least one reference image")

  const out = []
  for (const item of rawItems) {
    if (item.kind === "file") {
      const encoded = fileToDataUri(item.file)
      out.push(mode === "cdn" ? await uploadDataUri(cloudPost, encoded.dataUri, "image", signal) : encoded.dataUri)
    } else if (item.url.startsWith("data:")) {
      const parsed = parseDataUrl(item.url, "image")
      out.push(mode === "cdn" ? await uploadDataUri(cloudPost, parsed.dataUri, "image", signal) : parsed.dataUri)
    } else {
      out.push(item.url)
    }
  }
  return out
}

async function resolveSingleMediaUrl(cloudPost, rawValue, filePrefix, signal) {
  const ref = mediaRef(rawValue)
  if (!ref) return undefined
  if (ref.url.startsWith("data:")) {
    const parsed = parseDataUrl(ref.url, filePrefix)
    return uploadDataUri(cloudPost, parsed.dataUri, filePrefix, signal)
  }
  return ref.url
}

async function resolveBase64Image(rawValue, externalFetch, signal) {
  const ref = mediaRef(rawValue)
  if (!ref) return undefined
  if (ref.url.startsWith("data:")) {
    const parsed = parseDataUrl(ref.url, "image")
    return { bytes_base64_encoded: parsed.base64, mime_type: parsed.mime }
  }
  const res = await fetchHttpsExternal(externalFetch, ref.url, { signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, label: "reference image" })
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (!bytes.length) throw fail(400, "reference image is empty")
  if (bytes.length > MAX_UPLOAD_BYTES) throw fail(400, "reference image exceeds 64 MB limit")
  const ct = normalizeMime(res.headers.get("content-type")?.split(";")[0])
  const mime = IMAGE_MIMES.has(ct) ? ct : sniffMime(bytes)
  return { bytes_base64_encoded: Buffer.from(bytes).toString("base64"), mime_type: mime }
}

// Fetch an external CDN URL without sending MiniMax credentials, refusing non-HTTPS redirects.
async function fetchHttpsExternal(fetchImpl, rawUrl, { signal, timeoutMs = DOWNLOAD_TIMEOUT_MS, label = "media download" } = {}) {
  let at
  try {
    at = new URL(rawUrl)
  } catch {
    throw fail(502, `${label}: invalid URL`)
  }
  if (at.protocol !== "https:") throw fail(502, `${label}: refusing non-HTTPS URL`)
  const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetchImpl(at.toString(), { method: "GET", redirect: "manual", signal: combinedSignal })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location")
      if (!loc) return res
      let next
      try {
        next = new URL(loc, at)
      } catch {
        throw fail(502, `${label}: invalid redirect URL`)
      }
      if (next.protocol !== "https:") {
        await res.body?.cancel?.().catch(() => {})
        throw fail(502, `${label}: refusing insecure redirect to ${next.origin}`)
      }
      await res.body?.cancel?.().catch(() => {})
      at = next
      continue
    }
    if (!res.ok) throw fail(502, `${label}: HTTP ${res.status}`)
    return res
  }
  throw fail(502, `${label}: too many redirects`)
}

// ---- model lookup ------------------------------------------------------------

function lookupMediaModel(specs, siteId, rawModel, kind) {
  const raw = trimStr(rawModel)
  const stripped = raw.startsWith(`${siteId}/`) ? raw.slice(siteId.length + 1) : raw
  const candidates = specs.filter((m) => m.kind === kind)
  const hit = candidates.find(
    (m) => m.id === stripped || m.upstreamId === stripped || m.modelName === stripped,
  )
  if (!hit) {
    const listed = candidates.map((m) => m.id).join(", ")
    throw fail(400, `Unknown MiniMax Design ${kind} model ${JSON.stringify(raw)}; expected one of ${listed}`)
  }
  return hit
}

// ---- image generation backends -----------------------------------------------

const IMAGE_PATHS = {
  minimax_image: { generate: "/api/v2/image/minimax/generate", query: "/api/v2/image/minimax/tasks" },
  openai: { generate: "/api/v2/image/openai/generate", query: "/api/v2/image/openai/tasks" },
  nano_banana: { generate: "/api/v2/image/nano_banana/generate", query: "/api/v2/image/nano_banana/tasks" },
  seedream: { generate: "/api/v2/image/seedream/generate", query: "/api/v2/image/seedream/tasks" },
  midjourney: { generate: "/api/v1/image/midjourney/generate", query: "/api/v1/image/midjourney/tasks" },
}

function resolveOpenAIImageSize(spec, fields, extra) {
  const explicit = trimStr(extra.size) || trimStr(fields.size)
  if (/^\d+\s*[x×]\s*\d+$/i.test(explicit)) {
    return explicit.toLowerCase().replace("×", "x")
  }
  const ar = nearestRatio(spec.aspectRatios, trimStr(extra.aspect_ratio) || trimStr(fields.aspect_ratio) || ratioFromSize(explicit)) || "1:1"
  const tier = (trimStr(extra.resolution) || trimStr(fields.resolution) || tierFromSizeOrQuality(explicit, extra.quality ?? fields.quality) || spec.defaultResolution || "1k").toLowerCase()
  return GPT_IMAGE_2_SIZE_MAP[tier]?.[ar] ?? GPT_IMAGE_2_SIZE_MAP["1k"]["1:1"]
}

function appendMidjourneyFlags(prompt, spec, fields, extra) {
  let out = prompt
  const ar = nearestRatio(spec.aspectRatios, trimStr(extra.aspect_ratio) || trimStr(fields.aspect_ratio) || ratioFromSize(fields.size))
  if (ar && ar !== "auto" && !/(^|\s)--ar\s/i.test(out)) out += ` --ar ${ar}`
  const stylize = trimStr(extra.stylize ?? fields.stylize)
  if (stylize && stylize !== "100" && !/(^|\s)--stylize\s/i.test(out)) out += ` --stylize ${stylize}`
  const chaos = trimStr(extra.chaos ?? fields.chaos)
  if (chaos && chaos !== "0" && !/(^|\s)--(?:chaos|c)\s/i.test(out)) out += ` --chaos ${chaos}`
  const weird = trimStr(extra.weird ?? fields.weird)
  if (weird && weird !== "0" && !/(^|\s)--(?:weird|w)\s/i.test(out)) out += ` --weird ${weird}`
  if (!/(^|\s)--(?:v|version|niji)(?:\s|=|$)/i.test(out)) {
    const id = spec.modelName || spec.id
    if (id === "midjourney-niji7") out += " --niji 7"
    else if (id === "midjourney-7") out += " --v 7"
    else if (id === "midjourney-8.1") out += " --v 8.1"
    else out += " --v 8.2"
  }
  return out
}

function extractImageUrls(resp) {
  const list = Array.isArray(resp?.image_urls) ? resp.image_urls.filter((u) => typeof u === "string" && /^https:\/\//i.test(u)) : []
  if (list.length) return list
  const one = trimStr(resp?.image_url)
  if (one && /^https:\/\//i.test(one)) return [one]
  return []
}

async function pollImageTask(cloudGet, queryPath, taskId, { signal, sleep, nowMs, pollIntervalMs, maxWaitMs }) {
  const deadline = nowMs() + maxWaitMs
  for (;;) {
    signal?.throwIfAborted?.()
    const resp = await cloudGet(`${queryPath}/${encodeURIComponent(taskId)}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "image poll" })
    const status = trimStr(resp?.status).toLowerCase()
    if (status === "failed" || status === "cancelled" || status === "canceled") {
      const errMsg = trimStr(resp?.base?.message) || trimStr(resp?.error_message) || trimStr(resp?.message) || `image task ${status}`
      throw fail(502, errMsg)
    }
    if (status === "success" || status === "completed") {
      const urls = extractImageUrls(resp)
      if (!urls.length) throw fail(502, "MiniMax Design image task completed without image URL")
      return urls
    }
    if (nowMs() >= deadline) throw fail(504, "MiniMax Design image generation timed out")
    await sleep(pollIntervalMs, signal)
  }
}

async function runImageGeneration(spec, fields, files, edits, { cloudPost, cloudGet, externalFetch, signal, sleep, nowMs, pollIntervalMs, maxWaitMs }) {
  const prompt = trimStr(fields.prompt)
  if (!prompt) throw fail(400, "prompt is required")
  const extra = isRecord(fields.extra) ? fields.extra : {}
  const nRaw = fields.n ?? extra.n
  const n = nRaw === undefined || nRaw === "" ? 1 : Math.trunc(Number(nRaw))
  if (!Number.isInteger(n) || n < 1 || n > 4) throw fail(400, "n must be an integer between 1 and 4")
  const paths = IMAGE_PATHS[spec.backend]
  if (!paths) throw fail(400, `Unsupported image backend ${spec.backend}`)

  const refMode = spec.backend === "openai" || spec.backend === "nano_banana" ? "datauri" : "cdn"
  const refs = await resolveImageInputs(cloudPost, fields, files, { edits, mode: refMode, signal })

  const submitOne = async (batchN = 1) => {
    const opt = (k) => extra[k] ?? fields[k]
    let body
    if (spec.backend === "minimax_image") {
      const aspect = nearestRatio(spec.aspectRatios, trimStr(opt("aspect_ratio")) || ratioFromSize(fields.size)) || "1:1"
      const tier = trimStr(opt("resolution")) || tierFromSizeOrQuality(fields.size, fields.quality) || spec.defaultResolution || "2K"
      const resolution = pickOptionCI(spec.resolutions, tier, spec.defaultResolution || "2K")
      body = { prompt, model: spec.modelName, image_paths: refs, resolution, aspect_ratio: aspect }
    } else if (spec.backend === "openai") {
      const size = resolveOpenAIImageSize(spec, fields, extra)
      const quality = trimStr(opt("quality")) || spec.defaultQuality || "medium"
      const bg = trimStr(opt("background"))
      body = {
        prompt,
        model: spec.modelName,
        size,
        image_paths: refs,
        quality,
        n: batchN,
        ...(bg && bg !== "auto" ? { background: bg } : {}),
        ...(trimStr(opt("output_format")) ? { output_format: trimStr(opt("output_format")) } : {}),
      }
    } else if (spec.backend === "nano_banana") {
      const aspect = nearestRatio(spec.aspectRatios, trimStr(opt("aspect_ratio")) || ratioFromSize(fields.size))
      const tier = trimStr(opt("resolution")) || tierFromSizeOrQuality(fields.size, fields.quality) || spec.defaultResolution || "1K"
      const resolution = pickOptionCI(spec.resolutions, tier, "1K")
      body = {
        prompt,
        model_name: spec.modelName,
        image_paths: refs,
        aspect_ratio: aspect && aspect !== "auto" ? aspect : "",
        resolution: resolution === "auto" ? "1K" : resolution,
      }
    } else if (spec.backend === "seedream") {
      const aspect = nearestRatio(spec.aspectRatios, trimStr(opt("aspect_ratio")) || ratioFromSize(fields.size))
      const tier = trimStr(opt("resolution")) || tierFromSizeOrQuality(fields.size, fields.quality) || spec.defaultResolution || "2K"
      const resolution = pickOptionCI(spec.resolutions, tier, spec.defaultResolution || "2K")
      body = {
        prompt,
        model: spec.modelName,
        image_paths: refs,
        aspect_ratio: aspect && aspect !== "auto" ? aspect : "1:1",
        size: resolution,
      }
      if (!spec.modelName.includes("5-0")) {
        body.seed = Number.isFinite(Number(opt("seed"))) ? Number(opt("seed")) : -1
        body.guidance_scale = Number.isFinite(Number(opt("guidance_scale"))) ? Number(opt("guidance_scale")) : 5.0
      }
    } else if (spec.backend === "midjourney") {
      const prefixed = refs.length ? `${refs.join(" ")} ${prompt}` : prompt
      const finalPrompt = appendMidjourneyFlags(prefixed, spec, fields, extra)
      const mjParams = {}
      for (const k of ["aspect_ratio", "clarity", "stylize", "chaos", "weird", "version"]) {
        const v = opt(k)
        if (v !== undefined && v !== "") mjParams[k] = String(v)
      }
      body = { prompt: finalPrompt, params: mjParams }
    }

    const submitted = await cloudPost(paths.generate, body, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: `${spec.backend} submit` })
    const taskId = trimStr(submitted?.task_id)
    if (!taskId) throw fail(502, `MiniMax Design ${spec.backend} submit returned no task_id`)
    return pollImageTask(cloudGet, paths.query, taskId, { signal, sleep, nowMs, pollIntervalMs, maxWaitMs })
  }

  let urls
  if (spec.backend === "openai") {
    urls = await submitOne(n)
  } else if (spec.backend === "midjourney") {
    const all = await submitOne(1)
    urls = nRaw !== undefined && nRaw !== "" ? all.slice(0, n) : all
  } else {
    const batches = await Promise.all(Array.from({ length: n }, () => submitOne(1)))
    urls = batches.flat()
  }

  const wantB64 = trimStr(fields.response_format).toLowerCase() === "b64_json"
  let data
  if (wantB64) {
    data = await Promise.all(
      urls.map(async (u) => {
        const res = await fetchHttpsExternal(externalFetch, u, { signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, label: "image download" })
        return { b64_json: Buffer.from(await res.arrayBuffer()).toString("base64") }
      }),
    )
  } else {
    data = urls.map((url) => ({ url }))
  }
  return { created: Math.floor(nowMs() / 1000), data }
}

// ---- video generation backends -----------------------------------------------

function isKlingOmni(spec) {
  return spec.modelName === "kling-v3-omni" || spec.modelName === "kling-video-o1"
}

async function submitVideo(spec, fields, { cloudPost, externalFetch, signal, nowMs }) {
  const prompt = trimStr(fields.prompt)
  if (!prompt && spec.backend !== "kling_avatar") throw fail(400, "prompt is required")
  const extra = isRecord(fields.extra) ? fields.extra : {}
  const opt = (k) => extra[k] ?? fields[k]
  const duration = pickDuration(spec, fields.seconds ?? opt("duration"))
  const rawRatio = trimStr(opt("aspect_ratio")) || trimStr(opt("ratio")) || ratioFromSize(fields.size)
  const ratio = nearestRatio(spec.aspectRatios, rawRatio)
  const resolution = pickVideoResolution(spec, fields.size, opt("resolution"))
  const rawGenAudio = opt("generate_audio")
  const generateAudio = rawGenAudio !== false && rawGenAudio !== "false"

  const rawStart = fields.input_reference ?? fields.input_image ?? extra.first_frame_image
  const rawEnd = fields.last_frame ?? fields.last_frame_image ?? extra.last_frame_image
  const rawRefs = Array.isArray(fields.reference_images)
    ? fields.reference_images
    : Array.isArray(extra.reference_images)
      ? extra.reference_images
      : []

  let taskId
  if (spec.backend === "minimax_v3") {
    const [firstFrame, lastFrame, refImages] = await Promise.all([
      resolveSingleMediaUrl(cloudPost, rawStart, "image", signal),
      resolveSingleMediaUrl(cloudPost, rawEnd, "image", signal),
      Promise.all(rawRefs.map((r) => resolveSingleMediaUrl(cloudPost, r, "image", signal))).then((l) => l.filter(Boolean)),
    ])
    const isMax = spec.modelName === "MiniMax-H3-Max"
    const payload = {
      model: spec.modelName,
      prompt,
      duration,
      resolution: resolution || (isMax ? "480P" : "768P"),
      ...(!isMax ? { generate_audio: generateAudio } : {}),
      ...(ratio ? { ratio } : { ratio: "adaptive" }),
      ...(firstFrame ? { first_frame_image: firstFrame } : {}),
      ...(lastFrame ? { last_frame_image: lastFrame } : {}),
      ...(refImages.length ? { reference_images: refImages } : {}),
      ...(isMax && trimStr(opt("prompt_expansion_mode")) ? { prompt_expansion_mode: trimStr(opt("prompt_expansion_mode")) } : {}),
    }
    const resp = await cloudPost("/api/v1/video/minimax-v3/generate", payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "minimax_v3 submit" })
    if (resp?.base_resp?.status_code && Number(resp.base_resp.status_code) !== 0) {
      throw fail(502, trimStr(resp.base_resp.status_msg) || `MiniMax-H3 submit error (${resp.base_resp.status_code})`)
    }
    taskId = trimStr(resp?.task_id)
  } else if (spec.backend === "seedance") {
    const [firstFrame, lastFrame, refImages] = await Promise.all([
      resolveSingleMediaUrl(cloudPost, rawStart, "image", signal),
      resolveSingleMediaUrl(cloudPost, rawEnd, "image", signal),
      Promise.all(rawRefs.map((r) => resolveSingleMediaUrl(cloudPost, r, "image", signal))).then((l) => l.filter(Boolean)),
    ])
    const payload = {
      model: spec.modelName,
      prompt,
      ratio: ratio || "adaptive",
      duration,
      generate_audio: generateAudio,
      ...(resolution ? { resolution } : {}),
      ...(trimStr(opt("output_format")) ? { output_format: trimStr(opt("output_format")).toLowerCase() } : {}),
      ...(firstFrame ? { first_frame_image: firstFrame } : {}),
      ...(lastFrame ? { last_frame_image: lastFrame } : {}),
      ...(refImages.length ? { reference_images: refImages } : {}),
    }
    const resp = await cloudPost("/api/v1/video/seedance/generate", payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "seedance submit" })
    taskId = trimStr(resp?.task_id)
  } else if (spec.backend === "wan_i2v") {
    const [firstFrame, lastFrame, refImages] = await Promise.all([
      resolveSingleMediaUrl(cloudPost, rawStart, "image", signal),
      resolveSingleMediaUrl(cloudPost, rawEnd, "image", signal),
      Promise.all(rawRefs.map((r) => resolveSingleMediaUrl(cloudPost, r, "image", signal))).then((l) => l.filter(Boolean)),
    ])
    const payload = {
      model: spec.modelName,
      prompt,
      duration,
      ...(resolution ? { resolution } : {}),
      ...(ratio ? { ratio } : { ratio: "adaptive" }),
      audio: generateAudio,
      ...(firstFrame ? { first_frame_image: firstFrame } : {}),
      ...(lastFrame ? { last_frame_image: lastFrame } : {}),
      ...(refImages.length ? { reference_images: refImages } : {}),
    }
    const resp = await cloudPost("/api/v1/video/wan3/generate", payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "wan3 submit" })
    taskId = trimStr(resp?.output?.task_id) || trimStr(resp?.task_id)
  } else if (spec.backend === "kling") {
    const mode = trimStr(opt("mode")) || spec.defaultMode || "pro"
    if (isKlingOmni(spec)) {
      const [firstFrame, lastFrame, refImages] = await Promise.all([
        resolveSingleMediaUrl(cloudPost, rawStart, "image", signal),
        resolveSingleMediaUrl(cloudPost, rawEnd, "image", signal),
        Promise.all(rawRefs.map((r) => resolveSingleMediaUrl(cloudPost, r, "image", signal))).then((l) => l.filter(Boolean)),
      ])
      const imageList = []
      if (firstFrame) imageList.push({ image_url: firstFrame, type: "first_frame" })
      if (lastFrame) imageList.push({ image_url: lastFrame, type: "end_frame" })
      for (const u of refImages) imageList.push({ image_url: u })
      const sound = trimStr(opt("sound")) || (rawGenAudio === true || rawGenAudio === "true" ? "on" : "off")
      const payload = {
        model_name: spec.modelName,
        prompt,
        mode,
        aspect_ratio: ratio || "16:9",
        duration: String(duration),
        sound: spec.modelName === "kling-video-o1" ? "off" : sound,
        ...(imageList.length ? { image_list: imageList } : {}),
      }
      const resp = await cloudPost("/api/v1/video/kling-omni/generate", payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "kling-omni submit" })
      if (resp?.code != null && Number(resp.code) !== 0) {
        throw fail(502, trimStr(resp?.message) || `Kling submit failed (code=${resp.code})`)
      }
      taskId = trimStr(resp?.data?.task_id) || trimStr(resp?.task_id)
    } else {
      const start = rawStart ? await resolveBase64Image(rawStart, externalFetch, signal) : undefined
      const payload = {
        prompt,
        model_name: spec.modelName,
        duration: String(duration),
        mode,
        ...(start ? { image: start.bytes_base64_encoded } : {}),
      }
      const resp = await cloudPost("/api/v1/video/kling/generate", payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "kling submit" })
      if (resp?.code != null && Number(resp.code) !== 0) {
        throw fail(502, trimStr(resp?.message) || `Kling submit failed (code=${resp.code})`)
      }
      taskId = trimStr(resp?.data?.task_id) || trimStr(resp?.task_id)
    }
  } else if (spec.backend === "kling_avatar") {
    const rawSound = fields.sound_file ?? extra.sound_file ?? extra.audio_url
    if (!rawStart || !rawSound) {
      throw fail(400, "kling-avatar requires both an image (input_reference) and an audio file (extra.sound_file)")
    }
    const [imageUrl, audioUrl] = await Promise.all([
      resolveSingleMediaUrl(cloudPost, rawStart, "image", signal),
      resolveSingleMediaUrl(cloudPost, rawSound, "audio", signal),
    ])
    const payload = {
      image: imageUrl,
      sound_file: audioUrl,
      prompt,
      mode: trimStr(opt("mode")) || spec.defaultMode || "std",
    }
    const resp = await cloudPost("/api/v1/video/kling/avatar", payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "kling-avatar submit" })
    if (resp?.code != null && Number(resp.code) !== 0) {
      throw fail(502, trimStr(resp?.message) || `Kling avatar submit failed (code=${resp.code})`)
    }
    taskId = trimStr(resp?.data?.task_id) || trimStr(resp?.task_id)
  } else if (spec.backend === "veo3") {
    const instance = { prompt }
    const [firstImg, lastImg] = await Promise.all([
      resolveBase64Image(rawStart, externalFetch, signal),
      resolveBase64Image(rawEnd, externalFetch, signal),
    ])
    if (firstImg) instance.image = firstImg
    if (lastImg) instance.last_frame = lastImg
    const payload = {
      instances: [instance],
      parameters: {
        duration_seconds: duration,
        aspect_ratio: ratio || "16:9",
        resolution: resolution || "720p",
        generate_audio: generateAudio,
        person_generation: "allow_all",
      },
    }
    const path = `/api/v1/video/veo3/generate?model=${encodeURIComponent(spec.modelName)}`
    const resp = await cloudPost(path, payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: "veo3 submit" })
    taskId = trimStr(resp?.task_id)
  } else {
    throw fail(400, `Unsupported video backend ${spec.backend}`)
  }

  if (!taskId) throw fail(502, `MiniMax Design ${spec.backend} submit returned no task_id`)
  return {
    id: encodeVideoId(spec.id, taskId),
    object: "video",
    created_at: Math.floor(nowMs() / 1000),
    status: "queued",
    progress: 0,
    model: spec.id,
    seconds: String(duration),
    ...(fields.size ? { size: String(fields.size) } : {}),
  }
}

async function queryVideoStatus(spec, taskId, { cloudGet, signal }) {
  const encodedId = encodeURIComponent(taskId)
  if (spec.backend === "minimax_v3") {
    const resp = await cloudGet(`/api/v1/video/minimax-v3/tasks/${encodedId}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "minimax_v3 poll" })
    const st = trimStr(resp?.status).toLowerCase()
    if (st === "failed" || st === "fail" || st === "cancelled" || st === "canceled") {
      return { status: "failed", progress: 0, error: trimStr(resp?.base_resp?.status_msg) || `video task ${st}` }
    }
    if (st === "success" || st === "succeeded" || st === "completed") {
      return { status: "completed", progress: 100, fileId: trimStr(resp?.file_id), url: trimStr(resp?.video_url) || undefined }
    }
    return { status: st === "preparing" || st === "queueing" || st === "queued" || st === "pending" ? "queued" : "in_progress", progress: st === "processing" || st === "running" ? 50 : 0 }
  }
  if (spec.backend === "seedance") {
    const resp = await cloudGet(`/api/v1/video/seedance/tasks/${encodedId}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "seedance poll" })
    const st = trimStr(resp?.status).toLowerCase()
    if (st === "failed" || st === "cancelled" || st === "canceled") {
      return { status: "failed", progress: 0, error: trimStr(resp?.error_message) || trimStr(resp?.message) || `video task ${st}` }
    }
    if (st === "succeeded" || st === "success" || st === "completed") {
      return { status: "completed", progress: 100, url: trimStr(resp?.video_url) }
    }
    return { status: st === "queued" || st === "pending" ? "queued" : "in_progress", progress: st === "running" || st === "processing" ? 50 : 0 }
  }
  if (spec.backend === "wan_i2v") {
    const resp = await cloudGet(`/api/v1/video/wan3/tasks/${encodedId}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "wan3 poll" })
    const st = trimStr(resp?.output?.task_status ?? resp?.status).toUpperCase()
    if (st === "FAILED" || st === "CANCELLED" || st === "CANCELED") {
      return { status: "failed", progress: 0, error: trimStr(resp?.message) || trimStr(resp?.output?.message) || `video task ${st.toLowerCase()}` }
    }
    if (st === "SUCCEEDED" || st === "SUCCESS" || st === "COMPLETED") {
      return { status: "completed", progress: 100, url: trimStr(resp?.output?.video_url ?? resp?.video_url) }
    }
    return { status: st === "PENDING" || st === "QUEUED" ? "queued" : "in_progress", progress: st === "RUNNING" ? 50 : 0 }
  }
  if (spec.backend === "kling" || spec.backend === "kling_avatar") {
    const queryPath =
      spec.backend === "kling_avatar"
        ? "/api/v1/video/kling/avatar"
        : isKlingOmni(spec)
          ? "/api/v1/video/kling-omni/tasks"
          : "/api/v1/video/kling/tasks"
    const resp = await cloudGet(`${queryPath}/${encodedId}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "kling poll" })
    const st = trimStr(resp?.data?.task_status).toLowerCase()
    if (st === "failed" || st === "cancelled" || st === "canceled") {
      return { status: "failed", progress: 0, error: trimStr(resp?.data?.task_status_msg) || trimStr(resp?.message) || `video task ${st}` }
    }
    if (st === "succeed" || st === "succeeded" || st === "completed") {
      return { status: "completed", progress: 100, url: trimStr(resp?.data?.task_result?.videos?.[0]?.url) }
    }
    return { status: st === "submitted" || st === "queued" || st === "pending" ? "queued" : "in_progress", progress: st === "processing" ? 50 : 0 }
  }
  if (spec.backend === "veo3") {
    const resp = await cloudGet(`/api/v1/video/veo3/tasks/${encodedId}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "veo3 poll" })
    const st = trimStr(resp?.status).toLowerCase()
    if (st === "failed" || st === "cancelled" || st === "canceled") {
      return { status: "failed", progress: 0, error: trimStr(resp?.error_message) || trimStr(resp?.error_code) || `video task ${st}` }
    }
    if (st === "completed" || st === "succeeded" || st === "success") {
      return { status: "completed", progress: 100, url: trimStr(resp?.video_url) }
    }
    return { status: st === "queued" || st === "pending" ? "queued" : "in_progress", progress: st === "running" || st === "processing" ? 50 : 0 }
  }
  throw fail(400, `Unsupported video backend ${spec.backend}`)
}

async function resolveVideoDownloadUrl(spec, polled, { cloudGet, signal }) {
  if (polled.url) return polled.url
  if (spec.backend === "minimax_v3" && polled.fileId) {
    const resp = await cloudGet(`/api/v1/video/minimax/files/${encodeURIComponent(polled.fileId)}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: "minimax_v3 file retrieve" })
    const url = trimStr(resp?.file?.download_url)
    if (url) return url
  }
  return ""
}

// ---- audio (TTS & ASR) backends ----------------------------------------------

function mapMultiplierToRate(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined
  const x = Number(raw)
  if (!Number.isFinite(x) || x <= 0) throw fail(400, "speed/volume must be a positive number")
  const rate = Math.round((x - 1) * 100)
  return rate === 0 ? undefined : Math.min(100, Math.max(-50, rate))
}

function parseJsonObjectOpt(raw, name) {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (isRecord(raw)) return raw
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (isRecord(parsed)) return parsed
    } catch {}
  }
  throw fail(400, `${name} must be a JSON object`)
}

async function pollCloudV2Audio(submitPath, queryPath, payload, label, { cloudPost, cloudGet, signal, sleep, nowMs, pollIntervalMs, maxWaitMs }) {
  const sub = await cloudPost(submitPath, payload, { signal, timeoutMs: SUBMIT_TIMEOUT_MS, label: `${label} submit` })
  const taskId = trimStr(sub?.task_id)
  if (!taskId) throw fail(502, `MiniMax Design ${label}: missing task_id`)

  const deadline = nowMs() + maxWaitMs
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted")
    const q = await cloudGet(`${queryPath}/${encodeURIComponent(taskId)}`, { signal, timeoutMs: POLL_TIMEOUT_MS, label: `${label} poll` })
    const st = trimStr(q?.status).toLowerCase()
    if (st === "success" || st === "completed" || st === "succeeded") {
      const url = trimStr(q?.audio_url)
      if (!url || !/^https:\/\//i.test(url)) throw fail(502, `MiniMax Design ${label}: completed without HTTPS audio_url`)
      return { url, duration: typeof q?.duration === "number" ? q.duration : undefined }
    }
    if (st === "failed" || st === "cancelled" || st === "canceled") {
      throw fail(502, trimStr(q?.base?.user_message) || trimStr(q?.base?.message) || trimStr(q?.message) || `${label} ${st}`)
    }
    if (nowMs() >= deadline) throw fail(504, `MiniMax Design ${label} timed out`)
    await sleep(pollIntervalMs)
  }
}

async function runSpeechSynthesis(spec, fields, { cloudPost, cloudGet, externalFetch, signal, sleep, nowMs, pollIntervalMs, maxWaitMs }) {
  const input = trimStr(fields.input)
  if (!input) throw fail(400, "input text is required")

  const extra = isRecord(fields.extra) ? fields.extra : {}
  const opt = (k) => extra[k] ?? fields[k]
  let submitPath
  let queryPath
  let payload
  let expectedContentType = "audio/mpeg"

  if (spec.backend === "minimax_tts") {
    submitPath = "/api/v2/audio/tts"
    queryPath = "/api/v2/audio/tts/tasks"
    const rawSpeed = opt("speed")
    let speed = 1
    if (rawSpeed !== undefined && rawSpeed !== null && rawSpeed !== "") {
      speed = Number(rawSpeed)
      if (!Number.isFinite(speed) || speed <= 0) throw fail(400, "speed must be a positive number")
    }
    payload = {
      model: spec.modelName || spec.id,
      text: input,
      voice_id: trimStr(opt("voice_id") ?? fields.voice) || DEFAULT_TTS_VOICE,
      speed,
      language_boost: trimStr(opt("language_boost")) || "auto",
      subtitle_enable: Boolean(opt("subtitle_enable")),
    }
    const emotion = trimStr(opt("emotion"))
    if (emotion) payload.emotion = emotion
    const vol = opt("vol") ?? opt("volume")
    if (vol !== undefined && vol !== null && vol !== "") {
      const n = Number(vol)
      if (!Number.isFinite(n)) throw fail(400, "vol must be a finite number")
      payload.vol = n
    }
    const pitch = opt("pitch")
    if (pitch !== undefined && pitch !== null && pitch !== "") {
      const n = Number(pitch)
      if (!Number.isFinite(n)) throw fail(400, "pitch must be a finite number")
      payload.pitch = n
    }
    const pronunciation = parseJsonObjectOpt(opt("pronunciation_dict"), "pronunciation_dict")
    if (pronunciation) payload.pronunciation_dict = pronunciation
    const voiceModify = parseJsonObjectOpt(opt("voice_modify"), "voice_modify")
    if (voiceModify) payload.voice_modify = voiceModify
  } else if (spec.backend === "seedaudio") {
    submitPath = "/api/v2/audio/seedaudio/tts"
    queryPath = "/api/v2/audio/seedaudio/tts/tasks"
    const instructions = trimStr(fields.instructions)
    payload = {
      model: spec.modelName || spec.id,
      text_prompt: instructions ? `${instructions}\n${input}` : input,
    }
    const speechRate = mapMultiplierToRate(opt("speed"))
    if (speechRate !== undefined) payload.speech_rate = speechRate
    const loudnessRate = mapMultiplierToRate(opt("volume"))
    if (loudnessRate !== undefined) payload.loudness_rate = loudnessRate
    const rawPitch = opt("pitch")
    if (rawPitch !== undefined && rawPitch !== null && rawPitch !== "") {
      const n = Number(rawPitch)
      if (!Number.isFinite(n)) throw fail(400, "pitch must be a finite number")
      payload.pitch_rate = Math.trunc(n)
    }
    const rawFmt = trimStr(opt("format") ?? fields.response_format).toLowerCase()
    if (rawFmt) {
      const mapped = SEEDAUDIO_FORMATS[rawFmt]
      if (!mapped) throw fail(400, `Unsupported SeedAudio format ${JSON.stringify(rawFmt)}; expected mp3, wav, pcm, or opus`)
      payload.format = mapped.format
      expectedContentType = mapped.contentType
    } else {
      expectedContentType = "audio/wav"
    }
    const rawSampleRate = opt("sample_rate")
    if (rawSampleRate !== undefined && rawSampleRate !== null && rawSampleRate !== "") {
      const sr = Math.trunc(Number(rawSampleRate))
      if (!Number.isFinite(sr) || sr <= 0) throw fail(400, "sample_rate must be a positive integer")
      if (payload.format === "ogg_opus" && sr !== 48000) {
        throw fail(400, "ogg_opus requires sample_rate 48000")
      }
      payload.sample_rate = sr
    } else if (payload.format === "ogg_opus") {
      payload.sample_rate = 48000
    }

    const audioRefs = Array.isArray(opt("audio_urls")) ? opt("audio_urls") : []
    const imageRefs = Array.isArray(opt("image_urls")) ? opt("image_urls") : []
    if (audioRefs.length && imageRefs.length) {
      throw fail(400, "seed-audio-1.0 cannot mix audio_urls and image_urls references")
    }
    if (audioRefs.length > 3) throw fail(400, "seed-audio-1.0 accepts at most 3 audio_urls")
    if (imageRefs.length > 1) throw fail(400, "seed-audio-1.0 accepts at most 1 image_urls")
    const references = []
    for (const rawRef of audioRefs) {
      const u = await resolveSingleMediaUrl(cloudPost, rawRef, "audio", signal)
      if (u) references.push({ audio_url: u })
    }
    for (const rawRef of imageRefs) {
      const u = await resolveSingleMediaUrl(cloudPost, rawRef, "image", signal)
      if (u) references.push({ image_url: u })
    }
    if (references.length) payload.references = references
  } else {
    throw fail(400, `Unsupported audio backend ${spec.backend}`)
  }

  const { url } = await pollCloudV2Audio(submitPath, queryPath, payload, spec.backend, {
    cloudPost,
    cloudGet,
    signal,
    sleep,
    nowMs,
    pollIntervalMs,
    maxWaitMs,
  })
  const dlRes = await fetchHttpsExternal(externalFetch, url, { signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, label: "audio download" })
  const outHeaders = new Headers(dlRes.headers)
  outHeaders.delete("content-encoding")
  outHeaders.delete("content-length")
  if (!outHeaders.get("content-type") || outHeaders.get("content-type").startsWith("application/octet-stream")) {
    outHeaders.set("content-type", expectedContentType)
  }
  return { body: dlRes.body, headers: outHeaders }
}

function formatTimestamp(sec, sep) {
  const totalMs = Math.max(0, Math.round(Number(sec || 0) * 1000))
  const ms = totalMs % 1000
  const totalSec = Math.floor(totalMs / 1000)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad2 = (n) => String(n).padStart(2, "0")
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${sep}${String(ms).padStart(3, "0")}`
}

function formatSubtitles(segments, kind) {
  const sep = kind === "srt" ? "," : "."
  const blocks = segments.map((seg, i) => {
    const line = `${formatTimestamp(seg.start, sep)} --> ${formatTimestamp(seg.end, sep)}\n${seg.text}`
    return kind === "srt" ? `${i + 1}\n${line}` : line
  })
  return kind === "vtt" ? `WEBVTT\n\n${blocks.join("\n\n")}\n` : `${blocks.join("\n\n")}\n`
}

async function runAudioTranscription(fields, files, { cloudPost, signal }) {
  const format = trimStr(fields.response_format).toLowerCase() || "json"
  if (!ASR_RESPONSE_FORMATS.has(format)) {
    throw fail(400, `Unsupported response_format ${JSON.stringify(format)}; expected json, text, verbose_json, srt, or vtt`)
  }

  let audioUrl = ""
  const filePart = (files ?? []).find((f) => f.field === "file")
  if (filePart) {
    if (!filePart.bytes?.length) throw fail(400, "audio file is empty")
    if (filePart.bytes.length > MAX_UPLOAD_BYTES) throw fail(413, "audio file exceeds 64 MB limit")
    const mime = normalizeMime(filePart.mime) || sniffAudioMime(filePart.bytes, filePart.filename)
    if (!mime || !AUDIO_MIMES.has(mime)) {
      throw fail(400, `Unsupported audio media type ${JSON.stringify(mime || "unknown")}`)
    }
    const dataUri = `data:${mime};base64,${Buffer.from(filePart.bytes).toString("base64")}`
    audioUrl = await uploadDataUri(cloudPost, dataUri, "audio", signal)
  } else if (fields.audio_url) {
    const ref = mediaRef(fields.audio_url)
    if (!ref) throw fail(400, "audio file or audio_url is required")
    if (ref.url.startsWith("data:")) {
      const parsed = parseDataUrl(ref.url, "audio", { oversizeStatus: 413 })
      audioUrl = await uploadDataUri(cloudPost, parsed.dataUri, "audio", signal)
    } else {
      audioUrl = ref.url
    }
  } else {
    throw fail(400, "audio file or audio_url is required")
  }

  const language = trimStr(fields.language) || "auto"
  const totalDuration = Number(fields.total_duration)
  const payload = {
    audio_url: audioUrl,
    language,
    total_duration: Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : 0,
  }
  const resp = await cloudPost("/api/v1/audio/asr", payload, { signal, timeoutMs: ASR_TIMEOUT_MS, label: "audio/asr" })

  const rawSegments = Array.isArray(resp.segments) ? resp.segments : []
  const segments = rawSegments
    .filter((seg) => isRecord(seg) && typeof seg.start === "number" && typeof seg.end === "number")
    .map((seg, id) => ({
      id,
      start: seg.start,
      end: seg.end,
      text: typeof seg.text === "string" ? seg.text : "",
      ...(Array.isArray(seg.words)
        ? {
            words: seg.words
              .filter((w) => isRecord(w) && typeof w.start === "number" && typeof w.end === "number")
              .map((w) => ({ word: String(w.word ?? ""), start: w.start, end: w.end })),
          }
        : {}),
    }))
  const text = typeof resp.text === "string" ? resp.text : segments.map((s) => s.text).join(" ").trim()

  if (format === "text") {
    return { body: text, contentType: "text/plain; charset=utf-8" }
  }
  if (format === "srt") {
    return { body: formatSubtitles(segments, "srt"), contentType: "text/plain; charset=utf-8" }
  }
  if (format === "vtt") {
    return { body: formatSubtitles(segments, "vtt"), contentType: "text/vtt; charset=utf-8" }
  }
  if (format === "verbose_json") {
    const duration = segments.length ? segments[segments.length - 1].end : 0
    const words = segments.flatMap((s) => s.words ?? [])
    return {
      body: JSON.stringify({
        task: "transcribe",
        language: trimStr(resp.language) || (language === "auto" ? "" : language),
        duration,
        text,
        segments: segments.map(({ id, start, end, text: segText }) => ({ id, start, end, text: segText })),
        ...(words.length ? { words } : {}),
      }),
      contentType: "application/json",
    }
  }
  return { body: JSON.stringify({ text }), contentType: "application/json" }
}

// ---- top-level media fetch handler -------------------------------------------

function jsonResp(body, status = 200, signIn = "kept") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "X-Magpie-Sign-In": signIn },
  })
}

export async function handleMediaFetch(
  url,
  { method, body, headers, signal } = {},
  {
    site,
    cloudRequest,
    externalFetch = globalThis.fetch,
    getMediaSpecs,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    nowMs = () => Date.now(),
    pollIntervalMs = IMAGE_POLL_INTERVAL_MS,
    maxWaitMs = IMAGE_POLL_MAX_WAIT_MS,
  } = {},
) {
  const route = mediaPath(url)
  if (!route) return null

  const verb = String(method ?? "GET").toUpperCase()
  let lastSignIn = "kept"

  const cloudJson = async (reqMethod, path, payload, opts = {}) => {
    const { res, renewed } = await cloudRequest(reqMethod, path, payload, opts)
    if (renewed) lastSignIn = "renewed"
    if (res.status === 401) {
      const text = await res.text().catch(() => "")
      throw fail(401, text || `${site.name}: unauthorized`, { signIn: "expired", rawResponse: true })
    }
    if (res.status === 429) {
      const text = await res.text().catch(() => "")
      throw fail(429, text || `${site.name}: rate limited`, { signIn: "kept", rawResponse: true, headers: res.headers })
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      let msg = `${site.name} ${opts.label ?? path}: HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text)
        msg = trimStr(parsed?.error?.message) || trimStr(parsed?.message) || trimStr(parsed?.base?.message) || msg
      } catch {
        if (text.trim()) msg = `${msg} (${text.trim().slice(0, 200)})`
      }
      throw fail(res.status >= 400 && res.status < 600 ? res.status : 502, msg, { signIn: res.headers.get("X-Magpie-Sign-In") || "kept" })
    }
    const parsed = await res.json().catch(() => null)
    if (!isRecord(parsed)) throw fail(502, `${site.name} ${opts.label ?? path}: invalid JSON response`)
    return parsed
  }

  const cloudPost = (path, payload, opts) => cloudJson("POST", path, payload, opts)
  const cloudGet = (path, opts) => cloudJson("GET", path, undefined, opts)

  try {
    const specs = await getMediaSpecs()

    if (route.kind === "image.generations" || route.kind === "image.edits") {
      if (verb !== "POST") return jsonResp({ error: { message: "use POST for image generation", type: "invalid_request_error" } }, 405)
      const { fields, files } = await parseMediaInput(body, headers)
      const spec = lookupMediaModel(specs, site.id, fields.model, "image")
      const out = await runImageGeneration(spec, fields, files, route.kind === "image.edits", {
        cloudPost,
        cloudGet,
        externalFetch,
        signal,
        sleep,
        nowMs,
        pollIntervalMs,
        maxWaitMs,
      })
      return jsonResp(out, 200, lastSignIn)
    }

    if (route.kind === "audio.speech") {
      if (verb !== "POST") return jsonResp({ error: { message: "use POST for speech synthesis", type: "invalid_request_error" } }, 405)
      const fields = jsonBody(body)
      const spec = lookupMediaModel(specs, site.id, fields.model, "audio")
      const { body: audioBody, headers: outHeaders } = await runSpeechSynthesis(spec, fields, {
        cloudPost,
        cloudGet,
        externalFetch,
        signal,
        sleep,
        nowMs,
        pollIntervalMs: Math.min(pollIntervalMs, AUDIO_POLL_INTERVAL_MS),
        maxWaitMs: Math.min(maxWaitMs, AUDIO_POLL_MAX_WAIT_MS),
      })
      outHeaders.set("X-Magpie-Sign-In", lastSignIn)
      return new Response(audioBody, { status: 200, headers: outHeaders })
    }

    if (route.kind === "audio.transcriptions") {
      if (verb !== "POST") return jsonResp({ error: { message: "use POST for audio transcription", type: "invalid_request_error" } }, 405)
      const { fields, files } = await parseMediaInput(body, headers)
      lookupMediaModel(specs, site.id, fields.model, "transcription")
      const { body: outBody, contentType } = await runAudioTranscription(fields, files, { cloudPost, signal })
      return new Response(outBody, {
        status: 200,
        headers: { "content-type": contentType, "X-Magpie-Sign-In": lastSignIn },
      })
    }

    if (route.kind === "video.create") {
      if (verb !== "POST") return jsonResp({ error: { message: "use POST to start a video", type: "invalid_request_error" } }, 405)
      const { fields } = await parseMediaInput(body, headers)
      const spec = lookupMediaModel(specs, site.id, fields.model, "video")
      const out = await submitVideo(spec, fields, { cloudPost, externalFetch, signal, nowMs })
      return jsonResp(out, 200, lastSignIn)
    }

    if (verb !== "GET") return jsonResp({ error: { message: "use GET to read a video", type: "invalid_request_error" } }, 405)
    const { modelId, taskId } = decodeVideoId(route.id)
    const spec = lookupMediaModel(specs, site.id, modelId, "video")
    const polled = await queryVideoStatus(spec, taskId, { cloudGet, signal })

    if (route.kind === "video.get") {
      const obj = {
        id: route.id,
        object: "video",
        created_at: Math.floor(nowMs() / 1000),
        status: polled.status,
        progress: polled.progress,
        model: spec.id,
      }
      if (polled.status === "failed") {
        obj.error = { code: "failed", message: polled.error || "MiniMax Design video generation failed" }
      }
      return jsonResp(obj, 200, lastSignIn)
    }

    // route.kind === "video.content"
    if (polled.status !== "completed") {
      throw fail(polled.status === "failed" ? 502 : 409, `video ${route.id} is ${polled.status}`)
    }
    const downloadUrl = await resolveVideoDownloadUrl(spec, polled, { cloudGet, signal })
    if (!downloadUrl || !/^https:\/\//i.test(downloadUrl)) {
      throw fail(502, "MiniMax Design video completed without download URL")
    }
    const dlRes = await fetchHttpsExternal(externalFetch, downloadUrl, { signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, label: "video download" })
    const outHeaders = new Headers(dlRes.headers)
    outHeaders.delete("content-encoding")
    outHeaders.delete("content-length")
    if (!outHeaders.get("content-type")) outHeaders.set("content-type", "video/mp4")
    outHeaders.set("X-Magpie-Sign-In", lastSignIn)
    return new Response(dlRes.body, { status: 200, headers: outHeaders })
  } catch (error) {
    if (signal?.aborted) throw error
    if (error?.rawResponse) {
      const outHeaders = new Headers(error.headers ?? undefined)
      outHeaders.set("X-Magpie-Sign-In", error.signIn ?? "kept")
      if (!outHeaders.get("content-type")) outHeaders.set("content-type", "application/json")
      return new Response(error.message, { status: error.status ?? 502, headers: outHeaders })
    }
    const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 502
    const type = status === 401 ? "authentication_error" : status < 500 ? "invalid_request_error" : "upstream_error"
    return jsonResp({ error: { message: String(error?.message ?? error), type } }, status, error?.signIn ?? "kept")
  }
}

export const _mediaInternal = {
  IMAGE_MODEL_ALIASES,
  VIDEO_MODEL_ALIASES,
  AUDIO_MODEL_ALIASES,
  BOOTSTRAP_MEDIA,
  IMAGE_PATHS,
  GPT_IMAGE_2_SIZE_MAP,
  AUDIO_MIMES,
  MAX_UPLOAD_BYTES,
  parseModelsConfig,
  bootstrapMediaSpecs,
  normalizeMediaEntry,
  normalizeMediaDisplayName,
  mediaPath,
  encodeVideoId,
  decodeVideoId,
  mediaRef,
  ratioFromSize,
  nearestRatio,
  tierFromSizeOrQuality,
  pickVideoResolution,
  pickDuration,
  sniffAudioMime,
  formatSubtitles,
}
