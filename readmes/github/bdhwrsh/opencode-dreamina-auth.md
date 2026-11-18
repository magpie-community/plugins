# @magpie-community/opencode-dreamina-auth

将本机已安装的 [`dreamina-canvas`](https://jimeng.jianying.com/) CLI 接入 **Magpie** 与 **OpenCode**，提供 **Dreamina (即梦)** Provider（`dreamina`）。

## 接入能力

- **Provider**：`dreamina`（`Dreamina (即梦)`）
- **生图模型（Seedream 系列）**：`seedream_5.5`、`seedream_5.0_pro`、`seedream_5.0_lite`、`seedream_4.7`、`seedream_4.6`、`high_aes_general_v50_flash`、`jimeng_smart_image_v1`、`jm_image_model_gg_bp_21`、`jm_image_model_lib_s`、`jm_image_model_lib_f`，兼容 OpenAI `POST /images/generations` 与 `POST /images/edits`（支持 JSON 与 `multipart/form-data`，以及 `data:` URL、`https://` URL、`image`、`image[]`、`reference_images`）。
- **生视频模型（Seedance / Vidu / Wan / HappyHorse）**：`seedance_2.5`、`seedance_2.5_flash`、`seedance_2.0_vip`、`seedance_2.0_fast_vip`、`seedance_2.0_mini`、`seedance_pro_fast`、`dreamina_vidu_q3`、`dreamina_vidu_q2`、`wan_3.0`、`happyhorse_1.1`、`happyhorse_1.0`，兼容 OpenAI `POST /videos`、`GET /videos/{id}` 与 `GET /videos/{id}/content`。
- **在线模型发现**：自动调用 `dreamina-canvas model list --type image|video` 发现并校准可用模型、比例、分辨率大小写（如 `720p` 与 `720P`、`1.5K` 与 `2K`）与时长范围，CLI 不可用时回退内置目录。

## 前置条件

1. 本机需预先安装 **`dreamina-canvas` CLI**（本插件不自动下载或安装该二进制）。
2. 插件按以下顺序查找可执行文件：
   - 环境变量 `DREAMINA_CANVAS_BIN`
   - 系统 `PATH` 中的 `dreamina-canvas`
   - `~/.local/bin/dreamina-canvas`、`/opt/homebrew/bin/dreamina-canvas`、`/usr/local/bin/dreamina-canvas`

## 安装与加载

### 在 Magpie 中加载

- **本地路径加载**：在 Magpie 的插件管理中直接添加本仓库本地目录路径（读取 `package.json` 的 `exports["./server"]` → `./magpie.mjs`）。
- **包名加载**：安装或配置 `@magpie-community/opencode-dreamina-auth`。

### 在 OpenCode 中配置

```json
{
  "plugin": ["@magpie-community/opencode-dreamina-auth"]
}
```

## 登录方式

1. **使用本机已有 CLI 配置（默认 `default`）**：输入 `dreamina-canvas` 的 profile 名称（留空默认 `default`），插件通过 `auth status` 与 `auth account` 校验登录态。
2. **即梦浏览器登录**：可选填写 profile 名称（默认 `default`），插件调用 `auth login` 返回设备授权链接，并在后台通过 `auth wait --device-code` 等待授权完成。

## 在 Agent 中使用（生图 / 生视频）

1. **常规对话模型 + `magpie-image` MCP 工具（推荐）**：在 Magpie 的 `Settings → Models → Images / Video` 选择 `dreamina` 模型，并在 `Library → MCP servers` 中为目标 Agent 勾选 `magpie-image`，Agent 即可自动调用 `generate_image`、`generate_video` 与 `generation_result`。
2. **直选即梦模型对话（默认先报价后确认）**：直接选择即梦模型发送提示词时，插件先创建草稿并调用 `node quote` 返回预估积分（0 扣费）；回复 `确认生成：<提示词>`（或带 `--confirm`）后才执行扣费生成。同时支持 Magpie「测试模型」（0 积分连通性检测）。

## 额度展示与积分防误扣费

- **Logo 与菜单栏额度展示**：Magpie 供应商列表与菜单栏会展示官方产品 Logo、会员等级（来自 `auth account`）与点数状态。
- **点数余额与按次扣减**：因为 `dreamina-canvas` CLI 暂不直接返回云端总余额，登录时可选填当前点数余额（或设置环境变量 `DREAMINA_CREDITS_BALANCE`），之后每次生成会自动按次扣减并显示剩余点数进度；留空则显示今日已用与上限保护状态（若 CLI 返回余额字段会自动优先采用）。
- **每次生成先询价**：先保存画布节点并调用 `node quote` 询价，校验通过后才在内存中持有短期 `creditConfirmationToken` 调用 `node confirm` 与 `node run`（令牌与临时下载链接绝不落盘、不写入日志）。

可在 Magpie Provider 设置中切换以下开关：

- **仅报价（不扣积分）`quote_only`（默认关闭 `false`）**：只询价并返回 HTTP `403` 与预估 `totalMaxCredits`，不执行生成（单次请求也可在请求体传 `"quote_only": true`）。
- **单次 200 点上限保护 `credit_guard`（默认开启 `true`）**：当 `totalMaxCredits` 超过上限（默认 `200` 点）时返回 HTTP `403` 并阻止运行；可通过请求体 `credit_ceiling` 或环境变量 `DREAMINA_CREDIT_CEILING` 覆盖上限。

## 本地状态与测试

- 画布绑定（每个 profile 独立维护 `"Magpie Gateway"` 画布 `projectId`）与视频任务索引保存在 `<directory>/dreamina-canvas-state.json`（权限 `0o600`，目录不可写时回退至系统临时目录）。
- 运行单元测试（纯 Mock CLI，不触发真实扣费）：

```bash
bun test
```
