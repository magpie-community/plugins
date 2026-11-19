// The message 豆包 gets for an image request: one description, and the
// rules that make Doubao draw instead of answer in text.
//
// An image request has no conversation in it, so nothing of a chat is
// written here — no system prompt, no history, no tools.

// SIZES are the sizes OpenAI's image API names, written the way a prompt
// can ask for them. A size it doesn't name is turned into a ratio.
const SIZES = {
  "1024x1024": "1:1 方图",
  "1024x1792": "9:16 竖版",
  "1792x1024": "16:9 横版",
  "1024x1536": "2:3 竖版",
  "1536x1024": "3:2 横版",
  "1152x2048": "9:16 竖版",
  "2048x1152": "16:9 横版",
}

// RATIO_KEYS are the sizes 对话's 比例 menu names, and the request sizes
// that mean them.
const RATIO_KEYS = { "1024x1024": "1:1", "1024x1792": "9:16", "1792x1024": "16:9", "1024x1536": "2:3", "1536x1024": "3:2", "1152x2048": "9:16", "2048x1152": "16:9" }

// ratioKey is a request's size as the 比例 menu names it ("9:16"), or ""
// for its 自动.
export function ratioKey(size) {
  const s = String(size ?? "").trim().toLowerCase()
  if (!s || s === "auto") return ""
  if (/^\d+\s*:\s*\d+$/.test(s)) return s.replace(/\s+/g, "")
  if (RATIO_KEYS[s]) return RATIO_KEYS[s]
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(s)
  if (!m) return ""
  let a = Number(m[1])
  let b = Number(m[2])
  if (!a || !b) return ""
  const d = gcd(a, b) || 1
  return `${a / d}:${b / d}`
}

// directPrompt is what 对话's 图像生成 asks for: the description itself.
// The skill already draws, so the drawing rules would only be noise.
export function directPrompt(list, style = "", ratio = "") {
  const items = list.map((x) => String(x ?? "").trim()).filter(Boolean)
  const body = items.length <= 1 ? items[0] ?? "" : items.map((x, i) => `${i + 1}. ${x}`).join("\n")
  const head = items.length <= 1 ? "" : `请分别画 ${items.length} 张图：\n`
  const ratioLine = ratio ? `画幅：${ratio}\n` : ""
  return ratioLine + head + body + (style ? "\n\n风格：\n" + style : "")
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a)

// ratioOf turns a request's size into a phrase the prompt can carry: the
// API's own names first, then the size's ratio.
export function ratioOf(size) {
  const s = String(size ?? "").trim().toLowerCase()
  if (!s || s === "auto") return ""
  if (SIZES[s]) return SIZES[s]
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(s)
  if (!m) return /^\d+\s*:\s*\d+$/.test(s) ? s.replace(/\s+/g, "") + " 画幅" : ""
  let a = Number(m[1])
  let b = Number(m[2])
  if (!a || !b) return ""
  const d = gcd(a, b) || 1
  a /= d
  b /= d
  const where = a > b ? "横版" : a < b ? "竖版" : "方图"
  return `${a}:${b} ${where}`
}

// PROMPT is the whole message 豆包 gets. It asks for a picture and says
// what to put in the prompt; it never asks for text back.
const PROMPT = (description, ratio) => `这是一次文生图任务。

请按下面要求画图：
1. 调用文生图工具生成图片。不要用文字、符号或 ASCII 画图，也不要只描述画面而不出图。
2. 把描述扩写成一条画面提示词，写清：主体、场景细节、风格、光线、色彩、构图、镜头、画质。
3. 画幅：${ratio ? `用户指定 ${ratio}，按这个比例出图。` : "用户没指定比例，用 3:2 横版。"}
4. 只画一张图。不要解释步骤，不要输出提示词全文。

用户的描述：
${description}`

// imagePrompt builds that message. style is extra wording a caller can add
// with the request's doubao_style field.
export function imagePrompt(description, ratio = "", style = "") {
  const text = String(description ?? "").trim() || "一幅画面精致的图片"
  return PROMPT(text, ratio) + (style ? "\n\n补充风格要求：\n" + style : "")
}

// MANY asks for several pictures in that one message, one tool call each,
// so Doubao draws them in the same task instead of one request per picture.
const MANY = (list, ratio) => `这是一次文生图任务，请一次画 ${list.length} 张图。

要求：
1. 每张图单独调用一次文生图工具。不要用文字、符号或 ASCII 画图，也不要只描述画面而不出图。
2. 每张都扩写成完整的画面提示词，写清：主体、场景细节、风格、光线、色彩、构图、镜头、画质。
3. 画幅：${ratio ? `用户指定 ${ratio}，每张都按这个比例。` : "用户没指定比例，每张都用 3:2 横版。"}
4. 不要解释步骤，不要输出提示词全文。

要画的图：
${list.map((x, i) => `${i + 1}. ${x}`).join("\n")}`

// imagePromptMany is that message for several descriptions.
export function imagePromptMany(list, ratio = "", style = "") {
  const items = list.map((x) => String(x ?? "").trim()).filter(Boolean)
  if (items.length <= 1) return imagePrompt(items[0], ratio, style)
  return MANY(items, ratio) + (style ? "\n\n补充风格要求：\n" + style : "")
}
