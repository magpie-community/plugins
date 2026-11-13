(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const csrf = document.querySelector('meta[name="autoclaw-panel"]').content;
  let session = null;
  let generation = 0;
  let captcha = null;
  let warmup = null;
  let sdk = null;
  function status(text, error = false) { $("status").textContent = text; $("status").dataset.error = String(error); }
  function busy(value) {
    for (const id of ["start", "restart", "finish", "vendor"]) $(id).disabled = value;
  }
  async function api(path, data) {
    const response = await fetch(`api/${path}`, {
      method: "POST", credentials: "omit", signal: AbortSignal.timeout(45_000),
      headers: { "Content-Type": "application/json", "X-Autoclaw-Panel": csrf }, body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `请求失败（HTTP ${response.status}）`);
    return result;
  }
  function loadSdk() {
    if (sdk) return sdk;
    sdk = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timeout = setTimeout(() => reject(new Error("安全验证组件加载超时，请检查网络后重新开始")), 20_000);
      script.src = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
      script.onload = () => { clearTimeout(timeout); typeof window.initAliyunCaptcha === "function" ? resolve() : reject(new Error("安全验证组件未初始化")); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error("安全验证组件加载失败，请检查网络或广告拦截后重新开始")); };
      document.head.appendChild(script);
    }).catch((error) => { sdk = null; throw error; });
    return sdk;
  }
  async function authorize(receipt, id = session) {
    if (!id || id !== session) throw new Error("安全验证已过期，请重新开始");
    busy(true);
    try {
      status("正在获取授权链接…");
      const result = await api("authorize", { id, receipt });
      if (session !== id) return;
      $("authUrl").value = result.url;
      $("copyUrl").textContent = "复制授权链接";
      $("diagnostics").textContent = JSON.stringify(result.diagnostics, null, 2);
      $("authorize").hidden = false;
      $("captchaWrap").hidden = true;
      status("请在浏览器新标签页中打开授权链接，完成后提交回调地址。");
      $("authUrl").focus();
    } finally { busy(false); }
  }
  async function start() {
    const current = ++generation;
    busy(true);
    try {
      clearTimeout(warmup);
      if (captcha && typeof captcha.destroy === "function") captcha.destroy();
      captcha = null;
      $("captchaEle").replaceChildren();
      for (const id of ["authorize", "complete", "captchaWrap"]) $(id).hidden = true;
      $("ticket").value = "";
      $("callback").value = "";
      $("captchaTrigger").disabled = true;
      const old = session;
      session = null;
      if (old) await api("cancel", { id: old });
      status("正在准备登录…");
      const result = await api("start", { vendor: $("vendor").value });
      session = result.id;
      $("start").hidden = true;
      $("restart").hidden = false;
      if (!result.config.enabled) { await authorize(""); return; }
      $("captchaWrap").hidden = false;
      status("正在加载安全验证组件…");
      window.AliyunCaptchaConfig = { region: result.config.region, prefix: result.config.prefix };
      await loadSdk();
      if (current !== generation) return;
      const id = session;
      window.initAliyunCaptcha({
        SceneId: result.config.scene_id, mode: "popup", element: "#captchaEle", button: "#captchaTrigger", language: "cn",
        slideStyle: { width: 300, height: 40 },
        getInstance: (instance) => { captcha = instance; },
        captchaVerifyCallback: async (params) => {
          try {
            const receipt = typeof params === "string" ? params : typeof params?.captchaVerifyParam === "string" ? params.captchaVerifyParam : JSON.stringify(params);
            await authorize(receipt, id);
            return { captchaResult: true, bizResult: true };
          } catch (error) { status(error.message, true); return { captchaResult: true, bizResult: false }; }
        },
        onBizResultCallback: () => {},
        onError: (error) => status(`安全验证失败：${error?.message ?? "请重新开始"}`, true),
      });
      // SDK 需要先完成设备指纹初始化，过早点击会出现空白验证窗。
      warmup = setTimeout(() => {
        if (current !== generation) return;
        $("captchaTrigger").disabled = false;
        status("安全验证已就绪，请点击「打开安全验证」。");
      }, 2300);
    } catch (error) { status(error.message, true); }
    finally { busy(false); }
  }
  // 服务端看不到自己的公网地址（代理把 Host 改成 127.0.0.1），由页面报一次，
  // 登录框就能在 Docker／VPS 场景直接给出去面板的链接。
  api("address", { url: `${location.origin}${location.pathname}` }).catch(() => {});
  $("start").addEventListener("click", start);
  $("restart").addEventListener("click", start);
  $("finish").addEventListener("click", async () => {
    busy(true);
    try {
      status("正在完成登录…");
      const result = await api("finish", { id: session, callback: $("callback").value.trim() });
      session = null;
      $("callback").value = "";
      $("authorize").hidden = true;
      $("ticket").value = result.ticket;
      $("copyTicket").textContent = "复制完成码";
      $("account").textContent = `账户：${result.name}`;
      $("complete").hidden = false;
      status("请将完成码粘贴到 Magpie 的 AutoClaw 添加账户窗口，保存账户。");
      $("ticket").focus();
    } catch (error) { status(`${error.message}。如授权码已交换，请重新开始。`, true); }
    finally { busy(false); }
  });
  for (const [button, input] of [["copyUrl", "authUrl"], ["copyTicket", "ticket"]]) {
    $(button).addEventListener("click", async () => {
      const field = $(input);
      field.focus();
      field.select();
      let copied = false;
      let failure;
      // 不带 allow-same-origin 的插件 iframe 无法依赖异步 Clipboard API。
      try { copied = document.execCommand("copy"); } catch (error) { failure = error; }
      if (!copied && navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(field.value); copied = true; } catch (error) { failure = error; }
      }
      if (copied) {
        $(button).textContent = "已复制";
        status(input === "authUrl" ? "完整授权链接已复制，请在新标签页粘贴打开。" : "完成码已复制，请回到 AutoClaw 添加账户窗口粘贴。");
      } else {
        status(`浏览器未允许复制${failure?.name ? `（${failure.name}）` : ""}，内容已选中，请按 Ctrl+C 或 ⌘C。`, true);
      }
    });
  }
})();
