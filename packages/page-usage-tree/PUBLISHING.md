# 发布方案

这个插件是 Magpie 的**页面插件**（page plugin）：在 Magpie 窗口侧栏加一个自己的
页面，带一个只读的本地服务。下面是把它发布出去的两条路线，以及各自需要做什么。

## 先看清两条路线

Magpie 的 Plugins 页面（Discover）里，一个插件有两个来源：

| 来源 | 谁能写 | 怎么被发现 |
|---|---|---|
| **社区清单 `registry.json`** | 只有 `magpie-community/plugins` 的维护者 | 合并后，Discover 的推荐位直接出现 |
| **GitHub topic `magpie-plugin`** | 任何人 | 仓库打上该 topic，Discover 的 GitHub 列表里自动出现 |
| **npm 搜索** | 任何人 | Discover 的搜索会问 npm；`magpie plugin add npm:<包名>` 也可直接装 |

### 一个必须先知道的判定规则

`internal/plugin/github.go` 里的 `readTagged()` 是这样定 kind 的：

```go
if pj.Main == "" && len(pj.Exports) == 0 {
    switch {
    case magpie.middleware != "": t.Kind = "middleware"
    case magpie.agent != "":      t.Kind = "agent"
    case magpie.page.file != "":  t.Kind = "page"
    ...
    }
}
```

**只有完全没有 `main` 和 `exports` 的仓库才会被自动标成 `page`。**
本插件有 `main`（宿主部分要起本地服务），所以它**不会**被自动识别为 page；
若走 GitHub topic 路线，它会被当成 `pv`（Provider）分类显示。

因此两条路线的效果不同：

- **走社区清单**：清单里显式写 `"kind": "page"`，分类正确，卡片有 Page 标签。
- **走 GitHub topic 或纯 npm**：分类可能显示为 Provider；需要用
  `magpie plugin add npm:<包名>` 或搜索名字来装，而不是靠分类找。

`registry.json` 只有 `community: true` 的条目会被采纳
（`internal/plugin/market.go` 的 `market()`），所以自己发布只能走
GitHub topic 或 npm，不要试图直接改社区的清单。

### 路线 A：独立发布到 npm（推荐）

自己拥有包名、版本和更新节奏，不依赖任何第三方审核。

1. 新建 GitHub 仓库，例如 `magpie-usage-tree`。
2. 包名用自己的 scope，例如 `@<你的账号>/magpie-usage-tree`。
   Magpie 的 `pkgName` 正则要求 scoped 或合法的 npm 名；`magpie plugin add`
   对 scoped 名按原样处理。
3. 仓库打上 topic `magpie-plugin`，并把 `package.json` 的
   `repository` / `homepage` 指到这个仓库（`test/discover.test.mjs` 会检查）。
4. `npm publish`。

发布后：

```sh
magpie plugin add npm:@<你的账号>/magpie-usage-tree
```

别人也能在 Discover 的搜索里按包名找到它。但因为上面说的判定规则，它不会
出现在 Page 分类下；想在 Page 分类里出现，就走路线 B 提 PR。

### 路线 B：提 PR 到 magpie-community/plugins

进官方社区仓库，名字必须是 `@magpie-community/page-<name>`，并同时在
`registry.json` 加一条 `kind: "page"` 的条目。

适合希望进入官方 Discover 推荐位、或愿意走社区评审的情况。

## 本插件需要满足的发布要件

按社区仓库 README 的 Pages 一节（`packages/<name>/`），页面插件需要：

| 要件 | 本插件现状 |
|---|---|
| `package.json` 名为 `@magpie-community/page-<name>` | 需在提 PR 时改名 |
| `"magpie": {"page": {"title", "file", "icon"}}` | 已有 |
| `magpie.permissions` 只声明真正读的东西 | 本插件声明 `[]`（不读任何 `magpie.read`）|
| 页面在 `connect-src 'none'` 沙箱里跑，不发网络请求 | 页面本身不发请求；数据来自本地服务 |
| 页面与 bridge 通信只用 `magpie.ready` / `options` / `read` | 只用 `magpie.ready` 和 `options.get` |
| 一个测试：页面脚本只读声明的权限、不联网 | 需要补 `packages/usage` 式的页面测试 |
| 宿主部分：`main` 为 `export default {id, server}`，在 127.0.0.1 起服务 | 已有 `index.mjs` |
| 服务每个路由都要有页面专属 token，并校验 `Host` | 已有；额外支持 `Origin: null`（沙箱页）|
| LICENSE | 需补 MIT `LICENSE` 文件 |

### 一个必须处理的冲突：`magpie.icon` 与 `magpie.page.icon`

这两个是不同的东西：

- `magpie.page.icon`：**侧栏页面标签**的图标，相对包根目录，Magpie 把它随页面一起提供
  （`internal/plugin/page.go`）。本插件是 `page/icon.svg`。
- `magpie.icon`：**插件列表卡片**的图标，只能是 `https://` 或 `data:image/` 的 URI
  （`internal/plugin/market.go` 的 `ownIcon()`，上限 1.5 MiB）。本插件是
  `assets/icon.svg` 的 base64 data URI。

两个都要给，否则 Discover 的卡片是默认的拼图图标。

### 一个必须注意的检查盲区

社区仓库的 `scripts/check.mjs` 会**跳过**纯页面插件：

```go
if pkg.magpie?.page && !pkg.main && !pkg.exports) continue
```

但本插件**有** `main`（宿主部分），所以它不会被跳过，`check.mjs` 会真的加载
`index.mjs` 并检查它导出的函数。本插件导出的是 v1 形式
（`export default {id, server}`），`check.mjs` 对有 `magpie.page` 的包会把它当
页面宿主处理，不要求 `auth` 钩子，因此可以通过——但这一点要在提 PR 前实跑一次确认。

## 提 PR 前的自检清单

在本仓库里跑：

```sh
node --test test/*.test.mjs        # 7 项测试，含与 magpie usage 7d 的一致性校验
bun scripts/check.mjs <name>       # 社区仓库的检查脚本（提 PR 时在社区仓库里跑）
MAGPIE=/path/to/magpie scripts/try.sh <name>   # 沙箱 HOME 里真跑一遍
```

社区仓库的 `try.sh` 在沙箱 HOME（`.sandbox/<name>`）里跑 Magpie，不会碰你自己的
登录态和配置。

## 提 PR 的内容

1. `packages/page-usage-tree/`：本插件的 `package.json`、`index.mjs`、`lib/`、
   `page/`、`ui/`、`assets/`、`test/`。包名改为
   `@magpie-community/page-usage-tree`，`repository` 指向社区仓库的该目录。
2. `registry.json` 加一条：

```json
{
  "package": "@magpie-community/page-usage-tree",
  "name": "Account usage",
  "kind": "page",
  "community": true,
  "summary": {
    "en": "Usage as provider → account → model, each level expandable, with calls, tokens and cost. Reads your local usage ledger only.",
    "zh": "按供应商 → 账号 → 模型三层查看用量，逐层展开，含调用、token 与费用。只读取本地用量记录。"
  }
}
```

3. README 的 Pages 表格加一行。

## 发布后的版本流程

社区仓库的 `publish.yml` 会自动处理两件事：

- **dist**：每个包的新版本被打包到 `dist` 分支，Magpie 0.1.1243 之后在 npm
  没有该版本时从那里装。**新插件只要评审通过、合并即可生效，不等 npm。**
- **npm**：npm 上还没有的版本会被发布。首版不能走 trusted publishing（那要求包
  已存在，且设置 Trusted Publisher 需要 owner 的 2FA），需要社区 owner 用
  `sh scripts/owner.sh` 跑一次。

PR 的 `on-npm` 检查会提示某个包还没上 npm，**这不是阻塞合并的理由**。

## 独立发布（路线 A）的版本流程

自己发 npm 就是普通的：

```sh
npm version patch
npm publish
```

用户侧 `magpie plugin update` 会看到新版本。

## 发布前必须自查的功能风险

1. **端口**：默认 3488。服务只听 127.0.0.1，端口被占时插件会先确认占用者是不是
   自己，不是就报错。换个端口请用插件选项：

   ```sh
   magpie plugin options magpie-usage-tree '{"port": 3489}'
   ```

2. **加载**：页面默认加载「今天」。每个周期的聚合结果缓存在
   `~/.cache/magpie/usage-tree/<period>.json`。日志每次调用都会变，所以页面从不等
   一次读取：它立刻显示上一次读到的数字，服务在背后重读，页面随后自动跟上
   （实测首屏约 6ms）。点刷新会带 `fresh=1` 强制重读。

3. **只读**：插件只读 `magpie usage --csv` 的输出和 `usage.jsonl`，不读
   `logins.json`、`caller-keys.json` 等凭据文件，不上传任何数据。

4. **数字口径**：账号维度用 `provider_account`，账号名取 `providers.json` 的
   `accountNames`（和 Magpie 官方表格一致）；模型维度按 provider/model 汇总，
   `test/parity.test.mjs` 会与 `magpie usage 7d` 逐项比对。

## 建议顺序

1. 先按路线 A 发布到 npm，自己验证安装、升级、卸载。
2. 再提 PR 到社区仓库（路线 B），把名字改成
   `@magpie-community/page-usage-tree`，补 `registry.json` 条目。
3. 两条路线的包名不同也没关系：社区仓库里的那份是 npm 上的同一个包，社区的
   `dist` 分支会提供 npm 暂时还没有的版本。
