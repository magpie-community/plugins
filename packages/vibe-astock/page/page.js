/**
 * Vibe AStock × magpie 页面脚本：只做「复制」。
 *
 * 页面不发任何网络请求、不申请任何 magpie 权限、不读用量与账号。
 * 模型名请到 magpie 自己的模型列表里复制 —— 网关没有 CORS 头，页面里 fetch 会被浏览器拦下，
 * 与其摆一个永远失败的按钮，不如不摆。
 */
const FLASH_MS = 1200;

/** 复制文本；按钮短暂显示「已复制」 */
function copy(text, button) {
  const flash = () => {
    const old = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = old;
    }, FLASH_MS);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(flash, () => {});
    return;
  }
  // 老 webview 没有 clipboard API：退回 execCommand
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    flash();
  } catch {
    /* 复制不了也没关系，值本身在页面上可见、可手选 */
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
