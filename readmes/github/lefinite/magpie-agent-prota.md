# Prota · Magpie Agent plugin

![Prota](./icon.svg)

在 Magpie 的 Agents 页面为 **Prota** 选择模型，将连接配置交给本机 Prota。
独立插件，零运行时依赖，无需构建，不读取 Prota 项目代码或工作区。

**兼容范围：需要 Prota 实现 Magpie Bridge 并读取下述配置契约。** 安装插件只负责注册 Agent 和生成配置，不会给已有 Prota 自动增加模型菜单、follow/pinned 会话绑定或热切换能力。

## 安装

需要支持 [Agent plugins](https://usemagpie.ai/docs/plugins#agent-plugins) 的 Magpie。已用 Magpie **0.1.2685** CLI 宿主完成隔离测试。

```sh
magpie plugin add github:lefinite/magpie-agent-prota
```

也可以克隆后按目录安装：

```sh
git clone https://github.com/lefinite/magpie-agent-prota.git
magpie plugin add ./magpie-agent-prota
```

Prota 安装目录检测使用 `~/.config/prota`。如果尚未运行过 Prota，该目录不存在时可先启动 Prota；仅为试用插件也可手动创建目录。然后在 **Agents → Prota** 选择模型或路由组，或使用 CLI：

```sh
magpie models prota
magpie prota <provider/model>
```

将 `<provider/model>` 替换成模型列表中的真实 ID，路由组保留完整 `group/<id>`。

## 配置契约

Magpie 管理固定文件 `~/.config/prota/magpie-agent.json`，与 Prota 的工作区、源码位置、`READIFY_CONFIG_DIR` 无关。Prota Bridge 必须始终读取此固定锚点。示例中的地址和 key 仅是格式示意，真实值由 Magpie 提供：

```json
{
  "model": "provider/model",
  "managedBy": "magpie",
  "provider": "magpie",
  "apiType": "openai-responses",
  "baseURL": "http://127.0.0.1:3425/v1",
  "apiKey": "<agent-specific gateway key from Magpie>"
}
```

- `model` 由 Magpie 的 `agent.model` 机制写入，插件不拼接或改写 ID。
- `connect` 只返回其余五个字段；Magpie 负责逐字段写入、备份和恢复，保留其他设置。
- 协议按模型 `native_endpoints` 选择：Responses → Anthropic Messages → Chat Completions。Messages 使用网关根地址，其他使用 `/v1`。
- 路由组、Gemini 原生端点或未知元数据使用 Magpie 的 Responses 转换入口；这不是直接调用上游，也不是切换到其他模型。真实模型的工具、图片、思考和流式兼容性需由 Prota Bridge 联调验证。
- 仅接受 `http://127.0.0.1[:port]` / `http://[::1][:port]` 本机网关，拒绝远程地址和缺失 key。
- `apiKey` 是 Magpie 给 Prota 的本机网关 key，不是订阅登录 token。不要提交、展示或分享此文件。插件没有文件系统 API，文件权限由 Magpie 宿主管理；实测 0.1.2685 新文件使用 `0644`，不能声称自动限制为当前用户。多用户机器应将父目录限制为 `0700`（见下文），Prota Bridge 还应检查权限和内容，且不能原样返回 key 给前端。
- 无网络、命令执行、账号读取、Prota Prompt/Skill/MCP 或普通 Pi 配置修改。

### 本机文件权限

宿主负责写文件，纯 Agent 插件无法自行 chmod。安装前或首次选择模型后限制目录权限，避免同机其他用户读取网关 key：

```sh
mkdir -p ~/.config/prota
chmod 700 ~/.config/prota
# 文件生成后也可限制文件本身
chmod 600 ~/.config/prota/magpie-agent.json
```

## 停用与卸载

```sh
magpie prota default
# 或停用整个插件
magpie plugin off magpie-agent-prota
# 或卸载
magpie plugin rm magpie-agent-prota
```

Magpie 恢复各受管字段原先的值，移除原本不存在的字段。配置文件本身可能保留。Prota Bridge 应以有效 `managedBy` 和实际网关状态判断是否托管，不能只检查文件存在。

## 开发与验证

```sh
npm test
npm run test:host  # 需要本机 magpie CLI；缺失时明确失败
npm pack --dry-run
```

单元测试检查协议选择、非法输入、纯 JavaScript 宿主兼容。真实 CLI 测试使用临时 HOME / XDG 目录和虚构的本机服务商，禁止发现真实账号，验证注册、三种协议、精确模型/路由组 ID、切换及恢复。测试不发起模型请求、不验证订阅可用性，也不宣称 Prota 产品集成已经完成。普通 CI 只跑单元测试与打包检查。

## GitHub 自动发现

仓库根目录包含 `package.json`，并设置 GitHub topic `magpie-plugin`。按 [Magpie 官方发现规则](https://usemagpie.ai/docs/plugins#publishing-and-listing)，公开仓库可出现在 **Plugins → Discover → Unofficial, on GitHub**，索引及刷新可能有延迟。这不等于官方审核或 community registry 收录；无需 npm 发布即可从 GitHub 安装。

## English

This standalone, dependency-free Agent plugin registers Prota in Magpie and writes a fixed local bridge contract at `~/.config/prota/magpie-agent.json`. Install with `magpie plugin add github:lefinite/magpie-agent-prota`, then select a model in Agents → Prota. Magpie owns model IDs, per-agent gateway keys, field backups and restoration. The plugin supports local loopback gateways only and never reads subscription credentials or Prota workspaces.

**A Prota release implementing the Magpie Bridge is required to consume this file.** The plugin alone does not add session following, model menus or live switching to existing Prota installations. Host tests use isolated fake providers and make no inference requests. Disable with `magpie plugin off magpie-agent-prota` or remove with `magpie plugin rm magpie-agent-prota` to restore original settings.

MIT · [Prota](https://github.com/lefinite/Prota) · [Magpie plugin documentation](https://usemagpie.ai/docs/plugins)
