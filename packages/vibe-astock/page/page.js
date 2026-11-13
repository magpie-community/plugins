/**
 * Vibe AStock × magpie 页面脚本：中英切换 + 复制。
 *
 * 页面不发网络请求、不申请 magpie 权限、不读用量与账号。
 */
const FLASH_MS = 1200;

const TEXT = {
  zh: {
    sub: "让 Vibe AStock 的对话、六阶段研究和回测，都用这台机器上的 magpie 网关出模型。",
    "s1.title": "确认网关在跑",
    "s1.body": "magpie 默认监听 127.0.0.1:3425，OpenAI 兼容前缀是 /v1。",
    "s1.tip": "改过 MAGPIE_ADDR，或者 magpie 不在本机，就用你自己的地址；magpie 的设置里能看到。",
    "s2.title": "把 Vibe AStock 接上",
    "s2.body": "在 Vibe AStock 仓库目录里跑一次，它会写 .local/providers/magpie.json，并把网关的每个模型放进「接入 AI」下拉。",
    "s2.tip": "不想装命令行工具也行：Vibe AStock 的「接入 AI」里选「其它 OpenAI 兼容端点」，手填地址、模型名和 key。",
    "s3.title": "在 Vibe AStock 里选一个模型",
    "s3.body": "「接入 AI → API 接入」的下拉里会列出这个网关的每个模型，前缀是 Magpie ·。挑一个，Base URL、Model、API Key 会自动带出。",
    "s3.tip": "列表里有哪些模型取决于你在 magpie 里接了什么，不是固定的。",
    "s4.title": "点「测试并保存」",
    "s4.body": "Vibe AStock 会先真发一轮对话，成功后才保存。",
    "s4.tip": "已知边界：服务端 JSON Schema 不生效，结构化输出走提示词；图片输入不支持。",
    "footer.lead": "Vibe AStock · A 股短线复盘与跟踪工作台 ——",
    "footer.source": "源码",
    "footer.plugin": "插件",
    copy: "复制",
  },
  en: {
    sub: "Point Vibe AStock's chat, six-stage research and backtests at the magpie gateway on this machine.",
    "s1.title": "Check the gateway",
    "s1.body": "magpie listens on 127.0.0.1:3425 by default, with the OpenAI-compatible /v1 prefix.",
    "s1.tip": "If you changed MAGPIE_ADDR, or magpie runs elsewhere, use your own address — magpie's settings show it.",
    "s2.title": "Connect Vibe AStock",
    "s2.body": "Run this once inside the Vibe AStock checkout. It writes .local/providers/magpie.json and puts every gateway model into the Connect AI picker.",
    "s2.tip": "No CLI needed: pick “Other OpenAI-compatible endpoint” in Vibe AStock and type the address, a model id and the key yourself.",
    "s3.title": "Pick a model in Vibe AStock",
    "s3.body": "The Connect AI → API picker lists every model this gateway offers, prefixed Magpie ·. Pick one and the base URL, model id and key are filled in.",
    "s3.tip": "Which models appear depends on what you connected inside magpie — there is no fixed list.",
    "s4.title": "Hit “Test and save”",
    "s4.body": "Vibe AStock sends one real turn first and only saves the config when it succeeds.",
    "s4.tip": "Known limits: server-side JSON Schema is not enforced (structured output falls back to the prompt); image input is not supported.",
    "footer.lead": "Vibe AStock — an A-share short-line review workbench —",
    "footer.source": "source",
    "footer.plugin": "plugin",
    copy: "Copy",
  },
};

const LANG_KEY = "vibe-astock-page-lang";

function applyLang(lang) {
  const table = TEXT[lang] ?? TEXT.zh;
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const value = table[node.dataset.i18n];
    if (value) node.textContent = value;
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* 存不了就只在本次生效 */
  }
}

function initialLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 忽略 */
  }
  return (navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
}

for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => applyLang(button.dataset.lang));
}

const currentLang = () => (document.documentElement.lang === "en" ? "en" : "zh");

/** 复制文本；按钮短暂显示已复制 */
function copy(text, button) {
  const old = button.textContent;
  const flash = () => {
    button.textContent = currentLang() === "en" ? "Copied" : "已复制";
    setTimeout(() => {
      button.textContent = old;
    }, FLASH_MS);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(flash, () => {});
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    flash();
  } catch {
    /* 复制不了也没关系，值本身在页面上可见 */
  }
  document.body.removeChild(area);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => copy(button.dataset.copy, button));
}
for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (target) copy(target.textContent, button);
  });
}

applyLang(initialLang());
