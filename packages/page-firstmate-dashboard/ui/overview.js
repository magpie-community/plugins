window.FMOverview = (() => {
  const groups = [
    ['attention', '需要处理', ['needs-decision', 'blocked', 'failed']],
    ['active', '工作中', ['working']],
    ['waiting', '暂停等待', ['paused']],
    ['done', '已完成', ['done']],
    ['unknown', '状态未知', ['unknown']],
  ];
  const labels = {
    'needs-decision': '待决策', blocked: '已阻塞', failed: '失败',
    working: '工作中', paused: '暂停等待', done: '已完成', unknown: '状态未知',
  };
  const comparisons = { match: '与保存选择一致', difference: '与保存选择有差异', unknown: '缺少核对记录' };
  const shortDate = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const byId = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const stateOf = task => task.taskStatus?.state || 'unknown';
  const groupOf = task => groups.findIndex(([, , states]) => states.includes(stateOf(task)));
  const registeredTasks = home => home.records.filter(record => ['ship', 'scout'].includes(record.kind));
  const timestamp = task => Date.parse(task.taskStatus?.at || task.modified) || 0;
  const time = value => {
    const el = make('time', shortDate.format(new Date(value)));
    el.dateTime = value;
    el.title = new Date(value).toLocaleString('zh-CN');
    return el;
  };
  let activeHome = null;
  let tasks = [];
  let filter = 'all';
  let announceTimer;
  let showView;
  let returnContext;

  function viewChanged(view) {
    if (view === 'overview') returnContext = null;
    byId('task-return').hidden = !returnContext || !['dispatch', 'settings'].includes(view);
  }

  byId('task-return-button').addEventListener('click', () => {
    const origin = returnContext;
    if (!origin) return;
    showView('overview');
    const row = [...byId('task-list').querySelectorAll('details')].find(detail => detail.dataset.task === origin.id);
    if (row) row.open = true;
    (row?.querySelector(`[data-task-view="${origin.destination}"]`) || byId('overview-title')).focus();
  });

  function announce(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { byId('overview-announcement').textContent = text; }, 220);
  }

  function statusChip(task) {
    const chip = make('span', labels[stateOf(task)], 'task-status');
    chip.dataset.tone = groups[groupOf(task)][0];
    return chip;
  }

  function taskRow(task, open) {
    const detail = make('details', null, 'task-row');
    detail.dataset.task = task.id;
    detail.open = open;
    const summary = make('summary');
    const title = make('span', null, 'task-identity');
    title.append(make('strong', task.id), make('span', task.location?.machine || '机器未登记'));
    const recent = make('span', null, 'task-recent');
    if (task.taskStatus?.at) recent.append(time(task.taskStatus.at));
    else recent.textContent = '—';
    const arrow = make('span', null, 'task-chevron');
    arrow.setAttribute('aria-hidden', 'true');
    summary.append(title, statusChip(task), recent, arrow);
    const facts = make('dl', null, 'task-facts');
    const add = (label, value) => {
      const pair = make('div');
      const description = make('dd');
      description.append(value);
      pair.append(make('dt', label), description);
      facts.append(pair);
    };
    const evidence = task.dispatchEvidence;
    const seat = evidence?.seat === 'primary' ? '大副' : evidence?.seat === 'unspecified' ? null : evidence?.seat;
    add('监督席', seat || '未登记');
    add('任务类型', evidence?.taskType && evidence.taskType !== 'unspecified' ? evidence.taskType : '未登记');
    const configuration = profile => [profile.harness, profile.model, profile.effort].filter(Boolean).join(' · ');
    add('启动配置', configuration(task) || '未登记');
    if (evidence?.comparison === 'difference' && evidence.selected) add('派工选择', configuration(evidence.selected));
    add('派工核对', comparisons[evidence?.comparison] || comparisons.unknown);
    if (task.taskStatus?.until) add('计划复查', time(task.taskStatus.until));
    add('状态来源', task.taskStatus ? `state/${task.id}.status` : activeHome?.remote ? '远端状态未读取' : '没有可用的状态记录');
    const actions = make('div', null, 'task-actions');
    for (const [destination, label] of [['dispatch', '查看派工规则'], ['settings', '查看设置']]) {
      const button = make('button', label);
      button.type = 'button';
      button.dataset.taskView = destination;
      button.addEventListener('click', () => {
        returnContext = { id: task.id, destination };
        byId('task-return-label').textContent = [task.id, task.location?.machine].filter(Boolean).join(' · ');
        showView(destination);
        byId('task-return-button').focus();
      });
      actions.append(button);
    }
    detail.append(summary, facts, actions);
    return detail;
  }

  function paintTasks(shouldAnnounce = false) {
    const root = byId('task-list');
    const open = new Set([...root.querySelectorAll('details[open]')].map(row => row.dataset.task));
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const activeTask = focused?.closest('details')?.dataset.task;
    const query = byId('task-search').value.trim().toLowerCase();
    const visible = tasks.filter(task => {
      const fields = [task.id, task.location?.machine, task.harness, task.model, task.dispatchEvidence?.taskType, labels[stateOf(task)]];
      return (filter === 'all' || groups[groupOf(task)][0] === filter) &&
        fields.some(value => value?.toLowerCase().includes(query));
    });
    root.replaceChildren();
    if (visible.length) {
      const heading = make('div', null, 'task-columns');
      heading.setAttribute('aria-hidden', 'true');
      heading.append(make('span', '任务 / 机器'), make('span', '报告状态'), make('span', '报告时间'));
      root.append(heading, ...visible.map(task => taskRow(task, open.has(task.id))));
    } else {
      const message = tasks.length ? '没有符合条件的任务。' :
        activeHome?.readable ? '此 Home 暂无保留的任务登记。' : '此 Home 的任务记录暂不可用。';
      root.append(make('p', message, 'overview-empty'));
    }
    const count = `显示 ${visible.length} / ${tasks.length} 条任务`;
    byId('task-list-count').textContent = activeHome?.readable ? count : '任务数量未知';
    if (activeTask) {
      const control = focused.dataset.taskView ? `[data-task-view="${focused.dataset.taskView}"]` : 'summary';
      [...root.querySelectorAll('details')].find(row => row.dataset.task === activeTask)?.querySelector(control)?.focus({ preventScroll: true });
    }
    if (shouldAnnounce) announce(count);
  }

  function render({ homes, selected, observedAt, selectHome, showView: navigate }) {
    showView = navigate;
    const home = homes[selected];
    const switched = activeHome?.path !== home?.path || activeHome?.name !== home?.name;
    activeHome = home;
    byId('overview-content').hidden = !home;
    if (!home) {
      returnContext = null;
      viewChanged(document.body.dataset.view);
      byId('overview-snapshot').textContent = '';
      return;
    }
    if (switched) {
      filter = 'all';
      byId('task-search').value = '';
      byId('task-list').replaceChildren();
      byId('overview-announcement').textContent = '';
      clearTimeout(announceTimer);
    }
    tasks = registeredTasks(home).sort((a, b) => groupOf(a) - groupOf(b) || timestamp(b) - timestamp(a));
    if (returnContext && (switched || !tasks.some(task => task.id === returnContext.id))) {
      returnContext = null;
      viewChanged(document.body.dataset.view);
    }
    byId('overview-snapshot').replaceChildren(document.createTextNode(home.name));
    if (home.remote && home.readable) byId('overview-snapshot').append(' · 远端任务状态未读取');
    if (observedAt && home.readable) byId('overview-snapshot').append(' · 最近读取 ', time(observedAt));
    const metricRoot = byId('task-metrics');
    const focusedFilter = metricRoot.contains(document.activeElement) ? document.activeElement.dataset.filter : null;
    const metrics = [...groups, ['all', '全部任务']];
    metricRoot.hidden = !home.readable || Boolean(home.remote);
    metricRoot.replaceChildren(...metrics.map(([key, label, states]) => {
      const button = make('button', null, 'task-metric');
      button.type = 'button';
      button.dataset.filter = key;
      button.setAttribute('aria-pressed', String(filter === key));
      const number = states ? tasks.filter(task => states.includes(stateOf(task))).length : tasks.length;
      button.append(make('span', label), make('strong', number));
      button.addEventListener('click', () => {
        filter = key;
        for (const metric of metricRoot.children) metric.setAttribute('aria-pressed', String(metric === button));
        paintTasks(true);
      });
      return button;
    }));
    if (focusedFilter) [...metricRoot.children].find(button => button.dataset.filter === focusedFilter)?.focus({ preventScroll: true });
    const machineRoot = byId('overview-homes');
    const focusedHome = machineRoot.contains(document.activeElement) ? document.activeElement.dataset.index : null;
    machineRoot.replaceChildren(...homes.map((entry, index) => {
      const li = make('li');
      const button = make('button', null, 'machine-button');
      button.type = 'button';
      button.dataset.index = index;
      button.setAttribute('aria-pressed', String(index === selected));
      const name = make('span', null, 'machine-identity');
      name.append(make('strong', entry.machine), make('span', entry.name));
      const sample = registeredTasks(entry);
      const action = sample.filter(task => groupOf(task) === 0).length;
      const annotation = !entry.readable ? '未读取' : entry.remote ? '远端登记' : action ? `${action} 项待处理` : `${sample.length} 项任务`;
      const badge = make('span', annotation, 'machine-badge');
      if (action) badge.dataset.tone = 'attention';
      button.append(name, badge);
      button.addEventListener('click', () => {
        if (index !== selected) selectHome(index);
      });
      li.append(button);
      return li;
    }));
    if (focusedHome !== null) machineRoot.querySelector(`[data-index="${focusedHome}"]`)?.focus({ preventScroll: true });
    byId('task-search').oninput = () => paintTasks(true);
    paintTasks();
  }

  function refreshState(state) {
    byId('overview-panel').setAttribute('aria-busy', String(state === 'loading'));
    const message = byId('overview-message');
    message.textContent = {
      loading: '正在读取任务记录…', empty: '请在插件选项中配置工作 Home。',
      error: activeHome ? '刷新失败，以下为上次读取的记录。' : '任务记录读取失败，请使用「刷新」重试。',
    }[state] || '';
    message.hidden = !message.textContent;
  }

  return { render, refreshState, viewChanged };
})();
