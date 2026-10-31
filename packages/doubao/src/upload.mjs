// 图生图的参考图上传（两步流，移植自 doubao2api 抓包真值）：
//   1. POST /samantha/pages/upload_image (multipart) -> data.uri
//   2. POST /alice/message/get_file_url              -> file_urls[0] {uri, main_url}
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BASE_URL, baseHeaders, DoubaoError } from "./http.mjs";
import { securityParams } from "./client.mjs";

/** 读取参考图：本地路径或 http(s) URL 都支持。 */
export async function loadRefImage(source) {
  if (/^https?:\/\//i.test(source)) {
    const resp = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new DoubaoError(`参考图下载失败 (${resp.status}): ${source}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    let name = "";
    try {
      name = decodeURIComponent(new URL(source).pathname.split("/").pop() || "");
    } catch {
      /* ignore */
    }
    return { bytes: buf, name: name || "reference.png" };
  }
  const bytes = await readFile(source);
  return { bytes, name: path.basename(source) };
}

/** 上传一张参考图，返回 samantha attachments 需要的 key（uri）等信息。 */
export async function uploadRefImage(cfg, account, source) {
  const { bytes, name } = await loadRefImage(source);
  const ext = (name.includes(".") ? name.split(".").pop() : "png").toLowerCase();
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

  // 第一步：上传
  const uploadUrl = `${BASE_URL}/samantha/pages/upload_image?${new URLSearchParams(securityParams("pc"))}`;
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
  const fileUrlEndpoint = `${BASE_URL}/alice/message/get_file_url?${new URLSearchParams(securityParams("pc"))}`;
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
