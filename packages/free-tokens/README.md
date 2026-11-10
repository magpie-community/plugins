# @magpie-community/page-free-tokens

AIHOT「Token 羊毛」页面：在 magpie 窗口里分三档看各家大模型的免费额度——**已配置可用** / **有插件待配置** / **暂无插件**，并对每条给出该装的插件或登录路径。

数据来自 [AIHOT · Token 羊毛](https://aihot.news/free-tokens)，每个用户在自己的电脑上直连读一次：magpie 的插件宿主启动时（打开 magpie、装或改插件之后），不是每次打开页面时（不代理、不镜像、不随包分发、不后台轮询）。只展示官方厂商额度（`src/allowlist.js`）；图标用 magpie 自带品牌图标，其余首字母色块。页脚署名「数据源：AIHOT」并链回。

> 已取得 AIHOT 书面授权（2026-11-10）：免费、不接广告/赞助、每用户本机打开时读一次、不做代理/镜像/数据分发。

安装：`magpie plugin add @magpie-community/page-free-tokens`。测试：`bun test`（100% 行覆盖）。
