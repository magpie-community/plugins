// The inner address is a single AppLink query value. Keep sign-in material out of it.
function buildFeishuLink(address) {
  const text = address.trim()
  if (!/^https?:\/\/[^/]/i.test(text) || /\s|\\/.test(text)) return { error: "invalid" }

  let url
  try {
    url = new URL(text)
  } catch {
    return { error: "invalid" }
  }
  if (url.username || url.password || /[?#]/.test(text)) return { error: "plainAddress" }

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol === "http:" && !loopback) return { error: "https" }

  return {
    link: "https://applink.feishu.cn/client/web_url/open?mode=appCenter&url=" + encodeURIComponent(url.href),
  }
}
