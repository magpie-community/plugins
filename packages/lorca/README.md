# @magpie-community/agent-lorca

Magpie 官方规范 Agent 插件：将 Magpie 统一网关、模型目录与共享 MCP 工具库无缝接入 [Lorca](https://lorca.app)。

通过本插件，Lorca 客户端中的「Magpie」自定义 Provider 将自动跟随 Magpie 统一路由走，无需手动配置接口地址、API Key 或繁琐的模型上下文参数；同时支持将 Magpie Library 的 MCP 工具直接同步给 Lorca。

---

## 核心特性

- **网关与模型同步**：自动将 Magpie 网关地址（`gateway.v1`）与 API Key 写入 Lorca 的凭据配置，并自动镜像 Magpie 当前的全部可用模型。
- **思维链 / 思考档位完整映射**：全面支持 Lorca 内核认可的全部 Thinking Levels（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`），并将 Magpie 的 `none` 自动映射为 `off`。
- **崩溃防护（对抗式枚举过滤）**：严格校验并过滤非法思考档位。由于 Lorca 遇到未知 level 时会直接抛弃整个 `custom` 配置段（导致所有自定义 Provider 消失），插件内置硬核过滤守卫，确保配置百分之百安全有效。
- **MCP 工具库打通（Magpie Library）**：支持 Lorca 的 Claude 格式 MCP 规范（`~/.lorca/mcp.json`），可通过 `magpie library sync` 一键将全局 MCP Server 分发给 Lorca。
- **流量精准归因（UA 识别）**：声明 `ua: ["lorca"]`，使 Lorca 发出的推理请求在 Magpie 监控面板与审计日志（`usage.jsonl`）中清晰归因，方便统计与调试。
- **原子级合并与纯净卸载**：采用 `merge: ["custom.custom:magpie"]` 对象级管理。连接时精准合并，断开或切换时整段彻底清理，绝不残留 `{}` 空壳对象，亦不破坏用户自建的其他 Provider。

---

## 快速上手

### 1. 安装插件

```sh
# 本地目录开发测试安装
magpie plugin add /path/to/magpie-plugin-lorca

# 或从 npm / Magpie 官方插件市场安装（发布后）
magpie plugin add @magpie-community/agent-lorca
```

### 2. 启用连接

```sh
# 将 Magpie 网关写入 Lorca 的 Provider 配置
magpie lorca provider magpie
```

> **注意**：Lorca 本地后台服务仅在启动初始化时读取一次 `~/.lorca/credentials.json`。配置写入后，请**彻底退出 Lorca 并重新打开**（若后台常驻，需确保完整重启应用），新 Provider 即可在界面中显示。

### 3. 断开连接

```sh
# 恢复默认状态，彻底卸载 Magpie Provider
magpie lorca default
```

Magpie 会自动执行原子卸载：如果该 Provider 是本次接管生成的，则完整移除；如果是接管前用户手建的同名配置，则逐字节还原，完全不干扰其他配置。

---

## MCP 工具库同步（Magpie Library）

插件声明了对 Lorca 原生 MCP 配置的托管支持：

```javascript
library: {
  mcp: "~/.lorca/mcp.json",
  mcpFormat: "claude"
}
```

你可以直接利用 Magpie 的 Library 能力，统一管理并分发 MCP 工具给 Lorca：

```sh
# 将指定的 MCP 服务分配给 Lorca
magpie library mcp agents <mcp-name> lorca

# 或者一键同步所有已分配的 MCP 服务到 ~/.lorca/mcp.json
magpie library sync
```

Lorca 读取 `~/.lorca/mcp.json`（标准 Claude Desktop 格式 `{"mcpServers": { ... }}`），即可在 Agent 会话与自动化流程中直接调用这些工具。

---

## 机制解析与写入格式

Lorca 的 Provider 凭证保存在 `~/.lorca/credentials.json`，自定义项置于 `custom` 字段下：

```json
{
  "custom": {
    "custom:magpie": {
      "name": "Magpie",
      "api": "chat-completions",
      "base_url": "http://127.0.0.1:3425/v1",
      "api_key": "magpie-lorca",
      "models": [
        {
          "id": "deepseek-v4.1-flash",
          "name": "DeepSeek V4.1 Flash",
          "context_window": 131072,
          "max_output": 8192,
          "images": true,
          "levels": ["off", "low", "medium", "high", "xhigh", "max"]
        }
      ],
      "created_at": 1794836955
    }
  }
}
```

### 字段转换规则

| Magpie 模型字段 | Lorca 模型字段 | 说明 |
| :--- | :--- | :--- |
| `id` | `id` | 模型标识（必填，缺失或非法的项自动跳过） |
| `name` | `name` | 模型显示名称 |
| `context` | `context_window` | 上下文窗口 Token 数（正数时写入） |
| `output` | `max_output` | 单次最大输出 Token 数（正数时写入） |
| `images` | `images` | 是否支持图片输入（布尔值） |
| `efforts` | `levels` | 思考档位映射（`none` 映射为 `off`，支持 `minimal/low/medium/high/xhigh/max`） |

> **关键技术内幕**：Lorca 采用强类型的反序列化机制。一旦 `levels` 数组中出现任意一个 Lorca 无法识别的字符串，或者 `models` 键缺失，Lorca 将拒绝加载整个 `custom` 对象，导致界面中所有自定义 Provider 同时失踪。本插件实现了严格的白名单校验与类型防御，杜绝此类隐患。

---

## 默认模型说明

- Lorca 将 `models` 列表中的**第一项**作为默认模型。
- 本插件写入时按照 Magpie 模型目录的推荐顺序排列。
- 如需在 Lorca 中切换默认模型，可直接在 Lorca 界面下拉菜单中选择，Lorca 会自动将所选模型调整到首位。

---

## 边界与注意事项

1. **配置重启生效**：Lorca 启动后会将 Provider 驻留内存，目前无动态热重载机制。更改配置后请务必重启 Lorca 应用。
2. **多模型管理隔离**：`custom:magpie` 下的模型列表由 Magpie 自动镜像。如果您希望在 Lorca 中使用完全自定义的模型列表且不被 Magpie 刷新，建议在 Lorca 界面中另建一个独立 Provider（同样填入 Magpie 网关地址 `http://127.0.0.1:3425/v1`），该条目将受到 Magpie 的永久避让保护。
3. **权限说明**：若首次由插件自动创建 `~/.lorca/credentials.json`，文件权限将遵循系统的 umask 规则（通常为 644 或 600）。

---

## 开发者调试

可以在隔离的临时沙箱中验证插件行为，不影响本机真实配置：

```sh
# 构造独立沙箱环境
sb=$(mktemp -d)
alias m="env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache magpie"

# 添加本地插件并测试连接
m plugin add .
m lorca provider magpie
cat "$sb/.lorca/credentials.json"

# 测试断开并验证清理效果
m lorca default
cat "$sb/.lorca/credentials.json"

# 清理沙箱
rm -rf "$sb"
```

---

## 许可证

本项目遵循 [MIT License](./LICENSE)。
