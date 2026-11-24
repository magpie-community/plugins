# OpenAI API Credits for Magpie

在 Magpie 的「用量」页查看 OpenAI Platform 组织的实际美元余额和下一笔点数到期时间。插件查询账单页使用的 `credit_grants` 接口，余额取自 OpenAI 返回的 `total_available`。

## 安装

已在 macOS 上验证 Magpie **0.1.4735**。可从 GitHub 安装：

```sh
magpie plugin add 'github:NoctisWang528/magpie-openai-api-credit#v0.1.2'
```

如需从本地目录加载：

```sh
git clone https://github.com/NoctisWang528/magpie-openai-api-credit.git
magpie plugin add "$PWD/magpie-openai-api-credit"
```

也可以在 Magpie 的「插件 → 添加插件」里填入仓库地址或本地目录。

## 配置与查看余额

1. 登录 [OpenAI Platform 账单页](https://platform.openai.com/settings/organization/billing/overview)，切换到要监控的组织。
2. 打开浏览器开发者工具的 **Network** 面板，刷新账单页并找到 `credit_grants` 请求。在 **Request Headers** 里复制 `Authorization` 和 `OpenAI-Organization` 的值。
3. 在 Magpie 的插件列表为 **OpenAI API Credits** 登录，或运行 `magpie plugin login openai-api-credit`。依次粘贴 Platform Session Bearer Token 和 Organization ID。Token 可包含 `Bearer` 前缀。两个输入框都使用遮罩，Magpie 会向 OpenAI 验证凭证后再保存。
4. 在「用量」页查看额度卡，或运行：

   ```sh
   magpie quota openai-api-credit
   magpie quota refresh openai-api-credit
   ```

额度卡沿用 Magpie 的自动刷新和手动刷新机制。卡片的账户行显示仍可用点数中最早的已知到期日，悬停可看本地时间。当点数批次能与余额对账时，也会显示同一时刻到期的金额。Magpie 记录至少两次成功读取的余额后会画出走势。收到 HTTP 401 或 403 时，插件会提示重新登录并核对 Organization ID。再次登录会替换本机保存的凭证。

额度卡默认使用 Magpie 图标库中的 OpenAI 图标。在「插件 → 已安装 → OpenAI API Credits → 选项」可编辑 `icon`，例如填入 `{"icon":"codex-color"}` 切换到 Codex。也可以使用自己的 HTTPS 图片地址或 `data:image/…`。清除选项可恢复默认图标。

请从账单请求复制 **Platform Session Bearer Token**。普通 OpenAI API Key、ChatGPT/Codex 登录和账单会话分别使用各自的凭证。`credit_grants` 是 OpenAI 账单网页使用的接口，OpenAI 可能调整接口或会话要求。

## 与现有 OpenAI Provider 一起使用

[Magpie 的插件接口](https://usemagpie.ai/docs/plugins#ids)为内置 `openai` 保留了 Provider ID。插件以 `openai-api-credit` 注册独立的只读额度卡，声明零模型，并通过 `auth.usage` 返回美元余额与点数到期时间。模型调用继续走 Magpie 原有的 `openai` Provider、API Key 和路由组。额度属于登录时选定的组织。

## 凭证存储

两个凭证保存在本机用户目录下的 `.magpie-openai-api-credit.json`，在 macOS 和 Linux 上为 `0600` 权限的明文文件。Magpie 的 `plugin-auth.json` 只保存本地登录标记。插件直接通过 HTTPS 向 `api.openai.com` 查询，拒绝重定向，错误提示省略原始响应正文。凭证文件位于 Magpie 配置目录和插件仓库之外。

退出并清理本机凭证：

```sh
magpie plugin logout openai-api-credit
rm -f "$HOME/.magpie-openai-api-credit.json"
```

## 开发

运行 `npm test` 验证登录流程、真实余额字段的映射、到期计算和会话失效处理。插件运行时无额外依赖。

## 许可证

[MIT](./LICENSE)
