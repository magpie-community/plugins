export function safeEndpoint(value) {
  if (typeof value !== "string" || !value || value.length > 500) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return url.href.replace(/\/+$/, "");
  } catch { return ""; }
}
export function readInheritedMetadata() {
  return {owner:'search-center',found:false,channels:{},model:'',raceModels:[]};
}
