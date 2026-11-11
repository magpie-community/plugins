(async () => {
  const retry = document.getElementById("retry");
  retry.addEventListener("click", () => location.reload());
  try {
    const theme = await magpie.ready;
    const options = await magpie.options.get();
    const port = Number(options?.port ?? 3497);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid service port in plugin options.");
    const target =
      magpie.service ||
      (["localhost", "127.0.0.1", ""].includes(location.hostname)
        ? `http://127.0.0.1:${port}/`
        : "");
    if (!target)
      throw new Error(
        "Update Magpie to open this service from a remote browser.",
      );
    const url = new URL(target);
    url.searchParams.set("theme", theme.dark ? "dark" : "light");
    setTimeout(() => {
      document.getElementById("message").textContent =
        "The collector did not start. Check the plugin log and whether its port is already in use.";
      retry.hidden = false;
    }, 6000);
    location.replace(url.href);
  } catch (e) {
    document.getElementById("message").textContent = e.message;
    retry.hidden = false;
  }
})();
