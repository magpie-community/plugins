# magpie-image-models

## 快速开始

安装一次插件，再登录要用的渠道：

```bash
magpie plugin add github:double2tea/magpie-image-models#v0.4.1
magpie plugin login image-models/rightimage
magpie plugin login image-models/twelveai
magpie plugin login image-models/wavespeed
```

发布版本固定在 `v0.4.1`。登录时 Magpie 只询问该渠道的 API Key，并沿用
Magpie 自己的凭据存储。插件不读取环境变量、Keychain、私有配置文件或本机
路径。只使用一个渠道时，只登录该渠道。

插件不附带共享账号、公共 Key 或免费额度。每个用户使用自己的供应商账号，
生成费用由对应账号结算；可用模型、地区限制、试用额度和支付方式以供应商
当前页面为准。

## 开通渠道

| Provider ID | 公开服务 | 开通方式 |
|---|---|---|
| `image-models/rightimage` | [Right Code](https://rightapi.io/register) | 注册并充值后，在控制台「令牌管理」创建绑定图片渠道的 API Key。接口域名是 `api.site`，`RightImage` 只是沿用旧 provider ID。 |
| `image-models/twelveai` | [12AI](https://new.12ai.org/register) | 注册、充值，然后在[令牌管理](https://new.12ai.org/console/token)创建 `sk-` Key。模型可用性取决于账号分组和当前站点目录。 |
| `image-models/wavespeed` | [WaveSpeedAI](https://wavespeed.ai/sign-in) | 登录后打开 [API Keys](https://wavespeed.ai/accesskey) 生成 `wsk_` Key；按实际任务用量结算。 |

登录命令只保存 Magpie 收到的 Key。它不会替用户注册、充值、领取试用额度或
切换供应商渠道。

开发时可直接安装当前目录：

```bash
magpie plugin add /absolute/path/to/magpie-image-models
```

## 使用

用普通图片工具，指定准确的 provider/model：

```bash
magpie tool generate_image \
  --model image-models/rightimage/gemini-nano-banana-2.1 \
  --size 2048x1152 "prompt"

magpie tool generate_image \
  --model image-models/twelveai/gpt-image-2.6-flare \
  --size 1536x1024 "prompt"

magpie tool generate_image \
  --model image-models/wavespeed/bytedance/seedream-v5.5 \
  --size 2048x1152 --reference_images /absolute/reference.png \
  "edit prompt"
```

## 结构

一个插件包，每个供应商一个 provider。它们共用请求解析、异步轮询、上传、
下载和标准 API Key 登录。`catalog.json` 是可读的模型能力清单，
`catalog.mjs` 将它同时用于 Magpie 模型注册和请求边界校验，避免模型名与
参数合同分叉。`null` 表示该边界尚未核实，不会据此拒绝请求。

能力清单区分文生图与编辑：带 `editModel` 的条目在收到参考图时转到对应编辑模型；`maxReferences` 是编辑模式可接受的参考图上限，`null` 表示尚未核实。

新增一个兼容的异步图片渠道通常只需要：

1. 在 `providers/` 增加一个供应商文件。
2. 在 `index.mjs` 增加一个导出。
3. 在 `catalog.json` 声明独立 provider ID、模型与已知能力。
4. 声明三项渠道函数：提交、查询、结果提取。

不替换已有 `rightimage`、`generation-service` 或 Magpie 默认图片路由。

Right Code 来源支持标准图片生成／编辑和 Gemini 原生接口，异步任务完成后统一返回图片。
JSON 与 multipart 参考图均由来源插件转换；Design 无需了解供应商协议。
目录内未知的参考图数量以 `null` 表示，不把“四张测试通过”写成供应商上限。

可在 Magpie 插件选项中通过 `models` 补充新模型或修正已核实的能力；`mode`
明确选择 `gemini` 或 `openai`，不通过模型名猜测协议。示例中的模型与数量仅作格式说明：

```json
{
  "baseURL": "https://your-provider.example/v1",
  "models": {
    "new-image-model": {
      "name": "New Image Model",
      "mode": "openai",
      "capabilities": { "generate": true, "edit": true, "maxReferences": 6 }
    }
  }
}
```

能力声明进入共享供应商配置，Design 桥接插件可自动读取参考图数量。
新接口协议仍须由来源插件实现；仅添加模型名不能证明接口兼容。
一个渠道的凭据或故障不会影响其他渠道。

从早期三个独立插件迁移时，重新安装本包并登录新 provider 即可：

| 早期 provider | 当前 provider |
|---|---|
| `rightimage-gemini` | `image-models/rightimage` |
| `twelveai-images` | `image-models/twelveai` |
| `wavespeed-images` | `image-models/wavespeed` |

## 验证边界

模型目录是当前可执行入口，不表示每个模型和参数组合都已实测。有限实测回执：

- `workspace/image-models-unified-20261113/`：统一包三个 provider 的真实生成。
- `workspace/magpie-async-image-plugins-20261112/`：文生图与单参考编辑及视觉边界。

`npm test` 覆盖 provider 注册、标准登录、缺登录 fail-closed，以及三个渠道的
请求映射、异步轮询、上传、下载和已知参数边界；它不提交真实生成，也不证明
供应商当前可用性。

异步任务在单次 Magpie 请求内轮询。进程中断后，插件没有持久化上游任务 ID，
因此不能自动恢复或重新提交；需要跨进程恢复的长任务应使用
`generation-service`。
