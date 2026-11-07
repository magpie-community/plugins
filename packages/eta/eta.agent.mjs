// Agent plugins run in Magpie's embedded JS engine, without Node or filesystem access.
export const agent = {
  id: "eta",
  name: "Eta",
  // Embed Eta’s shipped favicon so both Agents and installed plugins work offline.
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iRXRhIj4KICA8cmVjdCB4PSI2NCIgeT0iNjQiIHdpZHRoPSI4OTYiIGhlaWdodD0iODk2IiByeD0iMjAwIiBmaWxsPSIjMTcxNzE3Ii8+CiAgPHBhdGggZD0iTTM0Ni4wNDMgMzMwLjczOUwzMzYuMDM2IDMxOC42NDZRNDExLjUwOSAyMzQuMDAwIDQ1MC4yODcgMjM0LjAwMFE0ODcuMzk4IDIzNC4wMDAgNDg3LjM5OCAyNzUuMjgxUTQ4Ny4zOTggMjg3LjM3MyA0NzYuNTU3IDMyMy4yMzNMNDQ2LjUzNSA0MjYuNjQzUTUxNy40MjEgMzE5Ljg5NyA1NjIuMjQ2IDI3Ni45NDlRNjA3LjA3MSAyMzQuMDAwIDY0NS44NTAgMjM0LjAwMFE2OTMuODAyIDIzNC4wMDAgNjkzLjgwMiAyODcuNzkwUTY5My44MDIgMzA2LjEzNyA2ODQuNjI4IDMzOS45MTJMNjA5LjE1NiA2MTMuODY2UTU4Mi4wNTIgNzEyLjI3MyA1ODIuMDUyIDc2OS44MTVRNTgyLjA1MiA3ODEuNDkxIDU4My4zMDMgNzk0LjAwMEw1MjEuNTkwIDc5NC4wMDBRNTE5LjA4OSA3NzcuMzIxIDUxOS4wODkgNzYzLjE0NFE1MTkuMDg5IDcwOC4xMDMgNTQ1Ljc3NSA2MTIuNjE1TDYyMC40MTQgMzQ0LjA4MlE2MjcuNTAzIDMxOC42NDYgNjI3LjUwMyAzMDUuNzIwUTYyNy41MDMgMjgxLjk1MiA2MDguMzIyIDI4MS45NTJRNTgxLjIxOCAyODEuOTUyIDUyMi40MjQgMzUyLjYzMFE0NjMuNjMxIDQyMy4zMDggNDE2LjA5NSA1MzQuNjQwTDM5Mi4zMjggNjExLjM2NEwzMzAuMTk4IDYxMS4zNjRMNDE2LjkyOSAzMTYuMTQ0UTQyMS4wOTkgMzAyLjM4NCA0MjEuMDk5IDI5NS43MTNRNDIxLjA5OSAyNzkuMDM0IDQwOC41OTAgMjc5LjAzNFEzOTMuMTYyIDI3OS4wMzQgMzQ2LjA0MyAzMzAuNzM5WiIgZmlsbD0iI2ZmZmZmZiIvPgo8L3N2Zz4=",
  config: "~/.config/eta/magpie.json",
  format: "json",
  // Installing this opt-in plugin makes Eta available even before its first launch.
  dir: "~",
  ua: ["eta", "eta-desktop"],
  notice:
    "Restart Eta, then choose a model from its Magpie group. 重启 Eta 后，在模型选择器的 Magpie 类目中选择模型。",
};

// No model/startup field: Eta owns model selection; Magpie exposes its model-list controls.
export function connect({ gateway }) {
  if (
    !gateway ||
    typeof gateway.url !== "string" ||
    !/^http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?\/?$/.test(gateway.url) ||
    typeof gateway.key !== "string" ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(gateway.key)
  ) {
    throw new Error("Eta requires a local HTTP Magpie gateway and a valid gateway key");
  }
  return { version: 1, baseUrl: gateway.url.replace(/\/$/, ""), apiKey: gateway.key };
}
