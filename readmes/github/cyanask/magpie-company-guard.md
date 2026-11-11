# Magpie Company Guard

Local company-name masking and reversible replies for Magpie, with session approvals and local receipts.

面向 Magpie 的公司名称保护插件：在模型请求发送前替换识别到的公司名称，在回复返回本机时还原；提供独立的“会话授权”和“脱敏回执”页面。

## 功能与边界

- 检查请求中的用户文字、历史、工具结果、工具参数和工具说明，支持 Responses、Chat Completions、Anthropic Messages、Gemini 协议。
- 根据企业名称规则、明确的名称字段、简称定义及用户配置识别名称，同一会话内使用稳定代号。
- 支持 Codex 单会话原名放行，可选指定名单或全部公司名称；其他会话、分叉和子任务不自动继承。
- 保留最近 25 份回执；名称对应明细仅在插件宿主内存中限时保留，最长 30 分钟。磁盘回执不保存原名、代号或消息全文。

这是规则识别工具，不能保证发现所有公司名称，也不能作为完整的数据防泄漏边界。图片、音频、文件二进制内容及绕过 Magpie 的连接不在检查范围内。宿主超时、回调缺失或请求被跳过时，不能视为已完成保护。

当前在 macOS 上验证；其他系统尚未验证。会话授权依赖 Codex 的会话元数据，其他客户端默认执行名称脱敏。插件不修改源文件或业务数据库，Magpie 自带的其他隐私保护继续按原配置运行。

## 安装与首次配置

需要官方 Magpie、可用的 `magpie` 命令，以及 Node.js。只启用一份本插件，并在继续模型请求前完成密钥配置。

```sh
magpie plugin add github:cyanask/magpie-company-guard
```

首次安装后运行以下命令。它通过 Magpie 官方配置入口补齐本机随机密钥，保留已有有效密钥和其他选项，不输出密钥；已有密钥格式异常时会停止，避免覆盖授权。

```sh
node --input-type=module <<'JS'
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const plugin = 'github:cyanask/magpie-company-guard';
const run = args => {
  const result = spawnSync('magpie', args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) throw new Error('Magpie configuration command failed.');
  return result.stdout;
};
const text = run(['plugin', 'options', plugin]);
const options = JSON.parse(text.slice(text.indexOf('{')));
let changed = false;
for (const key of ['authKey', 'receiptReadKey', 'authorizationKey']) {
  if (options[key] === undefined) {
    options[key] = randomBytes(32).toString('hex');
    changed = true;
  } else if (!/^[a-f0-9]{64}$/.test(options[key])) {
    throw new Error(`Invalid ${key}; existing configuration was preserved.`);
  }
}
if (changed) run(['plugin', 'options', plugin, JSON.stringify(options)]);
console.log('Local configuration is ready. Open the Company name protection page.');
JS
```

随后打开 Magpie → 公司名称保护。默认页面端口为 `3478`，可通过插件选项 `receiptPort` 调整。首次配置完成前，插件会因缺少保护密钥拒绝请求。

## 会话授权

1. 在目标 Codex 会话单独发送“申请取消脱敏”“取消脱敏”或“原名放行”。加粗、行内代码等常见格式也可识别。
2. 打开“公司名称保护 → 会话授权”，核对会话和工作目录，选择范围并确认。申请本身不启用授权，待确认项保留 24 小时。
3. 名单模式最多 32 个完整名称，别名须单独列入；全部名称模式也覆盖该会话后续请求携带的历史和工具文字。
4. 在对应卡片点击“恢复脱敏”并确认，后续请求恢复默认处理。已经发送的原文不能撤回。

授权只在本机保存，持续到用户主动撤销。普通回答结束、追问或中断后继续，不会自动撤销授权。页面批准、撤销使用独立凭据，回执读取凭据不能批准授权。

## Codex 申请轮收尾

可将以下规则加入你自己的 Codex 指导文件；安装本插件不会自动修改它。

> 独立原名放行申请：按本会话编号和工作目录只读核对一次状态，如实最终答复并收尾，不等页面审批；原业务保留，续办按用户指令。

## 回执

在“脱敏回执”页面按任务和状态筛选，查看替换数量、处理状态及限时明细。未命中不代表没有敏感名称；记录未确认时，也不能据此认定请求已经完成保护。

可从源码目录读取本机计数报告：

```sh
node receipt-report.mjs --json
```

本仓库不包含用户配置、授权名单、业务材料或本机验收记录。

## 源码构建

```sh
npm ci
npm run build
```

`dist/` 已提交，可直接从 Git 安装，无需安装时构建。运行时使用 Magpie 自带的 Bun，无额外 npm 运行时依赖；esbuild 仅用于开发构建。本项目尚未发布到 npm。

插件接口见 [Magpie 官方文档](https://usemagpie.ai/docs/plugins)。提交问题时，请使用不含真实名称、凭据和会话内容的必要诊断信息。

## 许可证

MIT。第三方组件及其许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `vendor/LICENSE.*`。
