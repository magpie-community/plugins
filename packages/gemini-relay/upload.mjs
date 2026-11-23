// File upload, inside the page: the app's storage endpoint
// (content-push.googleapis.com/upload) takes a multipart POST with the
// tenant header bard-storage and answers a /contrib_service/... file
// reference that the chat request carries in inner[0][3]. Everything
// runs in the page — its cookies, its TLS — like the chat transports.
//
// The push id ("qKIAYe" in the page's boot config) names the upload
// session; the measured default is the feeds one. Uploads are
// best-effort: a failure is reported to the caller, which degrades to a
// text placeholder rather than failing the whole turn.

export const UPLOAD_ENDPOINT = "https://content-push.googleapis.com/upload"
export const DEFAULT_PUSH_ID = "feeds/mcudyrk2a4khkz"

// pushIdFromPage reads the page's own upload-session id ("qKIAYe").
// Runs in the page context.
const PAGE_PUSH_ID = `(() => {
  const html = document.documentElement.innerHTML
  const i = html.indexOf(String.fromCharCode(34) + "qKIAYe" + String.fromCharCode(34))
  if (i < 0) return ""
  const m = html.slice(i).match(/"([^"]{4,120})"/g)
  return (m && m[1] ? m[1] : "").replace(/"/g, "")
})()`

// uploadFile sends one file from inside the page and answers the
// response text (the /contrib_service/ttl_1d/... reference). `page` is a
// RelayPage; data is a Buffer/Uint8Array of the file's bytes.
export async function uploadFile(page, { data, filename, mime, pushId } = {}) {
  if (!data) throw new Error("uploadFile: no data")
  const name = filename || "upload.bin"
  const type = mime || "application/octet-stream"
  const pid = pushId || (await page.eval(PAGE_PUSH_ID).catch(() => "")) || DEFAULT_PUSH_ID
  // the multipart body is built in the page: a page fetch with FormData
  // carries the browser's own cookies and boundary handling
  const expr = `(async (b64, name, mime, pid) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const fd = new FormData()
    fd.append("file", new Blob([bytes], { type: mime }), name)
    const r = await fetch(${JSON.stringify(UPLOAD_ENDPOINT)}, {
      method: "POST",
      headers: { "X-Tenant-Id": "bard-storage", "Push-ID": pid },
      body: fd,
      credentials: "include",
    })
    return { status: r.status, text: await r.text() }
  })(${JSON.stringify(Buffer.from(data).toString("base64"))}, ${JSON.stringify(name)}, ${JSON.stringify(type)}, ${JSON.stringify(pid)})`
  const r = await page.eval(expr)
  if (!r || r.status !== 200 || !r.text) throw new Error(`上传失败：HTTP ${r?.status ?? "?"}`)
  return r.text
}
