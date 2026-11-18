# Magpie Model Check

通过 Magpie 当前配置的渠道发送独立测试题，保存原始回答和来源证据，再与已审核的参考实验比较。插件不检查日常对话，不拦普通请求，不自动切换供应商或模型。

## 安装

在 Magpie 的插件安装处输入：

```text
github:koala9527/magpie-model-check
```

安装并启用后，从插件列表打开“模型行为检测”。Linux、macOS 和 Windows 提供 amd64、arm64 发行包。若架构没有对应可执行文件，插件会在启动检查中明确报错。

## 使用

1. 新增目标，填写 Magpie 中使用的完整模型 ID、目标渠道，以及你要核对的模型声明。
2. 检查单目标和每日请求/Token 预算。定时检测默认关闭。
3. 手动运行独立挑战，在“检测详情与历史”查看原始回答、格式解析、实际记录的渠道、状态和拒绝判断原因。
4. 如需使用自建参考资料，导入原始实验 bundle，逐条核对来源，再填写自己的误报与识别目标、重新评估，最后明确激活。

检测可能产生上游 API 费用。程序会预留请求和 Token 额度，失败或取消不会退回已预留额度。历史、原始回答和参考库保存在本机数据目录；备份不会包含网关 Key 或本机审核签章。

## 如何看结论

模型名称、供应商标签、响应中的 `model`、候选排名第一或文件 hash 都不是底层模型身份的证明。内置 ModelTrace 候选库是历史资料，没有经过独立来源核验和真实模型校准；候选分数也不是概率。

**当前真实模型参考样本为 0，校准概率为 `null`。** 因此软件测试通过不等于某模型身份已经验证。导入的 synthetic 测试只检验解析、分组、重算和页面机制，不可用作真实模型样本。

当前 Magpie 中间件可以认证实际观察到的渠道、请求和完整回答。宿主在中间件之后还会整理请求，因此目前不能证明最终发送到上游的协议字节未被改变。身份检测对此保持未验证/暂不判断，不把响应认证冒充为最终线路认证。

## 本地开发与测试

需要 Node.js 22、Go 1.26 或更新版本。完整测试包括 Go 单元测试、`go vet`、Node 与前端测试和实际 npm 打包检查：

```sh
npm test
npm run test:race
npm run build:release
npm run test:package -- --release-dir dist --require-all-targets --output-dir dist/npm
```

发布构建为 Windows/macOS/Linux 各 amd64、arm64 目标生成不依赖 CGO 的后台程序。交叉编译只证明产物可以构建；每个平台的原生安装和 Magpie 集成须由 CI 对应平台的安装任务分别报告，不能从 Windows 实测推断到其他平台。使用方式、实验准入和证据边界见[改造说明](rebuild.md)、[当前进度](docs/p0-report.md)、[最终验收](docs/verification-0.4.0.md)和[参考库指南](docs/reference-library.md)。技术存档仍在[技术索引](docs/technical/README.md)。

## 旧数据

首次启动会识别旧 `magpie-quality-check/check.db` 并以只读方式迁移可用记录。旧“质量通过”状态保留作历史，不会改写成身份匹配；迁移不会删除原数据库。建议在运行新版前另行备份旧数据。

## 许可

本项目采用 [MIT License](LICENSE)。第三方代码、字体和图标的许可及来源保存在 `third_party/`。
