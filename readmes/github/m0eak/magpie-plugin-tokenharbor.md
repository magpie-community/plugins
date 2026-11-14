# TokenHarbor Provider Plugin

这是一个供 magpie 使用的 TokenHarbor provider 插件，使用该宿主提供的 provider 插件接口。本文中的安装命令使用 magpie 自己的 CLI。它通过宿主标准的 API Key 登录入口保存密钥，并将 OpenAI 兼容请求发送到 TokenHarbor。

## 安装

推荐直接把插件源码目录交给宿主 CLI：

```sh
magpie plugin add /absolute/path/to/magpie-plugin-tokenharbor
```

如果通过 `.tgz` 归档交付，先解包，再添加解包得到的 `package/` 目录：

```sh
mkdir -p /tmp/tokenharbor-plugin
tar -xzf magpie-plugin-tokenharbor-0.1.0.tgz -C /tmp/tokenharbor-plugin
magpie plugin add /tmp/tokenharbor-plugin/package
```

安装后在 **Providers** 中选择 TokenHarbor，按提示粘贴自己的 API Key，再选择模型。

provider 和插件发现卡片使用 TokenHarbor 官网公开的图标，源文件随 npm 包一并发布。

插件会在模型列表刷新时读取 TokenHarbor 的 `/v1/models` 元数据；这是模型目录查询，不会提交推理请求。实际模型可用性、模型权限和推理错误仍由 TokenHarbor 决定。

## Usage 中的额度

宿主的 Usage 卡片会显示 TokenHarbor 文档接口提供的 Pass 与免费模型额度百分比、耗尽状态和七天窗口重置时间。Pass 与免费模型额度分别显示，但共用 `reset_at` 窗口。百分比是四舍五入后的整数；插件以 `plan_exhausted` 和 `exhausted` 标记显示“已耗尽/可用”，不会仅凭 `100%` 推断耗尽。缺少活动 Pass 或免费模型未启用/未激活时，不会生成虚假的免费额度窗口。

当前宿主没有自动按界面语言翻译插件 Usage 文案。支持宿主选项 API 的宿主默认显示中文；在 **Providers → TokenHarbor → Plugin options** 开启 **English usage text** 可显示英文。较旧宿主没有该选项 API，会保留英文文案。

这些卡片只用于 Usage 展示，不参与宿主的模型路由判断。TokenHarbor 没有在此接口中承诺钱包美元余额，因此插件不会显示或估算 USD 余额。重置时间缺失时，卡片不显示猜测的时间。宿主按自己的 Usage 刷新策略读取；TokenHarbor 说明额度接口可能缓存最多 15 秒。

## 安全与错误处理

API Key 由宿主标准登录流程保存，不要写入插件配置、源码、测试 fixture 或文档。额度查询只发送 `GET https://tokenharbor.ai/api/cli/free-tier`，仅返回文档定义的百分比、状态、窗口时间和免费模型字段。401 会标记登录已失效；403、网络错误或无效响应只显示不含响应正文的错误。

## 检查

请从插件源码检出目录运行以下检查。严格运行时 `.tgz` 只包含运行所需文件，故意不包含测试脚本。

本地合成测试：

```sh
npm test
```

可选的真实额度检查仅调用额度 GET，不可能调用聊天、Responses 或其他推理接口。密钥可通过权限受限的文件提供：

```sh
TOKENHARBOR_API_KEY_FILE=/absolute/path/to/api-key npm run test:quota:live
```

脚本只输出 HTTP 状态和白名单额度字段。若收到 401 或 403 会立即退出，不会重试。
