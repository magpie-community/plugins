# magpie-comfyui-link

[English](https://unpkg.com/magpie-comfyui-link@0.2.0/README.en.md) · [MIT](https://unpkg.com/magpie-comfyui-link@0.2.0/LICENSE)

![magpie-comfyui-link](https://unpkg.com/magpie-comfyui-link@0.2.0/assets/readme-hero.png)

ComfyUI 的 Magpie 工具插件，让 AI Agent 读取模型与节点、提交工作流、查询任务并获取生成图片。支持多个独立的 ComfyUI 连接。

通过 Magpie 集中配置和分发 ComfyUI 工具，让不同 Agent 接入同一套能力，减少逐个配置连接和认证的工作。

## 使用场景

- **多个 Agent 共用 ComfyUI**：在 Magpie 中维护连接，各个 Agent 接入 Magpie 的工具入口，即可发现资源、提交任务和获取图片。
- **操作多台 ComfyUI**：按连接名称选择目标实例，使用该实例的模型和节点，任务查询与取图也指向同一实例。
- **用自然语言发起生图**：Agent 先读取可用资源，再编写并提交工作流，完成后取回图片。例如：

  > 查看 studio 上的模型和节点，生成一张窗边人像，完成后取回图片。

## 安装

通过 Magpie 安装插件：

```sh
magpie plugin add magpie-comfyui-link
```

## 配置

从 Magpie 左侧进入 **设置**，选择顶部的 **插件** 标签，在 **ComfyUI 连接** 面板中添加、编辑或删除连接，点击“保存”生效。每条连接填写名称和 ComfyUI 地址；需要认证时展开“认证（可选）”。

也可以使用 Magpie 的插件选项设置连接：

```sh
magpie plugin options magpie-comfyui-link '{
  "connections": {
    "studio": { "server": "https://comfy-a.example.com" },
    "render": { "server": "https://comfy-b.example.com" }
  }
}'
```

`studio` 和 `render` 是自定义连接名称。将示例地址替换为实际 ComfyUI 服务地址；单实例只需配置一项。修改配置时需保留仍要使用的连接。

每条连接支持以下字段：

| 字段 | 说明 |
| --- | --- |
| `server` | 必填，ComfyUI 的 HTTP(S) 服务地址。 |
| `token_env` | 可选，Magpie 进程中保存 Bearer token 的环境变量名。 |
| `user` | 可选，ComfyUI 多用户模式的用户 ID。 |

## 使用

Agent 通过 Magpie 统一的插件工具入口（MCP）调用下列工具。已接入该入口的 Agent 无需为本插件另行添加 MCP 服务。

| 工具 | 功能 |
| --- | --- |
| `resources` | 发现连接、模型文件和节点定义，读取服务状态与队列。 |
| `submit` | 提交原生 ComfyUI API 工作流，返回任务 ID。 |
| `history` | 查询任务进度和输出文件。 |
| `view` | 获取图片，返回 MIME 类型和原图 base64 数据。 |

Agent 根据资源信息编写工作流，提交后查询任务并取回图片。一次任务的所有调用使用相同的 `connection`，即配置中的连接名称。工作流由 ComfyUI 执行。

提交结果未确认时，应先查询原连接的队列与历史，避免重复生成。插件当前将单次响应限制为 16 MiB，超限会返回错误；这是插件的传输限制，不是 ComfyUI 的图片生成限制。
