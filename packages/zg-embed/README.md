# zg-embed · 百炼 zg Embedding

让 [zvec-grep（zg）](https://www.npmjs.com/package/@zvec/zvec-grep) 通过 magpie / OpenCode 直接使用阿里云百炼（DashScope）的 embedding 模型，**改名在网关内部完成，不需要外部代理**。用你的百炼 API key 签名，公共百炼或自定义业务空间端点均可。

源码与更新记录：[Andykpa/zg-embed](https://github.com/Andykpa/zg-embed)。

## 为什么需要它

zg 的远程 embedding 模型名是写死的：它只会发送 `qwen3.7-text-embedding`。而百炼上性价比更高的模型是 `qwen3.7-text-embedding-flash`——两者**向量不兼容**（余弦相似度约 0.01–0.06），价格差 4 倍（base ¥0.5/M vs flash ¥0.125/M）。zg 的 CLI、配置文件、授权三层都拒绝 flash 名，所以必须有一层改名。

本插件把名为 `qwen3.7-text-embedding` 的模型的 **API id 声明为 flash**，magpie 网关自动按 API id 发给上游。zg 照常发裸名，上游实际跑 flash，用量记账也在 magpie 里。

## 模型桥接

| zg 发送的名（写死） | 默认上游 API id | 默认维度 | 单行上限 | 批量上限 |
| --- | --- | --- | --- | --- |
| `qwen3.7-text-embedding` | `qwen3.7-text-embedding-flash` | 1024 | 128,000 token | 20 行 |
| `text-embedding-v4` | `text-embedding-v4` | 1024 | 8,192 token | 10 行 |
| `qwen3-vl-embedding` | `qwen3-vl-embedding` | 2560 | 32,000 token | 多模态 |

- 前两个走 OpenAI 兼容接口（`/compatible-mode/v1/embeddings`）。
- `qwen3-vl-embedding` 走 DashScope **原生多模态接口**（请求/响应形状都不同）：zg 发来的原生请求体原样转发；其他 agent 发来的 OpenAI 形状请求由插件双向翻译。
- 上游名可用 options 覆盖（见「换模型」）。

## 安装与签名

magpie：

```sh
magpie plugin add @magpie-community/opencode-zg-embed-auth
magpie plugin login zg-bailian-embed
```

OpenCode（`opencode.json`）：

```json
{ "plugin": ["@magpie-community/opencode-zg-embed-auth"] }
```

然后 `opencode auth login`。

签名会问两件事：

1. **端点**：
   - *Public DashScope / 公共百炼*：`https://dashscope.aliyuncs.com/compatible-mode/v1`，任何百炼 key 可用；
   - *Custom workspace / 自定义业务空间*：形如 `https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1`，配该业务空间的专属 key。
2. **百炼 API key**（`sk-…`）。

签名保存在 `~/.config/magpie/plugin-auth.json`（与 OpenCode 的 `auth.json` 同形，mode 600）。换 key：重新 login。

## zg 侧配置（每台机器）

`~/.zvec-grep/config.json`：

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

endpoint 指向你那台 magpie 网关（默认端口 3425）。回环地址不校验入站 key，`apiKey` 填 `magpie` 即可；跨机器访问时填网关 key。然后在每个要索引的工作区目录里：

```sh
zg --auth grant --capability embedding --scope workspace --embedding qwen/qwen3.7-text-embedding --endpoint http://127.0.0.1:3425/v1/embeddings
zg --index
zg "网关如何转发请求"
```

日常：`zg --index`（增量）、`zg --index --rebuild`（全量）、`zg --auth status`、`zg --server on`（MCP 守护进程）。

## 换模型 / 换端点 / 换 key

### A. 换裸名跑的上游模型（flash → base，或将来的新模型）

```sh
magpie plugin options zg-embed '{"upstream":{"qwen3.7-text-embedding":"qwen3.7-text-embedding"}}'
magpie plugin options zg-embed off   # 恢复默认（flash）
```

（名字以 `magpie plugin` 列表显示为准；宿主重载需几秒生效。）

> ⚠️ **不同模型的向量互不兼容。** 换上游后，所有旧索引必须 `zg --index --rebuild`，否则检索结果是乱的。zg 侧配置不用动（它只发裸名）。

### B. 让 zg 改用 v4 或 vl

改 `defaults.embedding`（如 `qwen/text-embedding-v4`），在 `models` 里加同名 endpoint 条目，工作区里先 `zg --auth revoke` 再按新模型 grant，最后 `zg --index --embedding qwen/text-embedding-v4 --rebuild`。vl 同理（2560 维，支持图片/视频）。**每个工作区索引绑定一个模型，换模型必须重建。**

### C. 换端点（公共百炼 ↔ 业务空间）

- 插件侧：重新 login 选新端点；或 `magpie plugin options zg-embed '{"endpoint":"https://…/compatible-mode/v1"}'`（优先于签名时的选择，作用于所有账号）。
- zg 侧：**只有网关地址变了才需要动**——改 config 的 endpoint，然后每个工作区 revoke → grant → rebuild（见「三个坑」）。只换上游端点、网关地址不变的话，zg 侧零改动。

### D. 更新

`magpie plugin update`。

## 三个坑（实测得出，务必读）

1. **同一上游不要再挂一个 key 供应商，且其模型目录里含 `qwen3.7-text-embedding`。**
   magpie 的 embeddings 通道按上游目录匹配裸名，那个 key 供应商会抢先截走裸名、按裸名发上游——结果跑的是 base：向量与 flash 索引不兼容，价格 4 倍。禁用模型、改供应商显示名都拦不住。
   *症状*：路由日志里该请求的 provider 不是 `zg-bailian-embed`。*修复*：移除那个 key 供应商（本插件就是它的替代品）。
2. **zg 的授权 grant 是追加，不是替换。** 换 endpoint 时先 `zg --auth revoke` 再 grant，否则旧条目排在前面被优先使用。
3. **endpoint 还存在索引的 `manifest.json` 里**（`embeddingConfigs`）。换 endpoint 后旧索引要 `zg --index --rebuild`，否则检索仍按旧 endpoint 校验授权。

## 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `PERMISSION_DENIED … at http://…` | 授权或索引 manifest 里还是旧 endpoint | revoke → 重新 grant；rebuild |
| `404 magpie knows no model "qwen3.7-text-embedding"` | 插件没加载或被关 | `magpie plugin` 查看，`magpie plugin on <名>` |
| 检索质量骤降、怀疑跑错模型 | 裸名被别的 key 供应商截走跑了 base | 看路由日志的 provider；移除那个供应商（坑 1） |
| 用量费用显示偏贵 | 按请求名查公价（裸名=base 价） | `magpie model price`，见下节 |
| options 改了没生效 | 宿主重载需要几秒 | 稍等重试 |

## 用量显示说明

- 用量详情里的「发送模型」记的是**请求名**（裸名），不是实际发送名；实际发送名以 API id 为准（可用向量比对验证）。
- 费用默认按请求名查公开价：裸名在 models.dev 上对应 base 价，会高估。本插件已为桥接模型声明 flash 的公共价格；若你的业务空间计价不同：

```sh
magpie model price zg-bailian-embed/qwen3.7-text-embedding 0.018682,0,0,0
```

百炼账单按实际跑的模型计，不受显示影响。

## 验证它真的跑了 flash

对网关发裸名请求，与直连百炼 flash 的向量比余弦，应 ≈ 1（base 的话约 0.05）：

```sh
curl -s http://127.0.0.1:3425/v1/embeddings -H 'content-type: application/json' -H 'authorization: Bearer magpie' -d '{"model":"qwen3.7-text-embedding","input":"你好世界"}'
```

## 卸载

`magpie plugin rm zg-embed`。zg 想继续用远程 embedding 的话，把 endpoint 改回 `https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings`、apiKey 填百炼 key，重新授权＋重建索引。注意：直连时裸名跑的是 **base**（没有插件改名了）。

## 测试

```sh
bun test   # 本包目录内：纯函数＋config/auth/fetch 钩子（含 vl 双向翻译），不发真实请求
```

实测记录（2026-11-24，真实百炼上游）：裸名经网关与直连 flash 向量 cosine=1.0；v4、vl（原生体透传＋OpenAI 形状翻译）均 200；options 覆盖/恢复正常。

---

# English

Lets [zvec-grep (zg)](https://www.npmjs.com/package/@zvec/zvec-grep) use Alibaba Bailian (DashScope) embedding models through magpie / OpenCode — **the model rename happens inside the gateway, no external proxy**. Signs in with your Bailian API key; public DashScope or a custom workspace endpoint. Source: [Andykpa/zg-embed](https://github.com/Andykpa/zg-embed).

**Why.** zg hardcodes the remote embedding name `qwen3.7-text-embedding`, but the cost-effective Bailian model is `qwen3.7-text-embedding-flash`. Their vectors are incompatible (cosine ≈ 0.01–0.06) and prices differ 4×. This plugin declares the model's **API id** as flash; the gateway sends flash upstream while zg keeps sending the bare name.

**Bridges.** `qwen3.7-text-embedding` → `qwen3.7-text-embedding-flash` (1024-d, 128K); `text-embedding-v4` → itself (1024-d, 8K); `qwen3-vl-embedding` → itself via DashScope's native multimodal API (2560-d; native bodies pass through, OpenAI-shaped bodies are translated both ways).

**Install & sign in.** `magpie plugin add @magpie-community/opencode-zg-embed-auth`, then `magpie plugin login zg-bailian-embed` (pick public DashScope or a custom workspace URL, then the sk- key). In OpenCode: `{ "plugin": ["@magpie-community/opencode-zg-embed-auth"] }` and `opencode auth login`.

**zg config.** Point `~/.zvec-grep/config.json` at your gateway (`models."qwen/qwen3.7-text-embedding".endpoint = http://127.0.0.1:3425/v1/embeddings`, `providers.qwen.apiKey = "magpie"` on loopback), then per workspace: `zg --auth grant --capability embedding --scope workspace --embedding qwen/qwen3.7-text-embedding --endpoint <same URL>`, and `zg --index` / `zg "query"`.

**Switching models.** Upstream of the bare name: `magpie plugin options zg-embed '{"upstream":{"qwen3.7-text-embedding":"<model-id>"}}'`; `off` resets. **Vectors of different models are incompatible — `zg --index --rebuild` every existing index afterwards.** zg using v4/vl: change `defaults.embedding`, add the endpoint entry, re-grant, rebuild. Endpoint: re-login or `options.endpoint`; zg-side changes only when the gateway address changes.

**Gotchas (field-tested).** (1) No other key provider on the same upstream whose catalog contains the bare name — it would intercept the request and run base; remove it. (2) zg grants are appended: revoke before re-granting. (3) The endpoint is also in each index's `manifest.json`: rebuild after changing it.

**Usage display.** The "sent model" column logs the request name; costs are looked up by request name (bare name = base pricing). The plugin declares flash's public price; adjust with `magpie model price zg-bailian-embed/qwen3.7-text-embedding <in>,<out>,<cacheRead>,<cacheWrite>`. Bailian bills the model actually run.

MIT licensed. See the Chinese section above for full details.