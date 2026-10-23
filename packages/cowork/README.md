# magpie-agent-cowork

把 **团结 Cowork**（Tuanjie Cowork，本地 agent 是 `codely.exe`）接成 magpie 的一个 agent：
在 magpie 里给 Cowork 选一个模型，Cowork 就用 magpie 网关上那个模型说话——用的是你已经在
magpie 里登进去的那些订阅的额度，Cowork 自己不用另登录。

```
magpie cowork workbuddy/deepseek-v4.1-flash     # 换 Cowork 的聊天模型
magpie cowork                                    # 看它现在用哪个
magpie cowork default                            # 把 Cowork 交还给它自己原来的选择
```

装：

```sh
magpie plugin add @magpie-community/agent-cowork
```

`seed.mjs` 需要 Node 18 以上（用了顶层 await 和全局 `fetch`），magpie 自己带的那套不影响它。
机器上没有 `node` 就用 Cowork 自带的那个——它不在 PATH 上，位置跟着安装目录变：

```sh
"<安装目录>\cli\bin\win32-x64\node.exe" seed.mjs
```

## 适用前提

这个包读的是 Windows 上 Cowork 桌面应用的存储布局，键名出自安装包 2026-10-14 那一版。成立的前提是三条：

- **Cowork 的主目录在默认位置 `~/.codely`。** 设置里的 Codely Home Location 能把它搬走，搬成功时 Cowork 把
  新位置写进系统环境变量 `CODELY_CLI_HOME`。`seed.mjs` 跟着这个变量走，但只认里面有 `ide-settings.json` 的
  目录——终端 `codely` 自己那份 `~/.codely-cli` 没有它，指过去就是把清单写进没人读的库。两个候选都不像
  Cowork 的家时它停住报错、不替你新建；硬指用 `--store <主目录>/settings.json`。**插件那一半没有这个余地**：
  `cowork.agent.js` 的 `config` 写死在 `~/.codely/ide-settings.json`，只跟着用户主目录，agent 契约也不允许
  一个插件写第二个文件。所以搬过主目录的机器上 `magpie cowork <模型>` 写的文件 Cowork 读不到、切换静默失效——
  这类机器用 `seed.mjs` 搬清单、在 Cowork 里点模型；要还能用命令行切，就把主目录搬回默认位置。
- **管的是桌面应用，不是终端里的 `codely`。** 后者用 `~/.codely-cli`，模型记在 `model-config.json`，文件和
  形状都和桌面应用不一样，本插件不动它。
- **Windows。** macOS、Linux 上这三份文件放在哪没有依据；其它版本的 Cowork 也没有依据说键名仍是
  `defaultChatModelTitle` / `customModels` / `customModelProviders`。

## 先跑一次 seed

Cowork 的模型清单在 `~/.codely/settings.json`，它当前用哪个模型记在 `~/.codely/ide-settings.json`
的 `defaultChatModelTitle`。这个值是清单里那条模型的**名字**（`displayName`），不是请求体里的 `model`
字符串——所以 `seed.mjs` 把它写进清单的每条模型都用模型 id 当名字，否则 `magpie cowork <模型>` 写进去
的字符串 Cowork 认不出来，会静默退回原来的模型。

改名只发生在**它记录的条目**上：某条是它写的、你后来在 Cowork 里换了名字，下次 seed 会把名字改回模型
id（不改的话 `magpie cowork <模型 id>` 选不中它）；如果这条正好是 Cowork 当前选中的，`defaultChatModelTitle`
在同一次运行里跟着改成新的名字，不留悬空选择，输出也会说明。记录里没有的条目——你自己加的、自己起名的，
包括你在 `magpie` 那家 provider 下自己加的——一个字都不改。`ide-settings.json` 读不出来时它整次停住
（退出码 2），不会把「读不到」当成「没选」再去改名或删条目。

插件本身只维护 `ide-settings.json` 这一个文件——magpie 的 agent 插件按契约只能碰一个配置文件，
而清单那个文件里是数组，magpie 的写入器碰到 `customModels: []` 会写成 `{"0": {…}}`，Cowork 读不了。
所以模型清单由包里的 `seed.mjs` 从 magpie 的 `/v1/models` 一次性搬过去。装完之后它在 magpie 的插件目录
`~/.config/magpie/plugins/node_modules/@magpie-community/agent-cowork/`（设了 `XDG_CONFIG_HOME` 的把
`~/.config` 换成它）：

```sh
cd ~/.config/magpie/plugins/node_modules/@magpie-community/agent-cowork
node seed.mjs            # 第一次写之前把原文件留成 settings.json.pre-magpie，只留这一次
node seed.mjs --check    # 只报漂移，不写；有漂移（含被扣下的条目）时退出码 1
node seed.mjs --prune    # 允许删掉记录里已不在 magpie 目录中的条目（见下）
node seed.mjs --remove   # 摘掉记录里属于本包的条目；那家 provider 只在没人用时才删
```

**跑之前先退出 Cowork。** `ide-settings.json` 有两个写者：magpie 切模型时写它，Cowork 自己在运行中也会
写回它。Cowork 开着的时候切模型，它下一次保存就可能
把刚写进去的名字盖回去。所以：退了 Cowork 再 seed，切完模型再启动；已经在开着的情况下切过，就
`cat` 一下确认那个名字还在。

**它只动自己写过的东西**：哪些条目是它写的记在同目录的 `settings.json.magpie-seeded`（一个 entry id
数组）。改名、删除与 `--remove` 要同时满足两条——那条在这份记录里，**且**它挂在包自己建的那家
`magpie` provider 下。你自己的 provider 就算地址也填的 magpie、就算被旧版记录误认领过，也不会被删、
也不会被改名；你手动加在 `magpie` 那家下面、名字自己起的条目同样不在记录里，`--prune` 和 `--remove`
都不碰。记录丢了但 `settings.json.pre-magpie` 还在（= 我们确实写过这个库）时，`seed.mjs` 会按形状
认领一次：只认挂在 `magpie` 下、名字正好等于模型 id、而且 magpie 现在仍提供的条目；`--remove` 在
记录缺失时不猜，会要求先跑一次 `seed.mjs` 把记录补回来。**卸掉插件不会自动跑 `--remove`**——magpie
没有这个钩子，卸完要自己跑一次，否则那家 provider 和它下面的 magpie 条目会留在 Cowork 里。

**这类模型不认模型 id**：某个模型在 Cowork 里的条目名字不是模型 id（通常是它只存在于你自己的 provider 下、
名字还是你起的）。`magpie cowork <模型 id>` 写进去的是 id，而 Cowork 按它显示的名字找条目，找不到就退回
原来的模型（不报错）。seed 会列出它们：能当参数的给出 `magpie cowork "<名字>"`；名字里带 `/`（会被
magpie 当成 `供应商/模型` 去校验）、以 `-` 开头（会被当成 flag）、或者正好叫 `default`（会把 agent
复位）的，则让你回 Cowork 里点。能传的名字直接用 Cowork 显示的名字切，例如
`magpie cowork "GLM-5.3-Flash · zcode"`——magpie 对不在目录里的写法是原样写入的；只有形如
`供应商/模型` 的写法会被当成目录引用去校验（供应商是 magpie 的 provider、模型又不在目录里就报错），
其余字符串照写。带 `/` 的名字就在 Cowork 里选，或者在 `magpie` 那家 provider 下加一条以模型 id
命名的条目。

**目录里没有的条目不删**：magpie 的目录会因为某个账号正在恢复、magpie 刚启动而临时变短，照着删就会
删掉你正在用的那条。所以记录里有、当前目录里没有的条目一律先留着，只报
`N recorded entries aren't in the catalog right now; pass --prune to drop them`；`--check` 仍把它算作
漂移（退出码 1）。要删请显式加 `--prune`；就算加了，`defaultChatModelTitle` 指的那一条也永远不删。
`--remove` 如果正好摘掉 Cowork 当前选中的模型，会明确说出来，你在 Cowork 里重选一个即可。

搬完之后，magpie 自己那批条目用 `magpie cowork <模型 id>` 就能直接切，不用回 Cowork 的模型列表里点；
你自己 provider 下的条目用它们显示的名字切（见上）。

**这一步得你手动跑，而且目录变了要再跑**：agent 插件按契约只能写 Cowork 的一个配置文件，模型清单在
另一个文件里、还是数组，插件搬不了。magpie 的目录本身会变，所以 `--check` 留了个能用退出码判断的
口子——目录新增、有被扣下的条目、provider 地址变了都算漂移，退 1；文件读不出来退 2 且不写。挂个
定时任务就行。**没搬进去的模型不会报错**：用 `magpie cowork <模型 id>` 切到它，title 写进去了，但
Cowork 找不到同名条目，会退回自己原来的模型。这是这条路线最难看的一点，目前只能靠「切之前先
`--check`」避开。

改动生效的时机：Cowork 启动时读这个文件，所以重启 Cowork 或新开一个会话才用新模型。

## 装完怎么确认

```sh
magpie ls          # 应当有一行 Tuanjie Cowork，右边是它当前的模型和配置路径
magpie cowork <某个模型>
cat ~/.codely/ide-settings.json     # defaultChatModelTitle 应当已经变成那个模型（搬过主目录的看那个目录）
```

然后在 Cowork 里发一句话，回话应当来自那个模型。若它回的是别的模型，说明那个名字在 Cowork 的清单里
没有对应条目——再跑一次 `node seed.mjs`。

图标取自 Cowork 安装包里的 `app/resource/dist/branding/logo_dark.png`，缩到 112px 后内联成 data URI
（和 `@magpie-community/agent-kimi-desktop` 一样的做法，好处是不依赖仓库先建好），同图另存一份 `icon.png` 随包发。
