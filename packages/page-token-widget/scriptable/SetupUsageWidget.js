// SetupUsageWidget · @magpie-community/page-token-widget · MIT
// Paste this entire script into Scriptable, then run it once.
// The plugin rewrites the port below when it hands out this file.
const SETTINGS_KEY = "ameaq-rmrcxu-b2";
const DEFAULT_PORT = 3498;
let saved = {};
try { saved = JSON.parse(Keychain.get(SETTINGS_KEY)) || {}; } catch {}
const alert = new Alert();
alert.title = "连接你的用量";
alert.message = "确保 iPhone 能访问你填写的服务地址。该地址可以是 Tailscale 地址，也可以是你自己配好的可信内网地址，或你自己的 HTTPS 域名。输入 PC 上生成的服务地址与只读令牌。无需填写模型 API Key。";
alert.addTextField("http://你的 Tailscale IP:" + DEFAULT_PORT, typeof saved.baseURL === "string" ? saved.baseURL : "");
alert.addSecureTextField("只读访问令牌", typeof saved.token === "string" ? saved.token : "");
alert.addAction("验证并安装"); alert.addCancelAction("取消");
if (await alert.presentAlert() !== -1) {
  const baseURL = alert.textFieldValue(0).trim().replace(/\/+$/, "");
  const token = alert.textFieldValue(1).trim();
  try {
    // The same rules as the service itself (lib/network.mjs): HTTPS may be
    // any name, plain HTTP only a name or an address of a network that is
    // trusted. The service refuses the same addresses, so the phone and the
    // service never disagree about what may be used.
    const PLAIN_TEXT_REFUSAL = "公网的明文 HTTP 地址不接受：令牌会在路上被看见。请用 HTTPS，或者换成内网地址（Tailscale、RFC1918、ULA）。";
    const isTrustedHost = (name) => {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) {
        const p = name.split(".").map(Number);
        if (p.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return false;
        if (p[0] === 127) return true;
        if (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return true;
        if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
        if (p[0] === 169 && p[1] === 254) return true;
        return false;
      }
      if (name.includes(":")) {
        if (name === "::1") return true;
        if (/^f[cd][0-9a-f]{2}:/.test(name)) return true;
        if (/^fe[89ab][0-9a-f]:/.test(name)) return true;
        return false;
      }
      const bare = name.replace(/\.$/, "");
      if (!bare.includes(".")) return true;
      return [".localhost", ".local", ".lan", ".home.arpa", ".internal", ".ts.net"].some(s => bare.endsWith(s));
    };
    const checkServiceAddress = (value) => {
      const text = String(value || "").trim();
      if (!text) return { ok: true, empty: true };
      if (text.includes("?") || text.includes("#")) return { ok: false, error: "地址里不能带问号后面的参数。" };
      const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(text);
      if (!match) return { ok: false, error: "请输入完整的服务地址，例如 https://example.com 或 http://192.168.1.50:3499。" };
      const scheme = match[1].toLowerCase();
      const authority = match[2];
      if (authority.includes("@")) return { ok: false, error: "地址里不能带用户名或密码。" };
      const path = match[3] || "";
      if (path && path !== "/") return { ok: false, error: "这个版本不支持带路径的地址。反向代理请用一个独立域名，把它的根路径转到插件服务。" };
      let host = authority, portText = "";
      if (authority.startsWith("[")) {
        const end = authority.indexOf("]");
        if (end < 0) return { ok: false, error: "IPv6 的地址要写成 [::1] 这样的方括号。" };
        host = authority.slice(1, end);
        const tail = authority.slice(end + 1);
        if (tail && !tail.startsWith(":")) return { ok: false, error: "端口不对。" };
        portText = tail.slice(1);
      } else {
        const colon = authority.lastIndexOf(":");
        if (colon >= 0) { host = authority.slice(0, colon); portText = authority.slice(colon + 1); }
      }
      if (!host) return { ok: false, error: "地址里没有主机名。" };
      if (portText) {
        if (!/^\d+$/.test(portText)) return { ok: false, error: "端口不对。" };
        const port = Number(portText);
        if (port < 1 || port > 65535) return { ok: false, error: "端口不对。" };
      }
      const name = host.toLowerCase();
      if (scheme === "http" && !isTrustedHost(name)) return { ok: false, error: PLAIN_TEXT_REFUSAL };
      return { ok: true, secure: scheme === "https" };
    };
    const checked = checkServiceAddress(baseURL);
    if (!checked.ok) throw new Error(checked.error);
    if (checked.empty) throw new Error("请填写服务地址。");
    if (token.length < 32) throw new Error("令牌不完整，请复制 PC 上生成的完整只读令牌。");
    const probe = new Request(baseURL + "/api/v1/overview");
    probe.headers = { Authorization: "Bearer " + token }; probe.timeoutInterval = 12;
    // The service says 401 with a body; loadJSON() throws on it first, so the
    // status is read out of the request (the documented place) or out of the
    // message. Otherwise a wrong token showed a raw Scriptable error.
    let data = null;
    try {
      data = await probe.loadJSON();
    } catch (error) {
      const said = /status\s*(\d{3})/i.exec(String((error && error.message) || ""));
      const status = (probe.response && Number(probe.response.statusCode)) || (said ? Number(said[1]) : 0);
      if (status === 401) throw new Error("只读令牌无效。");
      throw new Error("连不上这个服务：" + (error && error.message ? error.message : "没有回答"));
    }
    if (probe.response && probe.response.statusCode === 401) throw new Error("只读令牌无效。");
    if (!data || data.schemaVersion !== 1) throw new Error("未识别到兼容服务，请检查地址与令牌。");
    const download = new Request(baseURL + "/scriptable/UsageWidget.js");
    download.headers = { Authorization: "Bearer " + token };
    download.timeoutInterval = 12;
    const source = await download.loadString();
    if (!source.startsWith("// UsageWidget ·") || !source.includes("Script.setWidget") || source.length > 100000) throw new Error("组件下载校验失败。");
    let fm;
    try { fm = FileManager.iCloud(); fm.documentsDirectory(); }
    catch { fm = FileManager.local(); }
    const target = fm.joinPath(fm.documentsDirectory(), "UsageWidget.js");
    if (fm.fileExists(target)) {
      if (fm.isFileStoredIniCloud(target)) await fm.downloadFileFromiCloud(target);
      if (!fm.readString(target).startsWith("// UsageWidget ·")) throw new Error("已有同名脚本，请先重命名原脚本再安装。");
    }
    fm.writeString(target, source);
    Keychain.set(SETTINGS_KEY, JSON.stringify({ baseURL, token }));
    const done = new Alert();
    done.title = "已连接";
    done.message = "UsageWidget 已安装。长按桌面添加 Scriptable 中号或大号小组件，选择 UsageWidget。每页最多六个订阅，布局随数量自动调整。\n\n中号和大号参数留空即可；page=2 查看第二页，used 改显已用，可组合 page=2|used。小号填 codex、minimax 或 glm，可加 |used；同一个厂商登录了多个账号时，填 codex@账号名 指定其中一个（如 codex@liuzq），只填 codex 表示该厂商的第一个账号。再次运行本安装器可更新组件。";
    done.addAction("预览组件"); done.addCancelAction("完成");
    if (await done.presentAlert() !== -1) Safari.open("scriptable:///run?scriptName=UsageWidget");
  } catch (error) {
    const failed = new Alert();
    failed.title = "连接未完成";
    failed.message = String(error.message || "请检查 PC 服务，以及 iPhone 能不能访问你填的那个地址，再重试。");
    failed.addAction("知道了"); await failed.presentAlert();
  }
}
Script.complete();
