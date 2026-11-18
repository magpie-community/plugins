# magpie-ark

一个 magpie provider 插件：把**火山方舟（Volcengine Ark）**接成独立的 provider，
并修掉上游 [yetone/magpie#5338](https://github.com/yetone/magpie/issues/5338)——
**Agent Plan Team（团队版）的额度属于席位**，内置 provider 只调 `ark:GetAFPUsage`，
Ark 对团队账号返回 `403 AccessDenied`，额度卡一直为空。

取数路径（与内置 provider 的差别就在这一支）：

1. `GetSeatInfo`（`{"ProjectName":"default","Scene":"agent_plan_enterprise"}`）→ `SeatID`；
2. `GetAgentPlanSeatAFPUsage`（`{"SeatIDs":["seat-…"]}`）→ 席位窗口；
3. 没有席位（个人计划）才回退 `GetAFPUsage`；Coding Plan 仍走 `GetCodingPlanUsage`。

控制面请求按 Volcengine 的 SigV4 签名（与官方 SDK 的 `GetSignRequest` 逐字节一致），
AccessKey 只发往 `open.volcengineapi.com`；数据面请求（chat / responses）用账号的
Ark API key，走所选 endpoint。

## 安装

```sh
magpie plugin add github:hzk8000/magpie-ark
magpie plugin login ark
```

装了 npm 版本（发布后）也可以 `magpie plugin add magpie-ark`。仓库带
`magpie-plugin` 话题，会在 magpie Plugins 页的“GitHub 上标记的插件”（未审核）里出现。

登录要填：

| 问题 | 说明 |
| --- | --- |
| Ark API key | 数据面用，`ark-` 开头，保存在 provider 账号的 key |
| Endpoint | Agent Plan（默认）/ Coding Plan / Pay as you go |
| AccessKey ID / Secret | 控制面取额度用，只发往 `open.volcengineapi.com`；不填则额度卡只提示补全 |
| Region | 默认 `cn-beijing`，也可从 endpoint 推断 |

登录后在 Usage 页看到「火山方舟（自建）」卡片，`plan` 形如 `Agent Plan medium`，
窗口为 `5 hours` / `Weekly` / `Month`；`magpie quota ark` 也能读。

## 模型

provider id 是 `ark`，模型 id 与内置 provider 一致（`deepseek-v4-1-flash-261017`、
`kimi-k3`、`glm-5-3` 等 8 个），可在 provider 编辑器里增删。所有模型声明
`also: @ai-sdk/openai`，Agents 用 Responses 时同样走插件的 fetch。

## 测试

```sh
node --test test/usage.test.mjs
```

覆盖席位分支、个人计划回退、`AFPDaily` 不展示、仅百分比回复、Coding Plan、
pay-as-you-go 不发请求、缺凭据、控制面拒绝，以及签名与 Volcengine SDK 的
`GetSignRequest` 一致（用 SDK 生成的向量）。

`MAGPIE_ARK_CONTROL_PLANE` 是测试 seam：设成 http URL 时控制面请求发往该地址
（本地 mock 联调），默认空值即真实控制面。

## 模型要选套餐支持的

默认模型列表与内置 provider 一致，但方舟会按套餐拒绝不支持的模型（例如团队版 Agent Plan
返回 `UnsupportedModel: The requested model does not support the agent plan feature`）。
在 provider 编辑器里删掉套餐不支持的 id 即可；`ark/glm-5-3-flash`、`deepseek-v4-1-flash-*`
在当前的团队版 Medium 上实测可用。

## 发布（维护者）

```sh
npm login --registry https://registry.npmjs.org
npm publish --registry https://registry.npmjs.org --access public
```

或推送 `v*` 标签，让 `.github/workflows/publish.yml` 发（需要仓库 secret `NPM_TOKEN`）。
发布后 tagged 列表会改用 npm spec，社区审核区（`magpie-community/plugins` 的
`registry.json`）才收——它只列 npm 包。

## 限额

插件只声明 Chat 与 Responses 两种 API；Anthropic messages（`/api/plan`）没有接入。
非官方插件，与火山引擎、magpie 上游均无隶属关系。
