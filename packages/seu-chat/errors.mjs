// 各层共用的错误类。放在单独的文件里，让 sse.mjs 也能抛它而不与
// seu.mjs 形成循环 import（seu.mjs 已经 import sse.mjs）。
export class SeuError extends Error {
  constructor(message, { code = "seu_error", status = 502, signIn = false, retryAfter } = {}) {
    super(message)
    this.name = "SeuError"
    this.code = code
    this.status = status
    this.signIn = signIn
    this.retryAfter = retryAfter
  }
}
