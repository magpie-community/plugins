// Default-agent instructions and hooks were verified on agy 1.5.19.
export const MIN_AGY_VERSION = "1.5.19"

export function agyTooOld(version) {
  const parse = value => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim())?.slice(1).map(Number)
  const have = parse(version)
  // An ACP peer can omit its version. Keep the existing handshake behavior.
  if (!have) return null
  const need = parse(MIN_AGY_VERSION)
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return null
    if (have[i] < need[i]) return `agy ${version} is older than ${MIN_AGY_VERSION}, the oldest version this plugin was checked on. Update agy.`
  }
  return null
}
