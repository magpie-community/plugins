magpie.ready.then(async () => {
  const options = await magpie.options.get();
  const service = magpie.service || `http://127.0.0.1:${options?.port || 3479}/`;
  location.replace(service);
}).catch(() => {
  document.querySelector("#status").textContent = "打开失败，请检查插件服务后重新打开此页面。";
});
