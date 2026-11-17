# Pi-Desktop for Magpie

Pi-Desktop keeps its model providers in a database that only its own host process writes, so Magpie cannot wire it by editing a settings file the way it wires Codex or Pi. What Pi-Desktop does read from disk is a plugin folder: loaded as a local plugin, its `manifest.json` is read again every time Pi-Desktop starts. This package makes that file the one Magpie keeps.

- **The Magpie agent `pi-desktop-app`** (connect-only; `pi-desktop` is the id of Magpie's own Sessions source, which Magpie refuses for a plugin). It gives Pi-Desktop a row on Magpie's Agents page, its own gateway key `magpie-pi-desktop-app` for Usage and routing rules, and model visibility (`magpie visible pi-desktop-app …`).
- **The plugin folder `~/.config/magpie-pi-desktop/plugin`**, which Magpie writes while the row is on. Its `manifest.json` is a Pi-Desktop plugin (`local.magpie-gateway`) that declares the provider *Magpie*, pointed at the gateway, with every model Magpie offers Pi-Desktop and each model's thinking levels. Magpie rewrites it when its models change. It holds no code, and its only permission is `provider.register`. Pi-Desktop stores the key you enter.

Every model Magpie offers Pi-Desktop then shows up in Pi-Desktop's picker under *Magpie* (and *Magpie 2*, … past 64 models), including routing groups, so its multi-vendor routing and fallback apply to Pi-Desktop too. You still pick the model per chat in Pi-Desktop.

## Set up

1. In Magpie: `magpie plugin add <this folder>`, or Plugins › Discover › *Have one in mind?*, pick this folder and Install (once published: `magpie plugin add @magpie-community/agent-pi-desktop`; the bare name `pi-desktop` is someone else's npm package). Under Plugins › Installed its row should read *Adds Pi-Desktop to Agents*, with no error. Then Connect Pi-Desktop in Agents (or `magpie pi-desktop-app provider magpie`). Pi-Desktop is detected by its data folder `~/.pi-desktop`.
2. In Pi-Desktop, once: Extensions › ⋯ (More actions) › Load local plugin, choose the folder `.config/magpie-pi-desktop/plugin` in your user folder, and confirm with Load plugin. *Magpie Gateway* appears with a *Local* tag, and its provider cards are there at once.
3. Settings › AI providers › Add provider › *Magpie*: enter the API key `magpie-pi-desktop-app` and save. Do the same for *Magpie 2* and any further card; Add provider lists the ones that have no key yet.
4. Pick a Magpie model in a chat. `node scripts/doctor.mjs` checks every step; it prints no secrets, only the public key name `magpie-pi-desktop-app`.

Installed by its scoped name, the package lands under `~/.config/magpie/plugins/node_modules/@magpie-community/agent-pi-desktop`; run the script from there, or from a checkout.

## When Magpie's models change

Nothing to do in Magpie: while the row is connected it rewrites the manifest, for added and removed models, changed visibility and a changed port alike. Pi-Desktop reads the manifest's providers and models when it starts, so the change shows after Pi-Desktop is next opened. To apply it without a restart, turn *Magpie Gateway* off and on under Extensions (its row's ⋯ menu › Disable, then Enable). Saved keys stay.

It is not instant: Pi-Desktop 0.22.0 reads a plugin's providers only when it starts, when the plugin is enabled and when a local plugin is loaded, and gives plugins no call to change them. While open, Pi-Desktop does notice the file change and says *Reloaded Magpie Gateway*; that reloads the plugin's code, not its provider list. *Reload plugin* in the row's menu does the same.

## What Magpie writes

Only `~/.config/magpie-pi-desktop/plugin/manifest.json`, a file of its own:

```json
{
  "schemaVersion": 1,
  "id": "local.magpie-gateway",
  "name": "Magpie Gateway",
  "version": "0.2.0",
  "main": "manifest.json",
  "contributes": {
    "providers": [{
      "id": "magpie", "name": "Magpie", "baseUrl": "http://127.0.0.1:3425/v1", "apiStyle": "chat_completions", "authKind": "api_key",
      "models": [{ "id": "deepseek/deepseek-chat", "name": "DeepSeek Chat", "contextWindow": 131072, "maxTokens": 8192, "thinkingLevels": ["low", "medium", "high"], "defaultThinkingLevel": "high" }]
    }]
  },
  "permissions": ["provider.register"],
  "engines": { "piDesktop": ">=0.22.0" },
  "magpie": { "baseUrl": "http://127.0.0.1:3425/v1", "apiKey": "magpie-pi-desktop-app", "apiStyle": "chat_completions" }
}
```

`main` names the manifest itself: Pi-Desktop wants an entry file, and a JSON file loads as a module with no hooks. `magpie` is for Magpie and `doctor.mjs`; Pi-Desktop ignores it. Turning the row off takes every key out again. Pi-Desktop's own database and secrets are never written; `doctor.mjs` reads a temporary copy and deletes it.

## Good to know

- **Thinking levels.** Pi-Desktop (0.22.0) takes them only from models a plugin declares. A model it discovers from the gateway gets all seven levels and starts on `off`, which is why the manifest declares them. Each model starts on `high`, or the nearest level it has, as Magpie picks for Codex. A model Magpie gives no levels for keeps the generic settings. Magpie's `none` is Pi-Desktop's `off`; Magpie's `ultra` has no Pi-Desktop level and is left out.
- **64 models per card.** Pi-Desktop refuses a plugin provider with more, so the list is split into *Magpie*, *Magpie 2*, …, keeping one vendor's models together when they fit. Each card needs the key once, so a card that appears later (*Magpie 3*) asks for it then. When the list changes a model can move to another card, and a chat that used it needs its model picked again; `magpie visible pi-desktop-app …` can bring the list under 64.
- **Coming from 0.1.x** (the `.piplug` with a fixed model list): turn this Magpie plugin off and on, connect the row again, then do step 2. Loading the folder replaces the installed package and keeps the saved key.
- **Turning it off.** Disconnecting the row in Magpie empties the manifest; Pi-Desktop keeps the cards it last read. To remove them, uninstall *Magpie Gateway* in Pi-Desktop's Extensions.
- Turning this Magpie plugin off or removing it disconnects the agent first.
- **A wrong key still works.** The local gateway serves any key, so a mistyped key only shows up in Usage, under another name. Use `magpie-pi-desktop-app`.
- Tested with Magpie 0.1.4267 and Pi-Desktop 0.22.0 on Windows 11.

## 中文说明

Pi-Desktop 的模型服务存放在只有它自己的宿主进程能写的数据库里，Magpie 没法像接 Codex、Pi 那样直接改配置文件。但 Pi-Desktop 会从磁盘读插件文件夹：作为"本地插件"加载的文件夹，它每次启动都重新读里面的 `manifest.json`。本包让 Magpie 来维护这个文件。

- **Magpie 代理 `pi-desktop-app`**（仅连接；`pi-desktop` 是 Magpie 自己会话功能的 id，插件不能用）：Pi-Desktop 在 Agent 页有自己的一行，有独立的网关密钥 `magpie-pi-desktop-app`，用量和路由规则按它归属，可以用 `magpie visible pi-desktop-app …` 控制它看到的模型。
- **插件文件夹 `~/.config/magpie-pi-desktop/plugin`**：这一行开着时由 Magpie 写。里面的 `manifest.json` 是一个 Pi-Desktop 插件（`local.magpie-gateway`），声明模型服务 *Magpie*，指向网关，带上 Magpie 给 Pi-Desktop 的全部模型和每个模型的推理等级。Magpie 的模型变了，它会重写这个文件。文件夹里没有代码，权限只有 `provider.register`。密钥由 Pi-Desktop 自己保存。

### 接入步骤
1. Magpie：`magpie plugin add <本文件夹>`，或在 插件 › 发现 › 已有想装的？ 选本文件夹后点"安装"（发布后用 `magpie plugin add @magpie-community/agent-pi-desktop`；不要用裸名 `pi-desktop`，那是 npm 上别人的包）。在 插件 › 已安装 里，它这一行下面应写着"把 Pi-Desktop 加到 Agent 页"，没有红字。然后在 Agent 页接入 Pi-Desktop（或 `magpie pi-desktop-app provider magpie`）。
2. Pi-Desktop（只做一次）：扩展 › ⋯（更多操作）› 加载本地插件，选用户文件夹下的 `.config\magpie-pi-desktop\plugin`，在确认框里点"加载插件"。*Magpie Gateway* 出现并带"本地"标记，服务卡片马上就有。
3. 设置 › AI 服务 › 添加服务 › *Magpie*：API 密钥填 `magpie-pi-desktop-app`，点"保存服务"。有 *Magpie 2* 等更多卡片时，每张都填一次；添加服务里只列出还没存密钥的。
4. 在对话里选 Magpie 模型。用 `node scripts/doctor.mjs` 体检，它不输出任何秘密，只显示公开的密钥名 `magpie-pi-desktop-app`。

每一步的预期结果和排错表，见源码仓库的 `docs/04-详细接入教程.md`。

### Magpie 的模型变了之后
Magpie 这边不用做任何事：这一行是已连接时，增删模型、改可见模型、换端口，它都会重写 manifest。Pi-Desktop 在启动时读 manifest 里的服务和模型，所以下次打开 Pi-Desktop 就是新清单。不想重启的话，在 扩展 里把 *Magpie Gateway* 禁用再启用（这一行的 ⋯ 菜单）。已存的密钥保留。

做不到即时生效：Pi-Desktop 0.22.0 只在启动、启用插件、加载本地插件时读插件的服务列表，也没有给插件修改服务列表的接口。Pi-Desktop 开着时会发现文件变了并提示 *Reloaded Magpie Gateway*，这只是重新加载插件代码，不更新模型清单；行菜单里的"重载插件"也一样。

### 注意
- 推理等级：Pi-Desktop 0.22.0 只对插件声明的模型带推理等级，自己发现的模型七个档位全可选、默认 off，所以 manifest 要声明模型。每个模型默认 high 或它有的最接近的一档，和 Magpie 给 Codex 的选法一样。Magpie 没给推理等级的模型保持通用设置。Magpie 的 `ultra` 在 Pi-Desktop 里没有对应档位，不带过去。
- 每张卡片最多 64 个模型，超过时分成 *Magpie*、*Magpie 2*…，同一供应商的模型尽量放一起，每张卡片各填一次密钥，以后新出现的卡片（*Magpie 3*）到时再填。清单变化后模型可能换卡片，用着它的对话要重新选模型；`magpie visible pi-desktop-app …` 可以把清单减到 64 个以内。
- 从 0.1.x（模型清单固定的 `.piplug`）升级：在 Magpie 把本插件停用再启用，重新接入这一行，然后做第 2 步。加载文件夹会替换原来装的包，已存的密钥保留。
- 在 Magpie 断开这一行会清空 manifest，Pi-Desktop 保留最后读到的卡片；要移除它们，请在 Pi-Desktop 扩展页卸载 *Magpie Gateway*。
- 停用或移除本 Magpie 插件时，Magpie 会先自动断开这个代理。
- 密钥填错不会报错：本机网关接受任何密钥，只是用量会记到别的名下。请填 `magpie-pi-desktop-app`。
