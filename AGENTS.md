# AGENTS.md

本文件是本仓库的顶层工作规范，适用于所有在此仓库工作的 AI agent（Claude Code、Codex 及其他工具）。与工具默认行为冲突时，以本文件为准。

## 仓库与远端

- `origin`：`https://github.com/moxuanchen/plugins.git`，个人仓库，可推送。
- `upstream`：`https://github.com/magpie-community/plugins.git`，上游源项目。
- `main` 跟踪 `origin/main`；新改动从最新的 `main` 切分支。
- 除第 2 节批准的 issue/PR 动作外，`upstream` 只读；**禁止 `git push upstream`**，也不要改写已推送到远端的公共历史。

## 1. 每轮修改前，先与上游同步（强制）

“新一轮修改”指用户提出的任何一项新的代码、文档或配置改动，包括为某个 issue 准备修复、开新 PR。**在读取目标文件、制定方案、写代码之前**，必须先完成以下步骤：

1. 检查工作区：`git status --short --branch`。有未提交改动时先向用户报告，不得擅自丢弃或覆盖。
2. 抓取远端：`git fetch upstream --prune && git fetch origin --prune`。
3. 查看上游新提交：`git log --oneline HEAD..upstream/main`。
4. 同步本地：
   - 在 `main` 上：`git switch main && git merge --ff-only upstream/main`；不能快进时改用 `git merge upstream/main`。
   - 在功能分支上：`git merge upstream/main`。已有 PR 或已推送的分支不要 rebase，除非用户明确同意。
   - 出现冲突时立即停止，向用户报告冲突文件和上游改动，不猜测、不强行覆盖。
5. 检查重复工作：动手前用
   `gh pr list --repo magpie-community/plugins --state all --search "<关键词>"`
   `gh issue list --repo magpie-community/plugins --state all --search "<关键词>"`
   以及 `git log --oneline upstream/main -- <相关路径>` 确认上游没有已经合并或正在进行的同类修改。若已有，先报告，由用户决定是否继续。
6. 同步完成后，先运行受影响范围的测试，再开始修改。

代码改动提交前至少运行：

```sh
HOME=$(mktemp -d) bun test
bun scripts/check.mjs
```

只改某个包时可先跑 `bun test packages/<name>`，但提交 PR 前要跑全量。

## 2. Issue / PR：先拟稿，经用户批准后才能提交（强制）

文案可以先拟好，但**任何对外提交动作都必须先得到用户在当前轮次中的明确批准**。

需要批准的动作包括（对 `origin` 和 `upstream` 都适用）：

- 创建或编辑 issue：`gh issue create` / `gh issue edit`
- 创建或编辑 PR：`gh pr create` / `gh pr edit`
- 评论、review、关闭或合并：`gh issue comment` / `gh pr comment` / `gh pr review` / `gh issue close` / `gh pr merge`
- 为开 PR 向 `origin` 推送分支：`git push origin <branch>`
- 其他任何会在 GitHub 上产生可见内容的写操作

批准要求：

- 只有用户明确说“提交”“发吧”“可以开 PR”“批准”等才算批准；沉默、默认、以前轮次的批准都不算。
- 提交内容必须与用户看过的草稿一致。标题、正文、范围或测试结论有任何实质变化，都要重新请求批准。
- 草稿默认在对话中给出，不写入仓库，也不在远端创建草稿。
- 草稿至少包含：目标仓库、类型（issue/PR）、标题、正文、涉及包、验证方式；PR 还要写清分支名和对应 issue。

草稿模板：

```text
仓库：magpie-community/plugins
类型：issue / PR
标题：
分支：（PR 时填）
正文：
验证：
```

提交后把链接和状态报告给用户。
