// Magpie 的页面桥（internal/gui/pagebridge.js）把窗口语言放在 magpie.theme.lang；
// page/boot.js 会把它带成 ?lang=…。这里据此切换中英文，不依赖浏览器语言（直开
// 127.0.0.1 时才回退到 navigator.language）。
//
// 文案以中文为源串，英文用字典/规则覆盖。动态渲染的内容由 MutationObserver
// 补翻译；toast / note / confirm 在显示前直接翻译，避免闪现中文。
(() => {
  const raw = new URLSearchParams(location.search).get('lang') || navigator.language || 'en';
  const lang = /^zh/i.test(raw) ? 'zh' : 'en';
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  if (lang === 'en') document.title = 'Key Cabinet';

  const EN = {
    // —— 顶栏 / 列表 ——
    '钥匙柜': 'Key Cabinet',
    '管理 Magpie 网关密钥，按钥匙查看用量，快速生成应用接入配置。':
      'Manage Magpie gateway keys, review usage per key, and generate client configs.',
    '统计周期': 'Usage period',
    '今日': 'Today',
    '7 天': '7 days',
    '30 天': '30 days',
    '新钥匙': 'New key',
    '钥匙': 'Key',
    '钥匙列表': 'Key list',
    '关闭': 'Close',
    '关闭详情': 'Close details',
    '关闭提示': 'Dismiss message',
    '柜子还是空的。点右上角「新钥匙」签发一把网关 Key。':
      'The cabinet is empty. Click “New key” in the top right to issue a gateway key.',
    '总用量还没挂到钥匙。用这把 Key 请求网关后才会记到这里。':
      'Usage is not attributed to keys yet. Calls made with this key will appear here.',
    '这把钥匙本期还没有调用': 'This key has no calls this period',
    '暂无这把钥匙的用量': 'No usage for this key yet',
    '启用': 'On',
    '停用': 'Off',
    '已启用': 'On',
    '已停用': 'Off',
    '点击停用这把钥匙（只影响其它机器/非本机调用）':
      'Click to disable this key (only affects other machines / non-loopback calls)',
    '点击启用这把钥匙（只影响其它机器/非本机调用）':
      'Click to enable this key (only affects other machines / non-loopback calls)',
    '网关 Key': 'Gateway key',
    '默认掩码，点查看显示': 'Masked — click Reveal to show',
    '本地明文已过期': 'Secret expired — rotate',
    'Magpie 侧已轮换过这把 Key，本地保存的明文已过期；点开详情可重置':
      'Magpie rotated this key; the saved secret is stale. Open details to rotate it.',
    '用量四件套': 'Usage metrics',
    '调用次数': 'Calls',
    '调用': 'Calls',
    '费用': 'Cost',
    '缓存命中': 'Cache hit',
    '缓存命中率 = cache_read / (cache_read + cache_write)':
      'Cache hit rate = cache_read / (cache_read + cache_write)',
    '趋势': 'Trend',
    '隐藏 Key': 'Hide key',
    '查看 Key': 'Reveal key',
    '隐藏': 'Hide',
    '查看': 'Reveal',
    '复制 Key': 'Copy key',
    '重置 Key': 'Rotate key',
    '删除钥匙': 'Delete key',
    '复制': 'Copy',
    '重置': 'Rotate',
    '删除': 'Delete',

    // —— 趋势 / 限额描述 ——
    '暂无对比': 'No prior period',
    '较上期持平': 'Flat vs previous period',
    '每天': 'Daily',
    '每周': 'Weekly',
    '每月': 'Monthly',
    '含缓存读取': 'incl. cache reads',
    '无限额': 'No limit',
    '当前模型已不在 Magpie 列表': "current model is no longer in Magpie's list",
    '由 Magpie / 客户端决定': 'chosen by Magpie / the client',
    'Auto · 由 Magpie / 客户端决定': 'Auto · chosen by Magpie / the client',

    // —— 抽屉 ——
    '状态': 'Status',
    '限额（Magpie）': 'Limit (Magpie)',
    '编辑限额': 'Edit limit',
    '已停用 · 点此启用': 'Off · click to enable',
    '已启用 · 点此停用': 'On · click to disable',
    'Magpie 中已找不到这把 Key。这里显示的是本地缓存的旧明文；重置可换一把可用的，删除可清掉这条记录。':
      'This key no longer exists in Magpie. The value shown is the locally cached old secret; rotate to get a usable one, or delete this record.',
    'Magpie 侧已轮换过这把 Key，本地保存的明文已过期；点「重置」可拿到新的可用明文。':
      'Magpie rotated this key, so the saved secret is stale. Click “Rotate” to get a usable secret.',
    'Magpie 信任本机回环请求：停用/删除只对其它机器上的调用生效，本机用同一把 Key 仍可继续请求。':
      'Magpie trusts loopback requests: disabling or deleting a key only affects calls from other machines. The same key still works locally.',
    '网关地址（Magpie 提供）': 'Gateway URL (from Magpie)',
    '复制网关地址': 'Copy gateway URL',
    '模型（Magpie 同款）': 'Model (same as Magpie)',
    '接入 Agent（同一 Key · Magpie 全协议）': 'Connect an agent (one key · all Magpie protocols)',
    '接入协议': 'Protocol',
    '复制配置模板': 'Copy config template',
    '一把 Key 可走 Magpie 全部协议：OpenAI Chat / Responses、Anthropic Messages、Gemini。任意 Agent 只要能改 Base URL + API Key 就能接。':
      'One key works with all Magpie protocols: OpenAI Chat / Responses, Anthropic Messages, Gemini. Any agent that can set a Base URL + API Key can connect.',
    '会话': 'Sessions',
    '错误': 'Errors',
    '输入 tokens': 'Input tokens',
    '输出 tokens': 'Output tokens',
    '本插件只管多 Key：页内创建/查看/重置/删除。模型选 Auto 或指定；路由组策略仍在 Magpie 路由页。用量按 Magpie ledger 的 caller key 汇总。':
      'This plugin manages keys only: create / reveal / rotate / delete in the page. Pick Auto or a model; route-group policy stays in Magpie. Usage is aggregated from Magpie’s ledger by caller key.',

    // —— 限额编辑器 ——
    '窗口': 'Window',
    '自定义…': 'Custom…',
    '每': 'Every',
    '数量': 'Count',
    '天': 'days',
    '小时': 'hours',
    '不限': 'Unlimited',
    '费用 $': 'Cost $',
    '缓存读取也计入 Tokens': 'Include cache reads in tokens',
    '保存': 'Save',
    '清除限额': 'Clear limit',
    '收起': 'Close',
    '自定义窗口按滚动计时，保存后从当前时刻重新开始累计。':
      'Custom windows are rolling and restart from now when saved.',
    '当前没有限额。': 'No limit is set.',
    '自定义窗口请填 1–9999 之间的整数': 'Enter a whole number from 1 to 9999 for the custom window',
    '至少填一个上限，或点「清除限额」': 'Enter at least one limit, or click “Clear limit”',
    '保存后校验不一致，请在 Magpie 中确认这把 Key 的限额':
      "Saved, but verification did not match. Check this key's limit in Magpie.",
    '限额已更新（Magpie）': 'Limit updated (Magpie)',
    '保存限额失败': 'Failed to save the limit',
    '清除后校验不一致，请在 Magpie 中确认': 'Cleared, but verification did not match. Check in Magpie.',
    '已清除限额': 'Limit cleared',
    '清除限额失败': 'Failed to clear the limit',
    '清除这把钥匙在 Magpie 里的所有限额？': 'Remove all limits for this key in Magpie?',
    '读取 Magpie 限额失败：': 'Could not read Magpie limits: ',
    '无法读取 Magpie 的限额（': 'Could not read Magpie limits (',
    '）；仍可保存新限额。': '). You can still save a new limit.',
    '已提交，但无法确认限额：': 'Submitted, but could not verify the limit: ',
    '；请重开钥匙柜页面后重试': '. Reopen the Key Cabinet page and try again.',
    'Magpie 里有 ': 'Magpie has ',
    ' 条限额；保存会先清空，再写入下面这一条。':
      ' limits. Saving clears them and writes the one below.',
    '现有窗口是 ': 'Current window is ',
    '；改用下面的窗口保存会替换它。': '; saving the window below replaces it.',

    // —— 新建 / 进度 / 复制 ——
    '一键签发网关 Key，可直接接到任意 Agent，无需跑命令。':
      'Issue a gateway key in one click and connect any agent — no commands needed.',
    '钥匙名': 'Key name',
    '例如：客服助手': 'e.g. Support bot',
    '标识（Key 名': 'ID (key name',
    'project:<标识>': 'project:<id>',
    '）': ')',
    '默认': 'Default',
    '；也可指定已有路由组或单模型。': '; or pin an existing route group or model.',
    '创建后 Magpie 会签发一把网关 Key；明文保存在本机，之后仍可通过「查看」复制。':
      'Magpie issues a gateway key on creation; the secret is stored on this machine and can be copied later with “Reveal”.',
    '正在签发…': 'Issuing…',
    '向 Magpie 签发网关 Key': 'Issue the gateway key with Magpie',
    '写入模型限制（如有）': 'Apply model restrictions (if any)',
    '放入本地钥匙柜': 'Save to the local key cabinet',
    '完成，展示 Secret': 'Done — show the secret',
    '✓ 钥匙已放入，请立即复制网关 Key': '✓ Key saved. Copy the gateway key now.',
    'OpenAI 环境变量': 'OpenAI env vars',
    'Anthropic 环境变量': 'Anthropic env vars',
    'Gemini 环境变量': 'Gemini env vars',
    '关闭后默认只显示掩码。可在钥匙详情里「查看」或「重置」。把 Base URL + Key 填进任意 Agent 即可接入。':
      'Once closed, only the mask is shown. Reveal or rotate it in the key details. Point any agent at the Base URL + Key to connect.',
    '取消': 'Cancel',
    '签发钥匙': 'Issue key',
    '完成': 'Done',
    '请确认': 'Please confirm',
    '确认': 'Confirm',
    '手动复制': 'Copy manually',
    '浏览器拒绝了剪贴板权限（Magpie 页面运行在沙盒 iframe 里）。下面的文本已经选中，按 ⌘C / Ctrl+C 复制。':
      'The browser blocked clipboard access (Magpie pages run in a sandboxed iframe). The text below is selected — press ⌘C / Ctrl+C to copy.',
    '再试一次': 'Try again',
    '待复制文本': 'Text to copy',
    '没有可复制的内容': 'Nothing to copy',
    '已复制': 'Copied',
    '仍然无法写入剪贴板，请按 ⌘C / Ctrl+C': 'Still could not write to the clipboard — press ⌘C / Ctrl+C',
    '已复制，但 Magpie 中已找不到这把 Key': 'Copied, but this key no longer exists in Magpie',
    '已复制，但 Magpie 侧已轮换过这把 Key；本地明文可能已失效，请重置':
      'Copied, but Magpie rotated this key; the saved secret may be stale — rotate it',
    '复制失败': 'Copy failed',
    '无法复制含 Key 的配置': 'Could not copy the config with the key',
    '无法查看': 'Could not reveal',
    '更新失败': 'Update failed',
    '已设为 Auto': 'Set to Auto',
    '重置后旧 Key 将被替换；Magpie 仍信任本机请求，本机访问不会因此被阻止。确定重置？':
      'Rotating replaces the old key. Magpie still trusts loopback requests, so local access is not blocked. Rotate?',
    '已重置 Key': 'Key rotated',
    '重置失败': 'Rotate failed',
    '已删除': 'Deleted',
    '删除失败': 'Delete failed',
    '签发中…': 'Issuing…',
    '正在向 Magpie 签发 Key…': 'Issuing the key with Magpie…',
    '写入模型限制…': 'Applying model restrictions…',
    '放入本地钥匙柜…': 'Saving to the local key cabinet…',
    '签发完成': 'Issued',
    '钥匙已放入 · 请复制 Key': 'Key saved · copy it now',
    '签发失败': 'Issue failed',
    '重试签发': 'Retry',
    '保存网关 Key': 'Save the gateway key',
    '先填写钥匙名': 'Enter a key name first',
    '先填写标识': 'Enter an ID first',

    // —— 状态提示 ——
    '加载中…': 'Loading…',
    '用量汇总加载中…': 'Loading usage summary…',
    '用量汇总加载中（Magpie CLI）': 'Loading usage summary (Magpie CLI)',
    '服务不可用': 'Service unavailable',
    '用量加载失败': 'Failed to load usage',
    '已启用（本机调用不受影响）': 'Enabled (loopback calls are unaffected)',
    '已停用（本机调用不受影响）': 'Disabled (loopback calls are unaffected)',
    '切换失败': 'Switch failed',

    // —— 服务端错误 ——
    '请求体过大': 'Request body too large',
    '请求体不是有效的 JSON': 'Request body is not valid JSON',
    '缺少页面口令': 'Missing page token',
    '只服务于 Magpie 窗口里的钥匙柜页': 'Only serves the Key Cabinet page inside Magpie',
    '钥匙不存在': 'Key not found',
    '更新内容格式无效': 'Invalid update payload',
    '标识已存在': 'ID already exists',
    '标识无效（请用英文/数字，如 support-bot）':
      'Invalid ID (use letters/numbers, e.g. support-bot)',
    '钥匙名不能为空': 'Key name is required',
    '这把钥匙没有关联的 Magpie Key': 'This key has no linked Magpie key',
    '本地未保存该 Key 明文；请重置后重新复制':
      'The secret is not stored locally; rotate and copy again',
    'Tokens 上限需为正整数': 'Token limit must be a positive integer',
    '费用上限需为正数': 'Cost limit must be a positive number',
    '至少填一个上限（Tokens 或费用）；要取消限额请点「清除限额」':
      'Enter at least one limit (tokens or cost); to remove limits, click “Clear limit”',
    '限额格式无效': 'Invalid limit format',
    '限额窗口只支持 day / week / month / <N>d / <N>h':
      'Limit windows support only day / week / month / <N>d / <N>h',
    'Magpie 中找不到这把网关 Key': 'This gateway key was not found in Magpie',
    'caller-keys.json 格式无效': 'caller-keys.json is malformed',
    '未知错误': 'Unknown error',
    '缺少参数': 'Missing parameter',
    '缺少 Key id': 'Missing key id',
    '切换钥匙状态超时': 'Timed out switching the key state',
    '钥匙柜数据格式无效，请检查 projects.json':
      'Key cabinet data is malformed; check projects.json',
    '文件不可用': 'File unavailable',
    '端口被其它进程占用（不是这个钥匙柜服务）':
      'The port is held by another process (not this Key Cabinet service)',
  };

  // 带变量的句子用规则；顺序从具体到宽泛。
  const RULES = [
    [/^(\d+) 把钥匙$/, (m) => `${m[1]} key${m[1] === '1' ? '' : 's'}`],
    [/^已指定 (.+)$/, (m) => `Set to ${m[1]}`],
    [/^✓ 「(.+)」已放入，请立即复制网关 Key$/, (m) => `✓ “${m[1]}” saved. Copy the gateway key now.`],
    [/^(\d+)s · Magpie CLI 可能需数秒$/, (m) => `${m[1]}s · the Magpie CLI can take a few seconds`],
    [/^用时 (\d+)s$/, (m) => `${m[1]}s elapsed`],
    [/^较上期上升 (\d+)%$/, (m) => `Up ${m[1]}% vs previous period`],
    [/^较上期下降 (\d+)%$/, (m) => `Down ${m[1]}% vs previous period`],
    [/^每 (\d+) 天$/, (m) => `every ${m[1]} days`],
    [/^每 (\d+) 小时$/, (m) => `every ${m[1]} hours`],
    [/^每 (.+)$/, (m) => `every ${m[1]}`],
    [/^(.+) · 含缓存读取$/, (m) => `${translate(m[1])} · incl. cache reads`],
    [/^(.+)（(每天|每周|每月|每 .+)）$/, (m) => `${translate(m[1])} (${translate(m[2])})`],
    [/^(.+) · 路由组$/, (m) => `${m[1]} · route group`],
    [/^(.+) · 单模型$/, (m) => `${m[1]} · single model`],
    [/^(.+)用量拆分$/, (m) => `${translate(m[1])} usage breakdown`],
    [/^读取 Magpie 限额失败：(.+)；仍可保存新限额。$/, (m) => `Could not read Magpie limits: ${translate(m[1])}. You can still save a new limit.`],
    [/^无法读取 Magpie 的限额（(.+)）；仍可保存新限额。$/, (m) => `Could not read Magpie limits (${translate(m[1])}). You can still save a new limit.`],
    [/^已提交，但无法确认限额：(.+)；请重开钥匙柜页面后重试$/, (m) => `Submitted, but could not verify the limit: ${translate(m[1])}. Reopen the Key Cabinet page and try again.`],
    [/^Magpie 里有 (\d+) 条限额；保存会先清空，再写入下面这一条。$/, (m) => `Magpie has ${m[1]} limits. Saving clears them and writes the one below.`],
    [/^现有窗口是 (.+)；改用下面的窗口保存会替换它。$/, (m) => `Current window is ${m[1]}; saving the window below replaces it.`],
    [/^用量读取失败：(.+)$/, (m) => `Usage read failed: ${translate(m[1])}`],
    [/^模型列表读取失败：(.+)（仍可签发钥匙）$/, (m) => `Model list read failed: ${translate(m[1])} (you can still issue keys)`],
    [/^Magpie 中这把 Key 当前是「(已停用|已启用)」，与本地记录不一致；页面按 Magpie 显示，点上面的状态按钮会把「(已停用|已启用)」写回 Magpie。$/, (m) => `Magpie currently has this key ${translate(m[1])}, which differs from the local record. The page follows Magpie; the status button writes “${translate(m[2])}” back to Magpie.`],
    [/^删除钥匙「(.+)」及其网关 Key？本机回环请求不受影响（Magpie 仍信任本机）。$/, (m) => `Delete key “${m[1]}” and its gateway key? Loopback requests from this machine are unaffected (Magpie still trusts this machine).`],
    [/^Magpie 中已找不到这把 Key（(.+)）；请删除这条本地记录后重新签发$/, (m) => `This key no longer exists in Magpie (${m[1]}). Delete this local record and issue a new key.`],
    [/^Magpie 已有同名 Key：(.+)（id (.+)）。请先在 Magpie 删除或换标识。$/, (m) => `Magpie already has a key named ${m[1]} (id ${m[2]}). Delete it in Magpie or use another ID.`],
    [/^Magpie 已更新，但本地保存失败：(.+)$/, (m) => `Magpie was updated, but saving locally failed: ${translate(m[1])}`],
    [/^本地保存失败：(.+)$/, (m) => `Local save failed: ${translate(m[1])}`],
    [/^创建失败：(.+)；清理 Magpie Key (.+) 失败：(.+)，请在 Magpie 中检查并删除$/, (m) => `Create failed: ${translate(m[1])}. Cleanup of Magpie key ${m[2]} also failed: ${translate(m[3])}. Check and delete it in Magpie.`],
    [/^Magpie Key 已删除，但本地保存失败：(.+)。请检查存储权限后重试删除$/, (m) => `The Magpie key was deleted, but saving locally failed: ${translate(m[1])}. Check storage permissions and retry the delete.`],
    [/^Magpie 已重置 Key，但本地保存失败：(.+)。旧 Key 已被替换，请检查存储权限后再次重置$/, (m) => `Magpie rotated the key, but saving locally failed: ${translate(m[1])}. The old key is gone; check storage permissions and rotate again.`],
    [/^无法锁定 Magpie caller-keys\.json（(.*)）$/, (m) => `Could not lock Magpie caller-keys.json (${m[1]})`],
    [/^切换失败 \(exit (\d+)\)$/, (m) => `Switch failed (exit ${m[1]})`],
    [/^端口 (.+) 已被占用，且现有进程不可用：(.*)。请结束旧 node 后再开插件。$/, (m) => `Port ${m[1]} is in use and the existing process is unusable: ${m[2]}. Stop the old node process and reopen the plugin.`],
    // —— 复制出来的配置注释 ——
    [/^# Magpie 钥匙柜 · project:(.+) · OpenAI 兼容（Pi \/ OpenCode \/ Continue \/ 任意 Agent）$/, (m) => `# Magpie Key Cabinet · project:${m[1]} · OpenAI-compatible (Pi / OpenCode / Continue / any agent)`],
    [/^# Magpie 钥匙柜 · project:(.+) · Anthropic \/ Claude Code$/, (m) => `# Magpie Key Cabinet · project:${m[1]} · Anthropic / Claude Code`],
    [/^# Magpie 钥匙柜 · project:(.+) · OpenAI Responses（Codex 等）$/, (m) => `# Magpie Key Cabinet · project:${m[1]} · OpenAI Responses (Codex, etc.)`],
    [/^# Magpie 钥匙柜 · project:(.+) · Gemini \/ google-genai$/, (m) => `# Magpie Key Cabinet · project:${m[1]} · Gemini / google-genai`],
    [/^# 网关 \/ 模型列表 \/ 路由组均来自本机 Magpie；本插件只管理多 Key$/, () => '# Gateway / model list / route groups come from local Magpie; this plugin only manages keys'],
    [/^# Claude Code 优先读 ANTHROPIC_AUTH_TOKEN；SDK 用 ANTHROPIC_API_KEY$/, () => '# Claude Code prefers ANTHROPIC_AUTH_TOKEN; SDKs use ANTHROPIC_API_KEY'],
    [/^# 与 Chat Completions 同 Base URL \/ Key，走 POST \/v1\/responses$/, () => '# Same Base URL / key as Chat Completions, sent to POST /v1/responses'],
    [/^# 也可用 Authorization: Bearer 调同一网关$/, () => '# Authorization: Bearer also works against the same gateway'],
    [/^# OPENAI_MODEL 省略 = Auto（由 Magpie \/ 客户端决定）$/, () => '# OPENAI_MODEL omitted = Auto (chosen by Magpie / the client)'],
    [/^# ANTHROPIC_MODEL 省略 = Auto（由 Magpie \/ 客户端决定）$/, () => '# ANTHROPIC_MODEL omitted = Auto (chosen by Magpie / the client)'],
    [/^# OPENAI_MODEL 省略 = Auto$/, () => '# OPENAI_MODEL omitted = Auto'],
    [/^# GEMINI_MODEL 省略 = Auto$/, () => '# GEMINI_MODEL omitted = Auto'],
  ];

  function translate(value) {
    const s = String(value);
    if (Object.prototype.hasOwnProperty.call(EN, s)) return EN[s];
    for (const [re, fn] of RULES) {
      const m = s.match(re);
      if (m) return fn(m);
    }
    return s;
  }

  function t(value) {
    if (lang !== 'en' || value == null) return value;
    const s = String(value);
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m || !m[2]) return s;
    const out = translate(m[2]);
    return out === m[2] ? s : m[1] + out + m[3];
  }

  // 多行文本（复制出去的配置）逐行翻译，保留空行与缩进。
  function block(value) {
    if (lang !== 'en' || value == null) return value;
    return String(value).split('\n').map((line) => t(line)).join('\n');
  }

  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE']);

  function node(n) {
    if (n.nodeType === 3) {
      const v = n.nodeValue;
      const out = t(v);
      if (out !== v) n.nodeValue = out;
      return;
    }
    if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) return;
    if (n.hasAttribute && n.hasAttribute('data-i18n-skip')) return;
    for (const a of ATTRS) {
      if (!n.hasAttribute(a)) continue;
      const v = n.getAttribute(a);
      const out = t(v);
      if (out !== v) n.setAttribute(a, out);
    }
    for (const c of n.childNodes) node(c);
  }

  function observe() {
    if (lang !== 'en') return;
    node(document.body);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') node(r.target);
        else if (r.type === 'attributes') node(r.target);
        else for (const n of r.addedNodes) node(n);
      }
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  window.KC_I18N = { lang, isZh: lang === 'zh', t, block, observe };
})();
