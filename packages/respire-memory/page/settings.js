const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
let busy = false;

magpie.ready.then(async () => {
  try {
    const o = await magpie.options.get();
    $('url').value = o.runtimeUrl ?? 'http://127.0.0.1:15169';
    $('project').value = o.project ?? '';
    $('remember').checked = o.remember !== false;
    $('capture').checked = o.capture === true;
    for (const name of ['readOnly', 'archive']) $(name).checked = o[name] === true;
    $('showMemoryStatus').checked = o.showMemoryStatus !== false;
    for (const name of ['generationBaseUrl', 'generationModel', 'stateDir']) $(name).value = o[name] ?? '';
    $('authorizationEnv').value = o.authorizationEnv ?? 'RESPIRE_MAGPIE_AUTHORIZATION';
    $('save').disabled = false;
    status('配置已读取。这里不检测 Runtime 连接状态。');
  } catch { status('无法读取配置，请检查 Magpie 插件页面接口。'); }
}).catch(() => status('Magpie 页面接口不可用。'));

$('form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  let url;
  try { url = new URL($('url').value.trim()); } catch { status('请输入有效的本地 Runtime 地址。'); return; }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.href.includes('@') || url.search || url.hash || url.pathname !== '/') {
    status('地址只允许 127.0.0.1 或 [::1]，不接受凭据、路径或查询参数。'); return;
  }
  const project = $('project').value.trim();
  if (/[\x00-\x1f\x7f]/.test(project)) { status('项目名称不能包含控制字符。'); return; }
  const generationBaseUrl = $('generationBaseUrl').value.trim(), generationModel = $('generationModel').value.trim();
  const authorizationEnv = $('authorizationEnv').value.trim(), stateDir = $('stateDir').value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authorizationEnv)) { status('请填写合法的环境变量名称，不要填写密钥。'); return; }
  if ($('archive').checked && (!generationBaseUrl || !generationModel)) { status('启用后台整理前，请填写生成服务地址和模型名称。'); return; }
  if (generationBaseUrl) {
    let service;
    try { service = new URL(generationBaseUrl); } catch { status('生成服务地址无效。'); return; }
    if (service.href.includes('@') || service.search || service.hash || !(service.protocol === 'https:' || service.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(service.hostname))) {
      status('生成服务必须使用 HTTPS，或字面回环地址的 HTTP；不接受 URL 凭据和查询参数。'); return;
    }
  }
  if (stateDir && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(stateDir)) { status('状态目录必须是绝对路径。'); return; }
  busy = true; $('save').disabled = true;
  try {
    const previous = await magpie.options.get();
    await magpie.options.set({ ...previous, runtimeUrl: url.href, project,
      remember: $('remember').checked, capture: $('capture').checked, readOnly: $('readOnly').checked,
      showMemoryStatus: $('showMemoryStatus').checked, archive: $('archive').checked,
      generationBaseUrl, generationModel, authorizationEnv, stateDir });
    status('配置已保存，将用于后续请求。');
  } catch { status('保存未确认，请重新打开页面核对配置后再操作。'); }
  finally { busy = false; $('save').disabled = false; }
};
