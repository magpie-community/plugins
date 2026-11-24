(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const x = document.createElement(tag); if (text) x.textContent = text; if (cls) x.className = cls; return x; };
  let state, category = '全部', query = '', view = 'common', harness = 'all', opener, captureEditor;
  const scopes = window.FMSettingScopes;
  const groupOrder = ['运行', '监督', '记忆', '交付', '权限', '集成'];
  const linesOf = text => (text || '').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  function parameterValues(item) {
    const values = {}, known = new Set(item.parameters.map(p => p.key));
    for (const line of linesOf(item.text)) {
      const parts = line.split('=');
      if (parts.length !== 2 || !known.has(parts[0]) || !/^[1-9][0-9]*$/.test(parts[1]) || parts[0] in values) return null;
      values[parts[0]] = parts[1];
    }
    return values;
  }
  function valueOf(item) {
    if (item.error) return '读取失败'; if (item.unresolved) return '有效配置待核实';
    if (!item.present) return item.defaultLabel || '未配置';
    if (item.flag) return item.presentLabel || '已启用';
    if (item.private) return item.hiddenLabel || '已配置 · 内容隐藏';
    if (item.parameters) { const values = parameterValues(item); return values ? Object.keys(values).length ? '已开启 · 自定义参数' : '已开启 · 默认参数' : '已配置 · 格式需核对'; }
    if (item.multiline) { const count = linesOf(item.text).length; return `${count} ${item.unit || '项'}`; }
    const text = item.text?.trim(); return item.choiceLabels?.[text] || text || '空文件 · 按原生规则';
  }
  function close() { $('setting-editor').hidden = true; captureEditor = null; state?.onModalChange?.(); if (opener?.isConnected) opener.focus({ preventScroll: true }); }
  function open(item, from) {
    opener = from;
    const dialog = $('setting-editor'), body = $('setting-editor-body'); body.replaceChildren();
    $('setting-editor-title').textContent = item.label;
    $('setting-editor-description').textContent = item.effect;
    const fact = el('dl', '', 'setting-facts');
    for (const [label, value] of [['当前配置', valueOf(item)], ['适用工具', `${item.harnessLabel || '待刷新'}${item.backendLabel ? ` · ${item.backendLabel} 后端` : ''}`], ['来源', item.source], ['作用范围', item.inheritance], ['生效时机', item.applies || '后续原生读取'], ['参考', item.reference || '当前 Firstmate 配置文档']]) { fact.append(el('dt', label), el('dd', value)); }
    if (item.requirements) body.append(el('p', item.requirements, 'setting-readonly'));
    if (!item.editable) body.append(el('p', item.reason || '此项只读', 'setting-readonly'), fact);
    const editor = el('div', '', 'setting-fields'), inputs = [];
    let mode, input, parameters;
    if (item.editable) {
      const modeRow = el('div', '', 'setting-field-row'); modeRow.append(el('label', '配置方式'));
      mode = window.FMControls.menu(`${item.label}配置方式`, [{ value: 'default', label: '使用默认行为' }, { value: 'explicit', label: item.flag ? item.presentLabel === '已关闭' ? '显式关闭' : '启用' : item.parameters ? '启用并设置参数' : '自定义' }], item.present ? 'explicit' : 'default', update);
      modeRow.append(mode); editor.append(modeRow);
      const values = item.parameters ? parameterValues(item) : null;
      if (item.parameters && values) {
        parameters = new Map();
        for (const spec of item.parameters) {
          const row = el('div', '', 'setting-field-row'); const label = el('label', spec.label);
          const number = document.createElement('input'); number.type = 'number'; number.min = '1'; number.step = '1'; number.value = values[spec.key] || ''; number.placeholder = String(spec.default); number.setAttribute('aria-label', spec.label);
          parameters.set(spec.key, number); inputs.push(number); row.append(label, number); editor.append(row);
        }
        editor.append(el('p', '参数留空采用所示默认值。原文件中的注释会保留。', 'setting-help'));
      } else if (!item.flag) {
        const field = el('div', '', 'setting-field-row'); field.append(el('label', item.multiline ? '配置内容' : '配置值'));
        if (item.choices) {
          const values = item.text?.trim() && !item.choices.includes(item.text.trim()) ? [item.text.trim(), ...item.choices] : item.choices;
          input = window.FMControls.menu(item.label, values.map(v => ({ value: v, label: item.choiceLabels?.[v] || v })), item.text?.trim() || item.choices[0], () => {});
        } else {
          input = document.createElement(item.multiline ? 'textarea' : 'input'); input.value = item.multiline ? item.text || '' : item.text?.trim() || '';
          input.setAttribute('aria-label', item.label); if (item.multiline) input.rows = 5;
          if (item.numeric) { input.type = 'number'; input.min = '1'; input.step = '1'; }
        }
        inputs.push(input); field.append(input); editor.append(field);
        if (item.parameters) editor.append(el('p', '原配置含无法识别的条目。先核对原文；未确认前不会自动转换或丢弃。', 'setting-help'));
      }
      body.append(editor);
    }
    body.append(el('p', `默认行为：${item.fallback}`, 'setting-help'));
    if (item.editable) { body.append(el('p', `作用范围：${item.inheritance}。生效时机：${item.applies}。`, 'setting-help')); const details = el('details', '', 'setting-details'); details.append(el('summary', '来源与参考'), fact); body.append(details); }
    const error = $('setting-editor-error'); error.hidden = true;
    const preview = $('setting-editor-preview'); preview.hidden = !item.editable;
    const restore = $('setting-editor-restore'); restore.hidden = !item.editable || !item.latestBackup;
    function update() { for (const input of inputs) input.disabled = mode.value !== 'explicit'; }
    update();
    const editorRequest = () => {
      let text;
      if (item.flag) text = '';
      else if (parameters) {
        const initial = parameterValues(item);
        if ([...parameters].every(([key, input]) => input.value === (initial[key] || ''))) text = item.text || '';
        else {
          const remaining = new Set(parameters.keys());
          const lines = (item.text || '').split('\n').filter((line, i, all) => i !== all.length - 1 || line !== '').map(line => {
            const key = line.trim().split('=')[0]; if (!parameters.has(key) || !line.includes('=')) return line;
            remaining.delete(key); return parameters.get(key).value ? `${key}=${parameters.get(key).value}` : null;
          }).filter(line => line !== null);
          for (const key of remaining) if (parameters.get(key).value) lines.push(`${key}=${parameters.get(key).value}`);
          text = lines.length ? `${lines.join('\n')}\n` : '';
        }
      } else text = !item.multiline && input.value === item.text?.trim() ? item.text : item.multiline ? input.value : `${input.value}\n`;
      return { home: state.homeIndex, key: item.key, baseRevision: item.revision, present: mode.value === 'explicit', text };
    };
    captureEditor = item.editable ? editorRequest : null;
    const show = async backup => {
      preview.disabled = true; restore.disabled = true; error.hidden = true;
      try {
        const request = editorRequest(); if (backup) request.restore = backup;
        const result = await state.post('api/settings/preview', request); request.nextRevision = result.nextRevision;
        state.openReview(result, request, backup ? `恢复${item.label}` : `保存${item.label}`, `${result.action}。${item.effect}`, 'settings', backup ? restore : preview);
      } catch (e) { error.textContent = e.message; error.hidden = false; }
      finally { preview.disabled = false; restore.disabled = false; }
    };
    preview.onclick = () => show(); restore.onclick = () => show(item.latestBackup.id);
    $('setting-editor-cancel').textContent = item.editable ? '取消' : '关闭';
    dialog.hidden = false; state.onModalChange?.(); $('setting-editor-cancel').focus({ preventScroll: true });
  }
  function paint() {
    const list = $('settings-list'); list.replaceChildren();
    const items = state.home?.settings || [];
    const applicable = items.filter(item => scopes.matches(item, harness));
    const matches = items.filter(item => {
      if (!scopes.matches(item, harness)) return false;
      if (category !== '全部' && item.group !== category) return false;
      if (query) return `${item.label} ${item.key} ${item.effect} ${item.fallback} ${item.groupName} ${item.reference || ''}`.toLowerCase().includes(query.toLowerCase());
      return view === 'all' || view === 'common' && (item.common || item.present || !['all','common'].includes(harness) && item.harnesses?.length) || view === 'configured' && item.present || view === 'unconfigured' && item.present === false || view === 'readonly' && !item.editable;
    });
    $('settings-count').textContent = `显示 ${matches.length} / ${applicable.length} 项 · ${applicable.filter(i => i.present).length} 项已配置`;
    $('settings-scope-note').textContent = harness === 'all' ? '先按适用 Harness 筛选，再按用途查看。终端后端单独标注，不当作 Harness。' : harness === 'common' ? '显示跨 Harness 共用的设置，后端限制以每项说明为准。' : `显示 ${scopes.choices.find(c => c.value === harness).label} 相关项及通用项；其他 Harness 的专用项已隐藏。`;
    for (const b of $('settings-harnesses').children) b.setAttribute('aria-pressed', String(b.dataset.harness === harness));
    for (const key of groupOrder) {
      const selected = matches.filter(item => item.group === key); if (!selected.length) continue;
      const group = selected[0], section = el('section', '', 'settings-section'), heading = el('div', '', 'settings-section-head');
      heading.append(el('h3', group.groupName), el('p', group.groupHint)); section.append(heading);
      const rows = el('div', '', 'settings-rows');
      for (const item of selected) {
        const row = el('button', '', 'setting-row'); row.type = 'button'; row.dataset.setting = item.key;
        row.setAttribute('aria-label', `${item.label}，${valueOf(item)}，${item.editable ? '编辑' : '查看详情'}`);
        const who = el('span', '', 'setting-who'), name = el('span', '', 'setting-name'); name.append(el('span', item.label));
        if (item.harnesses?.length || item.backendLabel) name.append(el('small', [item.harnesses?.length ? item.harnessLabel : '', item.backendLabel ? `${item.backendLabel} 后端` : ''].filter(Boolean).join(' · '), 'setting-scope'));
        who.append(name);
        const ownership = item.unresolved ? '本机根 Home 待核实' : item.inherited && state.home.role?.kind === 'secondmate' ? '大副管理' : item.rootOnly ? '本机共享' : item.inherited ? '继承到二副' : '仅此 Home';
        who.append(el('span', `${ownership} · ${item.error ? '读取失败' : item.present ? '已配置' : '未配置'}${item.editable ? '' : ' · 只读'}`, 'setting-state'));
        const value = el('span', valueOf(item), 'setting-current'); value.title = valueOf(item);
        row.append(who, value, el('i', '', 'setting-chevron')); row.addEventListener('click', () => open(item, row)); rows.append(row);
      }
      section.append(rows); list.append(section);
    }
    if (!matches.length) { const empty = el('div', '', 'settings-empty'); empty.append(el('strong', '没有匹配的设置'), el('p', state.home?.remote ? '远端只读 Home 的设置目录不由本插件读取或写入。' : '试试调整 Harness、用途分类或显示范围。')); list.append(empty); }
    for (const b of $('settings-categories').children) b.setAttribute('aria-pressed', String(b.dataset.category === category));
  }
  window.FMSettings = {
    render(next) {
      state = next; const home = state.home;
      const remote = Boolean(home?.remote);
      $('settings-role').textContent = remote
        ? home?.role?.kind === 'primary' ? '大副 · 远端只读' : home?.role?.kind === 'secondmate' ? '二副 · 远端只读' : '远端 · 身份待核实'
        : home?.role?.kind === 'primary' ? '本机大副' : home?.role?.kind === 'secondmate' ? '本机二副' : '身份待核实';
      $('settings-origin').textContent = remote
        ? `这个 Home 在远端机器（${home?.remote?.ssh || '未命名'}）。本插件只读取它的二副启动配置与启动记录，不读取也不写入它的设置目录，所以这里没有可编辑项。`
        : `${home?.role?.kind === 'secondmate' ? '继承项由大副管理，本地项只作用于当前二副。' : '各项按自身规则生效，继承项可同步到二副。'}这里显示保存的配置，不代表运行中会话已加载。`;
      const nav = $('settings-categories'); nav.replaceChildren();
      const items = home?.settings || [];
      const tools = $('settings-harnesses'); tools.replaceChildren();
      for (const choice of scopes.choices) { const b = el('button', choice.label); b.type = 'button'; b.dataset.harness = choice.value; b.onclick = () => { harness = choice.value; paint(); }; tools.append(b); }
      for (const key of ['全部', ...groupOrder]) { const item = items.find(item => item.group === key); const b = el('button', key === '全部' ? '全部' : item?.groupName || key); b.type = 'button'; b.dataset.category = key; b.onclick = () => { category = key; paint(); }; nav.append(b); }
      $('settings-view').replaceChildren(window.FMControls.menu('显示设置范围', [{value:'common',label:'常用与已配置'},{value:'all',label:'全部参数'},{value:'configured',label:'已配置'},{value:'unconfigured',label:'未配置'},{value:'readonly',label:'只读项'}], view, next => { view = next; paint(); }));
      $('settings-search').value = query; $('settings-search').oninput = event => { query = event.target.value; if (query) category = '全部'; paint(); };
      $('setting-editor-cancel').onclick = close; paint();
    }, close,
    capture() { return !$('setting-editor').hidden && captureEditor ? captureEditor() : null; },
    restore(request) {
      const item = state.home?.settings.find(item => item.key === request.key && item.editable && item.revision === request.baseRevision);
      if (!item) return false;
      open({ ...item, text: request.text, present: request.present }, null); return true;
    },
  };
})();
