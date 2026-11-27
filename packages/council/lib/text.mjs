// The words around the models' answers, in the asker's language: Chinese when
// what was asked has Chinese in it, English otherwise.

export const langOf = (...texts) => (texts.some((t) => /[㐀-鿿]/.test(String(t || ""))) ? "zh" : "en")

const REASON = {
  zh: { account: "未登录或 key 失效", quota: "额度用完", unreachable: "连不上", timeout: "超时", slow: "太慢", model: "模型不可用", other: "出错", empty: "没给出内容", toolong: "内容太长", refused: "被内容审核拒绝", busy: "厂商繁忙", plan: "套餐不含这个模型" },
  en: { account: "signed out or key invalid", quota: "out of allowance", unreachable: "unreachable", timeout: "timed out", slow: "too slow", model: "model unavailable", other: "failed", empty: "gave no answer", toolong: "input too long", refused: "refused by a content filter", busy: "vendor busy", plan: "not in the plan" },
}

// how to put each failure right, with the command a vendor's own message names
const FIX = {
  zh: {
    account: "在 magpie 的「供应商」页重新登录它，或换一个有效的 key",
    quota: "等额度恢复，或在 magpie 里给它加一个账号或额度",
    unreachable: "把这个服务打开（本地模型要先启动对应的软件），或检查网络和代理",
    timeout: "在 magpie 的「供应商」页点「测试」；账号卡住时重新登录通常就好",
    busy: "厂商暂时繁忙，几分钟后会自动再试",
    plan: "你的套餐不含这个模型：升级套餐或购买额度后就能用，不处理也行，council 会自动跳过它",
    model: "这个模型在账号里用不了，可以在 magpie 里把它隐藏",
    other: "在 magpie 的「供应商」页点「测试」看具体原因",
  },
  en: {
    account: "sign in to it again on magpie's Providers page, or give it a working key",
    quota: "wait for the allowance to come back, or add an account or credit to it in magpie",
    unreachable: "start the service (a local model's app first), or check the network and proxy",
    timeout: "press Test on magpie's Providers page; signing in again usually helps an account that hangs",
    busy: "the vendor is busy; council tries again in a few minutes",
    plan: "your plan doesn't include this model: upgrade or add credits to use it, or leave it, council skips it by itself",
    model: "the account can't use this model; hide it in magpie",
    other: "press Test on magpie's Providers page to see why",
  },
}
// a command in backticks, or a slash command on its own (not a URL's path)
const commandIn = (why) => String(why || "").match(/`([^`]{2,60})`|(?:^|\s)(\/[a-z][a-z-]{2,30})(?=[\s.,;:)]|$)/)?.slice(1).find(Boolean)
const RETIRED = /no longer supported|deprecated|discontinued|migrate to|已停用|停止服务/i
const RETIRED_FIX = {
  zh: "厂商已经停用了这种登录方式：在 magpie 里删掉这个供应商，或按厂商的说明换成新的登录方式",
  en: "the vendor has retired this way of signing in: remove the provider in magpie, or switch to the vendor's new sign-in",
}
export const fixFor = (lang, kind, why) => {
  if (RETIRED.test(String(why || ""))) return RETIRED_FIX[lang] || RETIRED_FIX.en
  const f = (FIX[lang] || FIX.en)[kind] || (FIX[lang] || FIX.en).other
  const c = commandIn(why)
  return c ? `${f}${lang === "zh" ? "（它自己提示：" : " (it says: "}\`${c}\`${lang === "zh" ? "）" : ")"}` : f
}

const zh = {
  reason: (k) => REASON.zh[k] || REASON.zh.other,
  secs: (ms) => `${(ms / 1000).toFixed(1)} 秒`,
  effort: (l) => (l ? ` · 推理 ${l}` : ""),
  answered: (n) => `${n} 个模型回答了。`,
  noneAnswered: "这次没有模型答上来。",
  thinking: (names, id) => `还在想：${names.join("、")}。稍后用 council_result 取剩下的（id: ${id}）。`,
  missed: (list) => `没答上：${list.join("；")}。`,
  skipped: (n) => `另有 ${n} 家暂时用不了，已自动跳过；council_models 会写明原因和修法。`,
  searching: (id) => `正在联网搜索……稍后用 council_result 取结果（id: ${id}）。`,
  webFailed: (why) => `联网搜索没成功（${why}），模型只按自己的知识回答。要用联网搜索，先在 magpie 的「设置 → 联网搜索」里选好搜索方式。`,
  webBlock: "联网搜索结果（可能不全，请自行判断）：",
  contextBlock: "背景材料：",
  noModels: "现在没有能用的模型。下面这些修好任意一个就能用：",
  noCatalog: "magpie 里还没有模型：先在 magpie 里添加一个供应商（订阅、API key 或供应商插件都行）。",
  tooLong: (n) => `内容太长（约 ${n} 个 token），超过了所有能用的模型的上下文。请缩短，或只给关键部分。`,
  fixLine: (p, reason, fix) => `- ${p}：${reason} → ${fix}`,
  noVisionModels: "magpie 里没有能看图且现在能用的模型。去掉图片再问，或在 magpie 里加一个能看图的模型。",
  imageModel: (id) => `${id} 是出图模型，出图请用 magpie 自带的 generate_image。`,
  notChat: (id) => `${id} 不是对话模型，已跳过。`,
  noVision: (id) => `${id} 看不了图，已跳过。`,
  held: (id, k) => `${id} 现在不能用（${REASON.zh[k] || REASON.zh.other}），已跳过。`,
  providerDown: (p) => `${p} 现在没有能用的模型，已跳过。`,
  unknown: (t) => `magpie 里没有「${t}」，已跳过。`,
  fallback: () => "点名的模型都不能用，已改为自动挑选。",
  emptyGroup: (n) => `路由组「${n}」里还没有模型。`,
  pdf: (n) => `${n} 是 PDF：请先把其中的文字放进 context 再问。`,
  notImage: (n) => `${n} 不是图片（支持 PNG、JPEG、GIF、WebP），已跳过。`,
  tooBig: (n) => `图片加起来超过 20 MB，${n} 及之后的没有带上。`,
  tooMany: (n) => `最多带 ${n} 张图，多的没有带上。`,
  unreadable: (n, why) => `读不到 ${n}（${why}），已跳过。`,
  vote1: "这是一次匿名投票的第一步：请你独立给出一个方案，别人看不到你的，你也看不到别人的。直接写方案本身，简明具体，不要写你是谁。",
  vote2: (n) => `这是一次匿名投票的第二步。下面是 ${n} 个方案，作者名字都去掉了，顺序是打乱的。请只按内容好坏，投给你认为最好的一个方案。只回一行 JSON，不要别的：{"vote": "<字母>", "reason": "<一句话理由>"}`,
  question: "问题：",
  proposal: (l) => `方案 ${l}`,
  voteShort: (n) => `投票没开成：只有 ${n} 个方案。`,
  onlyOne: (m) => `唯一的方案（${m}）：`,
  winner: (l, n, m) => `胜出：方案 ${l}（${n} 票，作者 ${m}）。`,
  tie: (ls, n) => `平票：${ls.map((l) => `方案 ${l}`).join("、")} 各 ${n} 票。`,
  noVotes: "没有有效票。",
  tally: "得票：",
  votes: (n, m) => `${n} 票，作者 ${m}`,
  ballots: "谁投了谁：",
  noBallot: (why) => `没投（${why}）`,
  spoilt: (s) => `废票（${s}）`,
  allProposals: "全部方案",
  votingNow: (n, of, id) => `第一轮：${of} 个模型里 ${n} 个已出方案，正在等其余的、然后投票。稍后用 council_result 取结果（id: ${id}）。`,
  ballotingNow: (n, of, id) => `第二轮：${of} 票里收到 ${n} 票。稍后用 council_result 取结果（id: ${id}）。`,
  reviewSystem:
    "你是严格的复核员。只找真实存在的问题：错误、遗漏、和目标不符、会出事的边界情况。每个问题写：严重程度（高/中/低）、在哪里、为什么错、怎么改。不要重写整段，不要客套。没发现问题就只回「没发现问题」。",
  goal: "目标：",
  toReview: "要复核的内容：",
  reviewBy: (name) => `复核（${name}）`,
  gone: "没有这个任务：可能已经过了一小时，或 magpie 重启过插件。重新问一次就行。",
}

const en = {
  reason: (k) => REASON.en[k] || REASON.en.other,
  secs: (ms) => `${(ms / 1000).toFixed(1)}s`,
  effort: (l) => (l ? ` · reasoning ${l}` : ""),
  answered: (n) => `${n} model${n === 1 ? "" : "s"} answered.`,
  noneAnswered: "No model answered this time.",
  thinking: (names, id) => `Still thinking: ${names.join(", ")}. Get the rest later with council_result (id: ${id}).`,
  missed: (list) => `Didn't answer: ${list.join("; ")}.`,
  skipped: (n) => `${n} more provider${n === 1 ? " is" : "s are"} unavailable right now and were skipped; council_models says why and how to fix it.`,
  searching: (id) => `Searching the web… Get the result later with council_result (id: ${id}).`,
  webFailed: (why) => `Web search didn't work (${why}); the models answer from what they know. To use it, pick a search in magpie's Settings › Web search.`,
  webBlock: "Web search results (may be incomplete; judge for yourself):",
  contextBlock: "Background:",
  noModels: "No model can be used right now. Fixing any one of these is enough:",
  noCatalog: "magpie has no models yet: add a provider in magpie first (a subscription, an API key or a provider plugin).",
  tooLong: (n) => `The input is too long (about ${n} tokens) for every model that can be used. Shorten it, or give only the parts that matter.`,
  fixLine: (p, reason, fix) => `- ${p}: ${reason} → ${fix}`,
  noVisionModels: "No model in magpie that sees images can be used right now. Ask without the images, or add a model that sees images to magpie.",
  imageModel: (id) => `${id} makes images; use magpie's own generate_image for that.`,
  notChat: (id) => `${id} isn't a chat model; skipped.`,
  noVision: (id) => `${id} can't see images; skipped.`,
  held: (id, k) => `${id} can't be used right now (${REASON.en[k] || REASON.en.other}); skipped.`,
  providerDown: (p) => `${p} has no model that can be used right now; skipped.`,
  unknown: (t) => `magpie has no "${t}"; skipped.`,
  fallback: () => "None of the models named can be used; picked automatically instead.",
  emptyGroup: (n) => `The routing group "${n}" has no models yet.`,
  pdf: (n) => `${n} is a PDF: put its text in context and ask again.`,
  notImage: (n) => `${n} isn't an image (PNG, JPEG, GIF and WebP are); skipped.`,
  tooBig: (n) => `The images come to more than 20 MB; ${n} and those after it were left out.`,
  tooMany: (n) => `At most ${n} images; the rest were left out.`,
  unreadable: (n, why) => `Couldn't read ${n} (${why}); skipped.`,
  vote1: "This is the first step of an anonymous vote: give one proposal of your own. Nobody sees yours and you see nobody else's. Write the proposal itself, concrete and to the point, and don't say who you are.",
  vote2: (n) => `This is the second step of an anonymous vote. Below are ${n} proposals, their authors taken out and their order shuffled. Vote for the one you think is best, on its merits alone. Reply with one line of JSON and nothing else: {"vote": "<letter>", "reason": "<one sentence>"}`,
  question: "Question:",
  proposal: (l) => `Proposal ${l}`,
  voteShort: (n) => `The vote couldn't be held: only ${n} proposal${n === 1 ? "" : "s"}.`,
  onlyOne: (m) => `The one proposal (${m}):`,
  winner: (l, n, m) => `Winner: proposal ${l} (${n} vote${n === 1 ? "" : "s"}, by ${m}).`,
  tie: (ls, n) => `Tie: proposals ${ls.join(", ")} with ${n} vote${n === 1 ? "" : "s"} each.`,
  noVotes: "No valid votes.",
  tally: "Votes:",
  votes: (n, m) => `${n} vote${n === 1 ? "" : "s"}, by ${m}`,
  ballots: "Who voted for what:",
  noBallot: (why) => `didn't vote (${why})`,
  spoilt: (s) => `spoilt ballot (${s})`,
  allProposals: "All proposals",
  votingNow: (n, of, id) => `Round one: ${n} of ${of} models have written a proposal; waiting for the rest, then the vote. Get the result later with council_result (id: ${id}).`,
  ballotingNow: (n, of, id) => `Round two: ${n} of ${of} votes in. Get the result later with council_result (id: ${id}).`,
  reviewSystem:
    "You are a strict reviewer. Find only real problems: mistakes, omissions, mismatches with the goal, edge cases that will break. For each: severity (high/medium/low), where, why it is wrong, how to fix it. Don't rewrite the whole thing, no pleasantries. If you find nothing, reply only \"No problems found\".",
  goal: "Goal:",
  toReview: "To review:",
  reviewBy: (name) => `Review (${name})`,
  gone: "No such task: it may be over an hour old, or magpie restarted its plugins. Just ask again.",
}

export const words = (lang) => (lang === "zh" ? zh : en)
