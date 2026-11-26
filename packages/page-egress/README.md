# Exit IPs / 出口 IP

A management page for **self-hosted Magpie web** that lists named proxy exits, shows their last measured IP and lets you choose an exit per provider, subscription account or API key. Magpie's native proxy settings perform the forwarding; this package adds a combined view and persistent IP-change history.

Requires Magpie **0.1.4260 or newer**. The page currently has Chinese labels. It does not sign in to a model provider or add a model.

## Install and connect

```sh
magpie plugin add @magpie-community/page-egress
```

The host part uses the same server process's `MAGPIE_WEB_KEY` to call its native web management API. Keep this key in Magpie's environment, never in plugin options. The default API address is `http://127.0.0.1:3430`; configure another address when Magpie web serves HTTPS or listens elsewhere:

```sh
magpie plugin options @magpie-community/page-egress '{"apiBase":"https://magpie.example.com:3430","port":3479,"intervalSeconds":300}'
```

Alternatively set `MAGPIE_EGRESS_API_BASE` in Magpie's environment. HTTPS certificate verification stays enabled. Use an address covered by the server's certificate.

Open **Plugins → Exit IPs / 出口 IP** in the sidebar. The service listens only on `127.0.0.1`; Magpie web proxies it through its existing authenticated plugin-page channel. No new public listener is added. Plain OpenCode and desktop Magpie without a configured Magpie web management key are not supported.

## Add and bind exits

1. Click **添加出口** and enter a name and an HTTP, HTTPS or SOCKS5 proxy address. Use the separate username/password fields, or leave them empty for IP-whitelist authentication.
2. Click **检测 IP** to measure the proxy's actual exit IP, country and latency.
3. Choose a provider's default exit, or an account/key's own exit, then click **保存** and confirm.

An account/key's choice takes priority over its provider's choice, which takes priority over Magpie's global proxy. **继承供应商** follows its provider; **继承全局设置** follows the global proxy; **VPS 直连** explicitly chooses direct. Installing this plugin does not change existing bindings.

The displayed IP is the last proxy probe, not a packet capture of each model request. Existing inline proxy addresses are masked and remain unchanged until another exit is selected. Register them as named proxies to enable probing. Direct connections are shown as unmeasured.

## Changes, failures and history

While the plugin host runs, the service checks saved proxies every five minutes by default, with a minimum configurable interval of one minute. It uses Magpie's native proxy-test endpoint, not model inference. A visible page refreshes its data every 30 seconds; opening another Magpie page does not stop the host's checks.

The first successful check becomes the expected IP. A different IP produces an alert until **认可新 IP** acknowledges it. A failed check keeps the last successful reading, marked with its failure and timestamp. Alerts appear in the page and its event list, not as push notifications. The plugin never switches a failed proxy to direct or another proxy. Existing Magpie provider/account failover rules still apply.

History persists in `<Magpie config>/egress-manager/history.json`. Before saving a proxy or binding, the plugin keeps a private config backup in `egress-manager/backups/`, retaining 40 files. Backups can contain provider credentials and are mode `0600`; their directory is mode `0700`.

Binding saves use Magpie's native save API. A stale provider revision is rejected. After saving, the service checks the requested binding and verifies that unrelated provider fields have not changed. An unexpected native normalization is reported as an error with a backup retained; this is detection after the save, not an atomic rollback. Compare the backup before restoring individual fields, so later legitimate changes are preserved.

## Access and limits

This is a privileged administration plugin. Its host reads `providers.json`, calls the native settings/providers/proxy APIs, and can save proxy credentials and bindings. The iframe bridge permission list is empty because those operations run in the local host service, not through `magpie.read`.

The management key and raw provider credentials never go to the page. Proxy passwords are write-only. The loopback service checks `Host`, rejects unrelated origins, and requires a per-process token on every JSON route. Static assets contain no management credentials. The page uses button handlers rather than form submission to work in Magpie's sandbox.

- A fixed proxy choice cannot stop a proxy vendor rotating its actual IP.
- Browser registration, KYC pages and other applications keep their own client-side routing.
- With a relay provider, this controls only the connection to that relay, not its onward exit.
- Login/refresh/quota traffic from individual community authentication plugins needs separate validation.
- Turning this plugin off leaves native proxies and bindings in place. Remove a binding in this page or Magpie's native settings before disabling it if needed.

## Check

```sh
HOME=$(mktemp -d) bun test packages/page-egress
bun scripts/check.mjs page-egress
```

Tests use temporary config folders and fake native APIs. They cover proxy precedence and credential redaction, persistent IP-change/failure history, binding saves and revision conflicts, sandbox-compatible controls, and service token/origin/host checks. They do not read real sign-ins or spend model quota.

The original deployment was additionally exercised against an isolated Magpie 0.1.4260 instance, and through the actual Magpie web iframe: proxy creation/probing and binding save/restore. These checks are separate from the portable tests and do not establish every authentication plugin's routing behavior.

## 中文

在自建 Magpie web 中增加“出口 IP”页面，把代理池、供应商默认出口、订阅账号和 API Key 的独立出口放在一起管理。实际转发复用 Magpie 原生代理配置。

需要 Magpie 0.1.4260+，并让 Magpie 进程继承其 web 管理密钥 `MAGPIE_WEB_KEY`。默认访问同机 `http://127.0.0.1:3430`；HTTPS 部署通过上面的 `apiBase` 选项配置真实管理地址，保持证书验证。不要把密钥写进插件选项。

添加出口后先检测 IP，再在供应商或账号旁选择并保存。安装不会自动修改已有绑定。每五分钟检测一次，IP 变化或检测失败会在页面提示，保留历史；不会自动更换出口。检测 IP 不代表每次模型请求的实测出口，浏览器注册和 KYC 仍使用客户端代理设置。
