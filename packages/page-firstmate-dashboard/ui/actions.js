(() => {
  const $ = id => document.getElementById(id);
  let current = null, timer;
  const titles = { preview: '正在校验更改', commit: '正在保存配置', sync: '正在同步配置' };
  function elapsed() {
    if (!current) return;
    const seconds = Math.floor((Date.now() - current.started) / 1000);
    $('operation-time').textContent = `${current.state === 'running' ? '已耗时' : '用时'} ${seconds} 秒`;
    const waiting = Math.floor((Date.now() - current.lastActivity) / 1000);
    $('operation-slow').hidden = current.state !== 'running' || waiting < 15;
    if (!$('operation-slow').hidden) $('operation-slow').textContent = `当前步骤已有 ${waiting} 秒未收到新回执。收到结果后会自动更新，请勿重复提交。`;
  }
  function stage(message) {
    if (current) current.lastActivity = Date.now();
    if (!current || current.last === message) return;
    current.last = message;
    $('operation-phase').textContent = message;
    const step = document.createElement('li'); step.textContent = message;
    $('operation-steps').append(step);
    while ($('operation-steps').children.length > 100) $('operation-steps').firstChild.remove();
  }
  function changed() { window.FMActions.onChange?.(); }
  function close() {
    if (current?.state === 'running') return;
    const focus = current?.returnTo, reconcile = current?.reconcile, reconnect = current?.sessionExpired;
    current = null; $('operation').hidden = true; changed();
    if (reconnect) window.FMActions.onReconnect?.();
    else if (reconcile) window.FMActions.onReconcile?.();
    else if (focus?.isConnected && !focus.closest('[hidden]')) focus.focus({ preventScroll: true });
  }
  function finish(state, title, message, sync) {
    current.state = state; clearInterval(timer); elapsed();
    $('operation').dataset.state = state;
    $('operation-dialog').setAttribute('aria-busy', 'false');
    $('operation-title').textContent = title; $('operation-phase').textContent = message;
    $('operation-close').disabled = false; $('operation-close').textContent = current.reconcile ? '关闭并重新读取配置' : '完成';
    $('operation-slow').hidden = true;
    for (const target of sync?.targets || []) {
      const row = document.createElement('li');
      const labels = { pushed: '已推送', unchanged: '已一致', skipped: '已跳过', error: '推送失败', unknown: '回执未知', removed: '已移除' };
      row.textContent = `${target.id}：${labels[target.transfer === 'unknown' ? target.dispatch : target.transfer || target.dispatch] || '回执未知'}${target.reread === 'sent' ? '；已发送重读通知' : target.reread === 'failed' ? '；重读通知失败' : ''}`;
      $('operation-targets').append(row);
    }
    $('operation-close').focus({ preventScroll: true });
  }
  async function read(response) {
    if (!(response.headers.get('content-type') || '').includes('application/x-ndjson')) {
      const result = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }));
      if (!response.ok || result.ok === false) throw Object.assign(new Error(result.message || `HTTP ${response.status}`), { result, definitive: true });
      return result;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let tail = '', result, terminal = false;
    const frame = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      current.localSaved ||= event.localSaved === true;
      if (event.type === 'progress') stage(event.message);
      else if (event.type === 'error') throw Object.assign(new Error(event.message), { result: event, definitive: true });
      else if (event.type === 'result') { result = event.result; terminal = true; }
    };
    try {
      for (;;) {
        const chunk = await reader.read(); tail += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = tail.split('\n'); tail = lines.pop();
        if (tail.length > 8 * 1024 * 1024) throw new Error('响应超过大小限制');
        for (const line of lines) frame(line);
        if (terminal) return result;
        if (chunk.done) break;
      }
      if (tail) frame(tail);
      if (!terminal) throw new Error('连接结束但未收到最终回执');
      return result;
    } finally { reader.releaseLock(); }
  }
  async function run(path, fetcher) {
    if (current?.state === 'running') throw new Error('已有操作正在执行，请等待结果。');
    const kind = path.split('/').pop();
    current = { kind, state: 'running', started: Date.now(), localSaved: false, returnTo: document.activeElement };
    $('operation').dataset.state = 'running'; $('operation').hidden = false;
    $('operation-dialog').setAttribute('aria-busy', 'true');
    $('operation-title').textContent = titles[kind] || '正在执行';
    $('operation-steps').replaceChildren(); $('operation-targets').replaceChildren();
    $('operation-close').disabled = true; $('operation-close').textContent = '执行中…';
    $('operation-history').open = false;
    stage('请求已发出，等待服务响应'); elapsed(); timer = setInterval(elapsed, 1000); changed();
    $('operation-dialog').focus({ preventScroll: true });
    try {
      const result = await read(await fetcher());
      if (kind === 'preview') { clearInterval(timer); current.state = 'success'; close(); return result; }
      const sync = result.sync;
      if (sync && !['completed', 'not_required'].includes(sync.status)) {
        finish('warning', kind === 'commit' ? `${result.unchanged ? '本机配置已一致' : '本机已保存'}，远端同步未完成` : sync.status === 'no_targets' ? '没有可同步的二副' : '同步未完成', sync.message, sync);
      } else {
        const savedMessage = path === 'api/dispatch/commit' ? '派工配置已读回核对。可以另行推送到各二副。' : `本机配置已读回核对。${sync?.status === 'not_required' ? sync.message : sync ? '已收到远端同步回执；运行会话不会因此切换模型。' : '后续工作将按新配置读取。'}`;
        finish('success', kind === 'sync' ? '同步完成' : result.unchanged ? '配置已一致' : '保存完成', kind === 'sync' ? sync?.message || '已收到同步回执。' : savedMessage, sync);
      }
      return result;
    } catch (error) {
      current.sessionExpired = error.result?.error === 'session_expired';
      current.unknown = kind !== 'preview' && (!error.definitive || error.result?.error === 'transport');
      current.reconcile = current.unknown || current.localSaved;
      error.operationUnknown = current.unknown || current.localSaved;
      if (current.unknown) finish('unknown', '连接中断，结果尚未核实', `${current.localSaved ? '已收到本机保存成功回执；远端结果未知。' : '尚未收到最终回执，不能判断操作是否完成。'}关闭后会重新读取配置，请核对后再操作。`);
      else if (current.localSaved) finish('warning', '本机已保存，后续步骤未完成', error.message);
      else finish('failed', kind === 'preview' ? '校验未通过' : '操作未完成', error.message);
      if (current.sessionExpired) { $('operation-title').textContent = '页面需要重新连接'; $('operation-close').textContent = '重新连接并保留编辑'; }
      throw error;
    }
  }
  window.FMActions = { run, close, get busy() { return current?.state === 'running'; }, onChange: null, onReconcile: null, onReconnect: null };
  $('operation-close').addEventListener('click', close);
})();
