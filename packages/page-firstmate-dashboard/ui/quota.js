(() => {
  const $ = id => document.getElementById(id);
  const labels = { fresh: '当前', stale: '已过期', unavailable: '不可用', auth_required: '需要授权', rate_limited: '读取受限', error: '读取失败', unknown: '未知' };
  const buckets = { session: '会话窗口', weekly: '周额度', monthly: '月额度', model: '模型额度', credits: '点数额度', unknown: '额度窗口' };
  const providerNames = { codex: 'Codex', agy: 'Antigravity', claude: 'Claude' };
  const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
  const sourceName = value => value === 'local' ? '此 Home 所在主机' : `SSH 来源（${value.slice(4)}）`;
  let selected;

  function element(tag, text, className) {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  async function request(context, operation, values = {}) {
    const response = await fetch(`api/quota/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FM-Write-Token': context.token },
      body: JSON.stringify({ home: context.index, ...values }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '额度操作未完成。');
    return data;
  }

  function actions(busy) {
    $('quota-form').querySelector('fieldset').disabled = busy;
    $('quota-save').disabled = busy || !selected?.config?.revision;
    $('quota-read').disabled = busy || selected?.config?.status !== 'configured';
  }

  function showSource(config) {
    selected.config = config;
    $('quota-options').replaceChildren();
    $('quota-form').hidden = !config.revision;
    config.sources.forEach((source, index) => {
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'source';
      input.id = `quota-source-${index}`;
      input.value = source;
      input.checked = source === config.source;
      input.required = true;
      input.setAttribute('aria-describedby', 'quota-source-caption');
      const label = element('label', sourceName(source));
      label.htmlFor = input.id;
      const option = element('div', '', 'quota-option');
      option.append(input, label);
      $('quota-options').append(option);
    });
    actions(false);
  }

  function showReadings(result) {
    $('quota-status').textContent = result.message || (result.status === 'unknown' ? '当前读数未知。' : '');
    const readings = $('quota-readings');
    readings.replaceChildren();
    if (result.generatedAt) readings.append(element('p', `${sourceName(result.source)} · 读取于 ${date(result.generatedAt)}`, 'caption'));
    for (const row of result.providers) {
      const block = element('div', '', 'quota-provider');
      block.append(element('strong', providerNames[row.provider] || row.provider), element('span', labels[row.status] || '未知', 'tag'));
      if (row.readAt) block.append(element('p', `读数时间 ${date(row.readAt)}`, 'caption'));
      if (row.buckets.length) {
        const list = element('ul', '');
        for (const bucket of row.buckets) {
          const remaining = bucket.remaining === null ? '剩余未知' : `剩余 ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(bucket.remaining)}%`;
          const reset = bucket.resetsAt ? ` · ${date(bucket.resetsAt)} 重置` : '';
          list.append(element('li', `${bucket.label || buckets[bucket.kind]} · ${remaining}${reset}`));
        }
        block.append(list);
      }
      readings.append(block);
    }
    if (result.status === 'read') $('quota-status').textContent = `已读取 ${result.providers.length} 项供应商额度结果。`;
  }

  async function activate() {
    const context = selected;
    if (!context || context.started) return;
    context.started = true;
    try {
      const result = await request(context, 'status');
      if (context !== selected) return;
      showSource(result);
      $('quota-status').textContent = result.message || '';
    } catch (error) {
      if (context === selected) $('quota-status').textContent = error.message;
    }
  }

  $('quota-form').addEventListener('submit', async event => {
    event.preventDefault();
    const context = selected;
    if (!context?.config?.revision) return;
    const source = new FormData(event.currentTarget).get('source');
    actions(true);
    $('quota-readings').replaceChildren();
    $('quota-status').textContent = '';
    try {
      const result = await request(context, 'save', { source, baseRevision: context.config.revision });
      if (context !== selected) return;
      showSource(result);
      $('quota-save').focus({ preventScroll: true });
      $('quota-status').textContent = result.message || `已保存额度来源 · ${sourceName(result.source)}。`;
    } catch (error) {
      if (context === selected) $('quota-status').textContent = error.message;
    } finally {
      if (context === selected) actions(false);
    }
  });

  $('quota-read').addEventListener('click', async () => {
    const context = selected;
    if (!context) return;
    actions(true);
    $('quota-readings').replaceChildren();
    $('quota-status').textContent = '';
    try {
      const result = await request(context, 'read');
      if (context !== selected) return;
      showReadings(result);
    } catch (error) {
      if (context === selected) $('quota-status').textContent = error.message;
    } finally {
      if (context === selected) actions(false);
    }
  });

  window.FMQuota = {
    render(home, index, enabled, active, token) {
      selected = enabled && home?.readable && (!home.remote || home.dispatchAuthority) ? { index, token } : null;
      $('quota-panel').hidden = !selected;
      $('quota-form').hidden = true;
      $('quota-status').textContent = '';
      $('quota-readings').replaceChildren();
      actions(true);
      if (active) activate();
    },
    activate,
  };
})();
