# @magpie-community/opencode-doubao-free-auth

OpenCode & Magpie provider plugin for **Doubao (豆包)** free models.

为 Magpie (OpenCode) 客户端提供字节跳动豆包免费模型的接入支持。支持直连自建的 `doubao-free-api` 逆向网关服务，或直接输入豆包网页端凭证。

---

## 特性

- **开箱即用**：内置豆包主力模型定义（`doubao-pro-32k`、`doubao-pro-128k`、`doubao-lite-32k`、`doubao-lite-128k`、`doubao-vision-pro-32k`）。
- **标准协议支持**：基于 `@ai-sdk/openai-compatible`，完整支持流式输出（打字机效果）与模型对话。
- **贴心诊断**：若本地未启动网关服务或凭据过期，提供友好的中文错误与指引，避免黑盒报错。
- **零成本体验**：无需购买官方付费 API，直接利用社区开源的免费逆向网关。

---

## 快速使用

### 1. 准备豆包反代服务（推荐）

推荐在本地运行开源的 `doubao-free-api` Docker 容器：

```bash
docker run -d \
  --name doubao-free-api \
  -p 8000:8000 \
  -e TZ=Asia/Shanghai \
  ghcr.io/llm-red-team/doubao-free-api:latest
```

> **获取网页端 SessionID**：
> 1. 打开浏览器登录 [doubao.com](https://www.doubao.com/)；
> 2. 按 F12 打开开发者工具，进入 **Application** -> **Cookies**；
> 3. 找到并复制 `sessionid` 的值。

### 2. 在 Magpie 中安装与配置

#### 本地调试加载
打开 Magpie 的插件配置文件 `~/.config/magpie/plugins.json`，添加本地路径：

```json
{
  "plugins": [
    {
      "spec": "/绝对路径/packages/doubao-free"
    }
  ]
}
```

重启 Magpie 后，在模型提供商列表或授权设置中选择 **Doubao Free (豆包)**，填入：
- **Base URL**: `http://127.0.0.1:8000/v1`（默认）
- **API Key**: 留空或填入你的凭据

---

## 支持的模型列表

| 模型 ID | 模型名称 | 上下文大小 | 最大输出 |
| :--- | :--- | :--- | :--- |
| `doubao-pro-32k` | Doubao Pro 32k | 32,768 tokens | 4,096 tokens |
| `doubao-pro-128k` | Doubao Pro 128k | 128,000 tokens | 4,096 tokens |
| `doubao-lite-32k` | Doubao Lite 32k | 32,768 tokens | 4,096 tokens |
| `doubao-lite-128k` | Doubao Lite 128k | 128,000 tokens | 4,096 tokens |
| `doubao-vision-pro-32k` | Doubao Vision Pro 32k | 32,768 tokens | 4,096 tokens |

---

## 提交到 Magpie 社区

欢迎将此包合并到官方社区插件仓库：

1. Fork [magpie-community/plugins](https://github.com/magpie-community/plugins)
2. 将本目录完整复制到仓库根目录的 `packages/doubao-free` 下
3. 在根目录执行 `bun install` / `pnpm install` 确保依赖正常
4. 提交 Commit 并向 `main` 分支发起 Pull Request (PR)

---

## License

MIT
