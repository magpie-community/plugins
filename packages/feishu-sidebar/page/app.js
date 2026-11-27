(() => {
  const en = {
    title: "Feishu sidebar",
    setup: "Enable Browser access in Magpie, or run magpie web.",
    address: "Magpie Web address",
    hint: "Use the address without the sign-in key. Use HTTPS for another computer.",
    generate: "Generate Feishu link",
    link: "Feishu link",
    select: "Select link",
    steps: "Copy the link to your own Feishu chat and open it in Feishu desktop. Sign in on Magpie’s page, then right-click the sidebar tab to pin it.",
    invalid: "Enter a full Magpie Web address starting with http:// or https://.",
    plainAddress: "Remove credentials, query parameters and fragments from the address before sharing it.",
    https: "Use an HTTPS address for Magpie Web on another computer.",
  }
  const zh = {
    title: "飞书侧边栏",
    setup: "在 Magpie 设置里开启浏览器访问，或运行 magpie web。",
    address: "Magpie Web 地址",
    hint: "请填写不含登录密钥的网址。访问其他电脑上的 Magpie 时请用 HTTPS。",
    generate: "生成飞书链接",
    link: "飞书链接",
    select: "选中链接",
    steps: "复制链接，粘贴到飞书里发给自己，再用飞书桌面端打开。在 Magpie 页面登录后，可以右键点击左侧标签页将它固定。",
    invalid: "请输入以 http:// 或 https:// 开头的完整 Magpie Web 地址。",
    plainAddress: "请先从地址中移除身份凭据、查询参数和片段。",
    https: "访问其他电脑上的 Magpie Web 时请用 HTTPS 地址。",
  }
  const address = document.getElementById("web-url")
  const error = document.getElementById("error")
  const result = document.getElementById("result")
  const link = document.getElementById("applink")
  const text = document.querySelectorAll("[data-t]")
  let words = en
  let problem = ""

  function translate(theme) {
    words = theme?.lang?.startsWith("zh") ? zh : en
    for (const element of text) element.textContent = words[element.dataset.t]
    error.textContent = words[problem] ?? ""
  }

  function show(output) {
    problem = output.error ?? ""
    error.textContent = words[problem] ?? ""
    address.setAttribute("aria-invalid", String(Boolean(problem)))
    link.value = output.link ?? ""
    result.hidden = !output.link
  }

  function selectLink() {
    link.focus()
    link.select()
  }

  function generate() {
    const output = buildFeishuLink(address.value)
    show(output)
    if (output.link) selectLink()
    else address.focus()
  }

  address.addEventListener("input", () => show({}))
  address.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) generate()
  })
  document.getElementById("generate").addEventListener("click", generate)
  document.getElementById("select").addEventListener("click", selectLink)

  magpie.onTheme(translate)
  magpie.ready.then(translate)
})()
