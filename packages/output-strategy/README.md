# output-strategy

输出样式插件。它在模型调用前注入所选指令。

**移植自 OmniRoute 的 Output Styles**。上游来源、revision 和适配范围见 `PROVENANCE.json`，许可证见 `LICENSES/`。

## 样式

- **Terse prose**：删除客套、填充词和无信息量的措辞。
- **Less code**：YAGNI，优先最小可用改动。
- **Ponytail**：懒惰资深开发原则，完整覆盖复用、根因和最小完整 diff。
- **I have ADHD**：行动优先、编号步骤、明确状态和单一后续动作。
- **Terse CJK**：文言文精简，技术标识保持原样。
- **Antislop UI**：拒绝无目的的渐变、模板布局和死控件。
- **Antislop copy**：拒绝 AI 套话，同时保留真实内容、可访问性和状态。

全部默认关闭。在插件页的 **输出策略** 面板自由组合并保存。样式按 catalog 固定顺序拼接，boundary 去重；重复请求由 `[Output Strategy]` marker 保证不二次注入。

## Options

```json
{
  "styles": {
    "terse-prose": false,
    "less-code": false,
    "ponytail": true,
    "i-have-adhd": false,
    "terse-cjk": false,
    "antislop-ui": false,
    "antislop-copy": false
  },
  "autoClarity": true,
  "telemetry": true
}
```

`autoClarity` 遇到安全、不可逆操作、详细解释或顺序敏感任务时跳过注入。含 image/audio/file 的请求始终跳过。无法识别的请求形状原样通过。

## 本地统计

面板显示选择生效、注入、跳过和各样式次数。统计只包含计数、原因和注入字符数，**不保存请求正文、模型回答或注入后的 prompt**。数据位于 magpie 配置目录的 `output-strategy/stats.json`。`telemetry:false` 关闭统计，不影响样式注入。

## 验证

```bash
bun test
node scripts/gen-page-catalog.mjs
```

`page/catalog.js` 由 `catalog.js` 生成；`page/stats.js` 由本地 hook 发布，均不手改。上游来源、revision 和适配范围见 `PROVENANCE.json`，许可证见 `LICENSES/`。
