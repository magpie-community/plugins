// 每个测试文件最先 import 它：测试跑不到真网络。fetch 只放行本机（127.0.0.1/
// localhost/[::1]），其余一律抛错——哪个测试忘了装 fake，请求就发不出去，
// 凭证（Basic 票、llm key、vip Cookie）不可能漏到 yun.139.com / mcloud.139.com。
const local = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$|\?)/.test(u)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!local(u)) throw new Error('a test asked ' + u + ' with no fake in place')
  return realFetch(input, init)
}
