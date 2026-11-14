<p align="center"><img src="page/icon.png" alt="模型实验室" width="96" height="96"></p>

# 模型实验室 · Model Lab

**在 Magpie 中比较模型表现，并按计划持续测试。**

模型实验室把鹈鹕动画、模型指纹、糖果推理和自动测试放在同一个页面。直接使用 Magpie 已配置的供应商和模型，结果以紧凑卡片展示，可查看思考与输出用量、回放动画、追踪每日表现。

**版本 1.0.0** · MIT · Magpie 0.1.2905+

Model Lab brings HTML animation comparisons, numeric model fingerprints, candy reasoning tests and per-model scheduled monitoring to Magpie. It uses your existing providers and keeps results locally.

## 能做什么

| 页面 | 功能 |
| --- | --- |
| **鹈鹕动画** | 同一提示词生成“鹈鹕骑自行车”HTML 动画，多模型并排预览；支持重播、浏览器打开和查看源码。 |
| **模型指纹** | 每个模型进行 3 次数字采样，与参考库匹配；显示采样进度、候选模型和详细证据。 |
| **糖果测试** | 使用固定推理题比较回答，答案为 **21** 显示绿色，其他明确数值显示红色；回答、思考和用量可展开查看。 |
| **自动测试** | 每个供应商／模型分别设置糖果、动画计划；糖果用成功率与时间格展示，动画按模型排列为横向长廊。 |
| **历史记录** | 按批次浏览、筛选和导出 JSON，支持删除单批、清除全部或清理指定时间之前的结果。 |

- **先选供应商，再选模型**：默认显示全部供应商，支持搜索、多选、一键清空和跨供应商对比。
- **参数自己控制**：可选择模型支持的思考档位、输出上限与并行数；插件不限制单批模型数量。
- **用量统一展示**：三种测试均显示思考／输出 Token；接口尚未返回用量时显示流式字符数。
- **每个模型独立定时**：指定时刻或固定间隔，支持工作日、周末、自选星期和时区，每种测试每天最多 24 次。
- **修改计划保留结果**：同一模型、同一测试类型、同一原定执行分钟的已有结果可以复用，指定时刻与固定间隔互换也适用。
- **结果保存在本机**：默认保留 7 天，保存位置可直接打开；浅色和深色主题跟随宿主。

## 安装

需要 Magpie **0.1.2905 或更新版本**，并先在 Magpie 中配置至少一个可用供应商。插件附带固定版本的指纹 SDK，安装后无需额外运行构建或安装前端依赖。

### 本地安装包

将 `magpie-pelican-bench-1.0.0.zip` 解压到固定目录，在 Magpie 的插件页添加该目录。请选择**直接包含 `package.json` 的文件夹**，然后从侧栏打开“模型实验室”。

也可以在解压目录运行：

```powershell
magpie plugin add .
```

Windows 可使用 `tools/install.ps1`；Magpie 不在 PATH 中时，传入 `-MagpiePath` 指定可执行文件。

### 从 GitHub 安装

公开仓库：[xiaopeng66/magpie-model-lab](https://github.com/xiaopeng66/magpie-model-lab)。在 Magpie 插件发现的 GitHub 非官方区查找 `magpie-model-lab`，或使用：

```sh
magpie plugin add github:xiaopeng66/magpie-model-lab
```

需要固定版本时，在仓库地址后加 `#v1.0.0`。也可从 [Releases](https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v1.0.0) 下载 ZIP 安装包及 SHA-256 校验文件。GitHub 发现存在索引和缓存延迟，暂时搜不到时可直接按上面的命令安装。

当前通过 GitHub 发布，npm 渠道暂未上线。完整规则见 [发布与发现指南](docs/publishing.md)。

技术包名和保存目录仍为 `magpie-pelican-bench`，升级沿用原有计划与历史。原地更新文件后，在 Magpie 插件页关闭再开启插件，重新打开页面即可加载新版本；页面刷新本身不能重载后台服务。

## 开始使用

1. 在“鹈鹕动画”“模型指纹”或“糖果测试”中选择供应商和模型。
2. 按需展开提示词与高级设置，点击顶部开始按钮。
3. 在卡片中查看结果；展开详情可查看原始回复、思考、参数和用量。
4. 需要持续观察时，进入“自动测试”添加模型，从卡片右上角设置计划并启用。
5. 在“历史记录”中查看以往批次、导出记录或清理文件。

| 默认设置 | 数值 |
| --- | --- |
| 最大输出 | **64000 Token**；设为 **0** 时省略插件提供的输出上限 |
| 手动批次并行数 | 动画 **2**，指纹／糖果 **3** |
| 自动测试并行数 | **3**，在自动测试页的并行设置中调整 |
| 自动时刻数量 | 每模型、每测试类型、每计划日最多 **24 次** |
| 结果保留时间 | **7 天**；模型和计划持续保留 |

旧模型已保存的参数继续保留，不会因升级重置为默认值。供应商与网关仍可能限制输出和并发。测试会使用所选供应商的额度。

## 使用须知

- 自动计划需要 Magpie 插件服务持续运行；休眠或退出期间错过的时刻不补跑，新计划默认暂停。
- 指纹提供参考库内的匹配证据，不能证明真实模型身份；糖果绿色表示最终数值匹配 21，不等同于完整推理验证或智商评分。
- 动画预览限制网络访问；模型依赖外部脚本、图片或字体时可能显示不完整。重播读取已保存文件，不再请求模型。
- JSON 导出用于留档和分析，当前没有导入恢复入口；分享前请检查提示词、回复、账号标识与本机路径。

详见 [使用说明](docs/usage.md)、[自动测试说明](docs/favorites-guide.md) 和 [1.0.0 更新记录](CHANGELOG.md)。

## 开发与许可

源码使用原生 HTML/CSS/JavaScript 与 Node/Bun，无前端构建步骤。Node 22+ 或 Bun 可独立调试：

```sh
node serve.mjs --port 3489 --data-dir .local-data --gateway http://127.0.0.1:3425
node --test tests/*.test.mjs
bun test ./tests
bun tools/check-static.mjs
```

测试使用临时目录与模拟网关。独立调试启动服务本身不发送模型请求；在页面开始测试或启用已有计划后才会使用配置的网关。

本项目采用 [MIT License](LICENSE)。指纹能力参考 [magpie-fingerprint](https://github.com/KaranocaVe/magpie-fingerprint)，使用随包附带的 `lmfpd-sdk@0.2.0`；来源、局部改动和参考库说明见 [第三方声明](THIRD_PARTY_NOTICES.md)。Magpie 接入遵循 [官方插件文档](https://usemagpie.ai/docs/plugins)。
