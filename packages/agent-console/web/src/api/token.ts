// The daemon token lives in the fragment so it is not sent in the HTTP Referer.
export function getToken(): string {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  return new URLSearchParams(fragment).get("t") ?? "";
}
