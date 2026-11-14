// Return only bounded categories: upstream messages can contain credentials,
// account identifiers and request content, so never retain or publish them.
export function errorReason(status, type = "", message = "") {
  const text = `${type} ${message}`.slice(0, 8192).toLowerCase()
  if (/reply_loop|reasoning loop|ended this reply/.test(text)) return "replyLoop"
  if (/empty reply|answered nothing|no content/.test(text)) return "emptyReply"
  // A cut connection is a mid-reply failure only when the reply had already
  // started; before that it is a connection failure.
  if (status >= 200 && status < 400 && /connection lost|unexpected eof|econnreset|econnrefused|socket|stream .*(cut|closed|ended)|cut short/.test(text)) return "stream"
  if (/context[_ ]length|context window|too many tokens|maximum.*tokens/.test(text)) return "context"
  if (/insufficient[_ ]quota|quota.*exceed|credit|balance|billing/.test(text) || status === 402) return "quota"
  if (status === 429 || /rate[_ -]?limit|too many requests/.test(text)) return "rateLimit"
  if (status === 401 || status === 403 || /authentication|permission|invalid.*api.?key/.test(text)) return "auth"
  if (/model.*(not found|not supported|unavailable)|unsupported.*model/.test(text)) return "model"
  if (status === 408 || status === 504 || /timeout|timed out/.test(text)) return "timeout"
  if (status >= 500 || /internal server error/.test(text)) return "server"
  if (status === 400 || status === 404 || status === 422 || /invalid_request|invalid.argument/.test(text)) return "request"
  if (status === 0 && /connect|socket|network|dns|econn|fetch failed/.test(text)) return "network"
  return "unknown"
}
