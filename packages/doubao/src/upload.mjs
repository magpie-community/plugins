// 图生图的参考图上传（两步流，移植自 doubao2api 抓包真值）：
//   1. POST /samantha/pages/upload_image (multipart) -> data.uri
//   2. POST /alice/message/get_file_url              -> file_urls[0] {uri, main_url}
// 安全：参考图只接受真实图片（扩展名 + 魔数 + 大小上限），URL 仅限公网 http(s)，
// 防止 Agent 被提示词注入后读取任意本地文件外传或探测内网。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BASE_URL, baseHeaders, DoubaoError, fetchPublic } from "./http.mjs";
import { securityParams } from "./client.mjs";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const MAX_REF_BYTES = 20 * 1024 * 1024;

/** 按魔数确认是图片（png/jpg/webp/gif）。 */
function assertImageMagic(buf) {
  if (buf.length > 8) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  }
  throw new DoubaoError("参考图不是可识别的图片（png/jpg/webp/gif）");
}

/** 读取参考图：本地路径或公网 http(s) URL 都支持，校验通过后返回字节与文件名。 */
export async function loadRefImage(source) {
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetchPublic(String(source), { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new DoubaoError(`参考图下载失败 (${resp.status}): ${source}`);
    const len = Number(resp.headers.get("content-length") || 0);
    if (len > MAX_REF_BYTES) throw new DoubaoError(`参考图过大（>20MB）：${source}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_REF_BYTES) throw new DoubaoError(`参考图过大（>20MB）：${source}`);
    assertImageMagic(buf);
    let name = "";
    try {
      name = decodeURIComponent(new URL(source).pathname.split("/").pop() || "");
    } catch {
      /* ignore */
    }
    return { bytes: buf, name: name || "reference.png" };
  }
  const ext = (source.includes(".") ? source.split(".").pop() : "").toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new DoubaoError(`参考图仅支持图片文件（png/jpg/jpeg/webp/gif），拒绝: …${String(source).slice(-60)}`);
  }
  const bytes = await readFile(source); // 不存在会抛 ENOENT
  if (bytes.length > MAX_REF_BYTES) throw new DoubaoError(`参考图过大（>20MB）`);
  assertImageMagic(bytes);
  return { bytes, name: path.basename(source) };
}

/** 上传一张参考图，返回 samantha attachments 需要的 key（uri）等信息。 */
export async function uploadRefImage(cfg, account, source) {
  const { bytes, name } = await loadRefImage(source);
  const ext = (name.includes(".") ? name.split(".").pop() : "png").toLowerCase();
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

  // 第一步：上传
  const uploadUrl = `${BASE_URL}/samantha/pages/upload_image?${new URLSearchParams(securityParams("pc", account))}`;
  const form = new FormData();
  form.append("data", new Blob([bytes], { type: mime }), name);
  form.append("file_type", ext);
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: baseHeaders(account), // 不手动设 Content-Type，fetch 自动补 multipart boundary
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const uploadBody = await uploadResp.json().catch(() => null);
  if (!uploadResp.ok || !uploadBody || uploadBody.code !== 0) {
    throw new DoubaoError(
      `参考图上传失败 (${uploadResp.status}): ${JSON.stringify(uploadBody).slice(0, 300)}`,
    );
  }
  const uriShort = uploadBody.data.uri;

  // 第二步：换 CDN 链接 + 完整 uri
  const fileUrlEndpoint = `${BASE_URL}/alice/message/get_file_url?${new URLSearchParams(securityParams("pc", account))}`;
  const fileResp = await fetch(fileUrlEndpoint, {
    method: "POST",
    headers: baseHeaders(account, { "Content-Type": "application/json" }),
    body: JSON.stringify({ uris: [uriShort], type: "image", format: ext, expire_second: 3600 }),
    signal: AbortSignal.timeout(60_000),
  });
  const fileBody = await fileResp.json().catch(() => null);
  const fileInfo = fileBody?.data?.file_urls?.[0];
  if (!fileResp.ok || !fileBody || fileBody.code !== 0 || !fileInfo) {
    throw new DoubaoError(
      `参考图换取 CDN 链接失败: ${JSON.stringify(fileBody).slice(0, 300)}`,
    );
  }
  return {
    uri: fileInfo.uri,
    cdnUrl: fileInfo.main_url,
    name,
    format: ext,
  };
}

/** 批量上传参考图（同名失败会带上下文抛出）。 */
export async function uploadRefImages(cfg, account, sources) {
  const uploaded = [];
  for (const source of sources || []) {
    uploaded.push(await uploadRefImage(cfg, account, String(source)));
  }
  return uploaded;
}
