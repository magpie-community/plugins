# opencode-zg-embed-auth · 百炼 zg Embedding

一个 [magpie](https://usemagpie.ai) / OpenCode provider 插件：**接管 [zvec-grep（zg）](https://www.npmjs.com/package/@zvec/zvec-grep) 写死的全部 embedding 模型名，统一路由到你自己配置的一个上游模型**。默认上游是百炼（DashScope）的 `qwen3.7-text-embedding-flash`；换成任何 OpenAI 兼容服务或 DashScope 原生接口都行。改名在网关内部完成，不需要外部代理。

## 为什么需要它

zg 的远程 embedding 模型名是写死的（`qwen3.7-text-embedding`、`text-embedding-v4`、`qwen3-vl-embedding`），CLI、配置文件、授权三层都拒绝其他名字。而百炼上性价比更高的模型是 `qwen3.7-text-embedding-flash`——与 base **向量不兼容**（余弦相似度约 0.01–0.06），价格差 4 倍（base ¥0.5/M vs flash ¥0.125/M）。

本插件把三个名字的 **API id 全部声明为你配置的目标模型**，magpie 网关自动按目标名发上游。zg 照常发它的写死名，上游实际跑你选的模型，用量记账也在 magpie 里。

## 工作原理

```
zg 发任意写死名 ──→ 插件（三个名都声明，API id = 目标模型）──→ 你配的一个上游
                                                            endpoint + model + key
```

- **一份配置管全部**：`endpoint`（上游地址）＋ `model`（上游模型名），key 在签名时填。
- **协议自适应**：按 endpoint 路径自动识别——`/compatible-mode/…` 等按 OpenAI 兼容接口发；`/api/v1/…` 按 DashScope 原生多模态接口发。zg 的 vl 请求是原生形状，插件在两种形状之间双向翻译，**响应按调用方原格式返回**。也可用 `protocol` 显式指定。
- **向量兼容红利**：所有名字跑同一模型，zg 切换默认模型不再需要重建索引。

| zg 发送的名（写死） | zg 预期维度 | 单行上限 | 实际都跑去 |
| --- | --- | --- | --- |
| `qwen3.7-text-embedding` | 1024 | 128,000 token | 你配的目标模型 |
| `text-embedding-v4` | 1024 | 8,192 token | 同上 |
| `qwen3-vl-embedding` | 2560 | 32,000 token（多模态） | 同上 |

> ⚠️ **维度边界**：zg 按名字预期维度。把 vl 也路由到 1024 维模型时，vl 索引会维度不符——不用 vl 就没事；要用 vl，把目标配成 2560 维模型（如 `qwen3-vl-embedding`）。图片输入只有多模态模型能处理。

## 快速开始（5 步）

```sh
# 1. 装插件（首次添加插件时 magpie 会自动下载 Bun）
magpie plugin add github:Andykpa/zg-embed

# 2. 签名：填上游 API key（百炼 sk-…，或其他服务的 key）
magpie plugin login zg-bailian-embed
```

3\. 配置上游（默认＝公共百炼＋flash，可跳过）。在 magpie 应用 Plugins → 该插件 → Options 面板编辑，或：

```sh
magpie plugin options zg-embed '{"endpoint":"https://dashscope.aliyuncs.com/compatible-mode/v1","model":"qwen3.7-text-embedding-flash"}'
```

业务空间示例：`{"endpoint":"https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1","model":"qwen3.7-text-embedding-flash"}`

4\. 写 zg 全局配置 `~/.zvec-grep/config.json`：

```json
{
  "version": 1,
  "defaults": { "embedding": "qwen/qwen3.7-text-embedding" },
  "providers": { "qwen": { "apiKey": "magpie" } },
  "models": {
    "qwen/qwen3.7-text-embedding": {
      "endpoint": "http://127.0.0.1:3425/v1/embeddings"
    }
  }
}
```

endpoint 指向你那台 magpie 网关（默认端口 3425）。回环地址不校验入站 key，`apiKey` 填 `magpie` 即可；跨机器访问时填网关 key。

```sh
# 5. 每个要索引的工作区目录里授权（endpoint 必须与配置一致），然后建索引、检索
zg --auth grant --capability embedding --scope workspace --embedding qwen/qwen3.7-text-embedding --endpoint http://127.0.0.1:3425/v1/embeddings
zg --index
zg "网关如何转发请求"
```

也可以装本地文件夹：`magpie plugin add ./zg-embed`。在 OpenCode 里同样可用（OpenCode v1 provider 插件形状）。签名保存在 `~/.config/magpie/plugin-auth.json`（与 OpenCode 的 `auth.json` 同形，mode 600）。

## 日常使用

```sh
zg --index              # 增量索引（只处理新增/改动文件）
zg --index --rebuild    # 全量重建（换目标模型后必须）
zg "查询内容"            # 语义检索
zg "查询内容" --preview short   # 只看命中片段
zg --auth status        # 查看当前工作区授权
zg --server on          # 起守护进程（MCP 在 http://127.0.0.1:7999/mcp，供 agent 调用）
```

## 换模型 / 换端点 / 换 key

全部在一处：

```sh
# 换目标模型（例如跑 base）
magpie plugin options zg-embed '{"model":"qwen3.7-text-embedding"}'
# 换上游（例如别的 OpenAI 兼容服务）
magpie plugin options zg-embed '{"endpoint":"https://other.example.com/v1","model":"their-embed-model"}'
# DashScope 原生多模态接口（endpoint 含 /api/v1 自动识别，也可显式 protocol）
magpie plugin options zg-embed '{"endpoint":"https://dashscope.aliyuncs.com/api/v1","model":"qwen3-vl-embedding"}'
# 恢复默认（公共百炼 + flash）
magpie plugin options zg-embed off
# 换 key
magpie plugin login zg-bailian-embed
# 更新插件
magpie plugin update
```

（`zg-embed` 也可写包名 `opencode-zg-embed-auth`，以 `magpie plugin` 列表显示为准。宿主重载需几秒生效。）

> ⚠️ **换目标模型后，所有旧索引必须 `zg --index --rebuild`**——不同模型的向量互不兼容。zg 侧配置不用动（它只发写死名）。只换 key 或同模型换端点，索引不用重建。

**旧安装兼容**：v1.0 的签名 metadata（baseURL）和 `options.upstream` 仍被识别，升级后零改动继续跑；新配置优先。

## 三个坑（实测得出，务必读）

1. **同一上游不要再挂一个 key 供应商，且其模型目录里含 `qwen3.7-text-embedding`。**
   magpie 的 embeddings 通道按上游目录匹配裸名，那个 key 供应商会抢先截走裸名、按裸名发上游——结果跑的是 base：向量与 flash 索引不兼容，价格 4 倍。禁用模型、改供应商显示名都拦不住。
   *症状*：路由日志里该请求的 provider 不是 `zg-bailian-embed`。*修复*：移除那个 key 供应商（本插件就是它的替代品）。
2. **zg 的授权 grant 是追加，不是替换。** 换网关 endpoint 时先 `zg --auth revoke` 再 grant，否则旧条目排在前面被优先使用。
3. **网关 endpoint 还存在索引的 `manifest.json` 里**（`embeddingConfigs`）。换网关 endpoint 后旧索引要 `zg --index --rebuild`，否则检索仍按旧 endpoint 校验授权。

## 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `PERMISSION_DENIED … at http://…` | 授权或索引 manifest 里还是旧网关 endpoint | `zg --auth revoke` → 重新 grant；`zg --index --rebuild` |
| `404 magpie knows no model "qwen3.7-text-embedding"` | 插件没加载或被关 | `magpie plugin` 查看状态，`magpie plugin on <名>` |
| 检索质量骤降、怀疑跑错模型 | 裸名被别的 key 供应商截走跑了 base | 看路由日志的 provider；移除那个供应商（坑 1） |
| vl 索引维度报错 | 目标模型维度与 zg 预期（2560）不符 | 目标换成 2560 维模型，或不用 vl |
| 上游报模型不存在 | `model` 配的名字上游没有 | 核对上游模型目录；注意默认 flash 只在百炼有 |
| 用量费用显示偏贵 | 按请求名查公价（裸名=base 价） | `magpie model price`，见下节 |
| options 改了没生效 | 宿主重载需要几秒 | 稍等重试 |

## 用量显示说明

- 用量详情里的「发送模型」记的是**请求名**（zg 的写死名），不是实际发送名；实际发送名以目标模型为准（可用向量比对验证）。
- 费用默认按请求名查公开价：裸名在 models.dev 上对应 base 价，会高估。目标模型是默认 flash 时插件已声明 flash 公共价格；其他目标或业务空间计价不同：

```sh
magpie model price zg-bailian-embed/qwen3.7-text-embedding 0.018682,0,0,0
```

上游账单按实际跑的模型计，不受显示影响。

## 验证它真的跑了你配的模型

对网关发裸名请求，与直连上游目标模型的向量比余弦，应 ≈ 1（跑错模型的话约 0.05）：

```sh
curl -s http://127.0.0.1:3425/v1/embeddings -H 'content-type: application/json' -H 'authorization: Bearer magpie' -d '{"model":"qwen3.7-text-embedding","input":"你好世界"}'
```

路由日志在 `~/.config/magpie/routing/<日期>.jsonl`，用量在 `~/.config/magpie/usage.jsonl`。

## 卸载

```sh
magpie plugin rm zg-embed
```

zg 想继续用远程 embedding 的话，把 config 的 endpoint 改回 `https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings`、apiKey 填你的百炼 key，并重新授权＋重建索引。注意：直连时裸名跑的是 **base**（没有插件改名了）。

## 开发

```sh
node --test test/helpers.test.mjs   # 纯函数单元测试
```

沙箱测试（官方推荐，绝不碰生产 magpie）：独立 `HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`，`MAGPIE_ADDR=127.0.0.1:3499`（网关端口），然后 `magpie web --addr 127.0.0.1:3498 --gateway --no-open`（**网页端口必须与网关端口不同**，否则自转发死循环）、`magpie plugin add ./zg-embed`、`magpie plugin login zg-bailian-embed`。详见 [magpie 插件文档](https://usemagpie.ai/docs/plugins)。

## 许可证

MIT

---

# English

A [magpie](https://usemagpie.ai) / OpenCode provider plugin: **takes over every embedding name [zvec-grep (zg)](https://www.npmjs.com/package/@zvec/zvec-grep) hardcodes and routes them all to ONE upstream model you configure**. Defaults to Bailian (DashScope) `qwen3.7-text-embedding-flash`; any OpenAI-compatible service or DashScope's native API works. The rename happens inside the gateway — no external proxy.

**Why.** zg hardcodes its remote embedding names and refuses any other at CLI/config/auth level. On Bailian the cost-effective model is flash: vectors incompatible with base (cosine ≈ 0.01–0.06), price 4× lower. The plugin declares all three names' **API id** as your configured target; the gateway sends that upstream while zg keeps sending its hardcoded names.

**How.** One config: `endpoint` + `model` (Options panel or `magpie plugin options`), the key at sign-in. Protocol auto-detected from the endpoint path (`/compatible-mode/…` → OpenAI embeddings; `/api/v1/…` → DashScope native multimodal); zg's native-shaped vl bodies are translated both ways, each caller gets its own shape back. All names run the same model, so switching zg's default model no longer needs an index rebuild. **Dimension caveat:** zg expects 1024-d for the text names and 2560-d for vl — routing vl to a 1024-d model breaks vl indexing; point the target at a 2560-d model if you use vl.

**Quick start.**

```sh
magpie plugin add github:Andykpa/zg-embed
magpie plugin login zg-bailian-embed   # the upstream API key
magpie plugin options zg-embed '{"endpoint":"https://…/compatible-mode/v1","model":"qwen3.7-text-embedding-flash"}'   # optional; these are the defaults
```

Point `~/.zvec-grep/config.json` at your gateway (`models."qwen/qwen3.7-text-embedding".endpoint = http://127.0.0.1:3425/v1/embeddings`, `providers.qwen.apiKey = "magpie"` on loopback), then per workspace: `zg --auth grant --capability embedding --scope workspace --embedding qwen/qwen3.7-text-embedding --endpoint <same URL>`, and `zg --index` / `zg "query"`.

**Switching.** Everything in one place: `options.model` (target model), `options.endpoint` (upstream URL), `protocol` (explicit override), re-login for a new key, `magpie plugin update` for updates, `off` resets to defaults. **After changing the target model, `zg --index --rebuild` every index** — different models' vectors are incompatible. v1.0 sign-in metadata and `options.upstream` are still honored.

**Gotchas (field-tested).** (1) No other key provider on the same upstream whose catalog contains the bare name — it would intercept the request and run base; remove it. (2) zg grants are appended: revoke before re-granting. (3) The gateway endpoint is also in each index's `manifest.json`: rebuild after changing it.

**Usage display.** The "sent model" column logs the request name; costs are looked up by request name (bare name = base pricing). The plugin declares flash's public price when the target is the default; adjust with `magpie model price zg-bailian-embed/qwen3.7-text-embedding <in>,<out>,<cacheRead>,<cacheWrite>`. The upstream bills the model actually run.

MIT licensed. See the Chinese section above for full details.