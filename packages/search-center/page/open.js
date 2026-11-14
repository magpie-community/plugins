(async () => {
  if (window.magpie) await magpie.ready;
  const target = window.magpie?.service || "http://127.0.0.1:3487/";
  const url = new URL(target, location.href);
  url.searchParams.set("ui", "0.8.0-beta.1");
  location.replace(url.href);
})();
