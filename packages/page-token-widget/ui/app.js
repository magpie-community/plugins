(() => {
  const token = document.querySelector('meta[name="service-token"]')?.content || '';
  let current = null;
  const element = (id) => document.getElementById(id);
  const text = (id, value) => {
    const node = element(id);
    if (node) node.textContent = value;
  };

  const api = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: {
        'x-token-widget-token': token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`request failed: ${response.status}`);
    return response.json();
  };

  const copy = async (value, label) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      text('pairNote', `${label}已经复制到剪贴板。`);
    } catch {
      text('pairNote', `复制不了，请手动选中：${value}`);
    }
  };

  const renderFacts = (state) => {
    const rows = [];
    const add = (name, value) => rows.push(`<dt>${name}</dt><dd>${value}</dd>`);
    const tailnet = state.tailnet || {};
    add('服务地址', `<span class="mono">${state.serviceURL || '—'}</span>`);
    add(
      'Tailscale',
      tailnet.installed
        ? tailnet.connected
          ? '已连接'
          : `未连接（${tailnet.backendState || '未知'}）`
        : '没有安装'
    );
    add('尾网地址', `<span class="mono">${tailnet.tailnetIP || '—'}</span>`);
    const forward = state.forward || {};
    add(
      '尾网转发',
      forward.ready ? '已就绪，手机从尾网连进来' : `没有建好：${forward.error || '还不知道原因'}`
    );
    add(
      '同一网络里的 iPhone',
      tailnet.ios?.length ? tailnet.ios.map((phone) => phone.name).join('、') : '没有看到'
    );
    add('Magpie 网关', `<span class="mono">${state.upstream || '—'}</span>`);
    add('只读令牌', `<span class="mono">${state.token ? '••••••••••••••••' : '—'}</span>`);
    const facts = element('facts');
    if (facts) facts.innerHTML = rows.join('');
  };

  const renderSubscriptions = (state) => {
    const list = element('subscriptions');
    if (!list) return;
    list.innerHTML = '';
    const chosen = new Set(state.display?.subscriptions || []);
    const all = chosen.has('*');
    const items = state.subscriptions || [];
    for (const subscription of items) {
      const family = subscription.provider || subscription.id;
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = subscription.id;
      input.checked = all || chosen.has(family) || chosen.has(subscription.id);
      label.append(input, document.createTextNode(subscription.label || subscription.id));
      list.append(label);
    }
    list.onchange = async () => {
      const checked = new Set(
        [...list.querySelectorAll('input')]
          .filter((input) => input.checked)
          .map((input) => input.value)
      );
      // A family names all of its accounts, a name with an account names that
      // one. The list shows every account, and one of them is on when its
      // family or its own name is chosen.
      const families = new Map();
      for (const subscription of items) {
        const family = subscription.provider || subscription.id;
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(subscription.id);
      }
      const next = [];
      for (const [family, ids] of families) {
        const on = ids.filter((id) => checked.has(id));
        if (!on.length) continue;
        if (on.length === ids.length) next.push(family);
        else next.push(...on);
      }
      if (!next.length) {
        text('subNote', '至少要留一家订阅，中号和大号组件才有内容。');
        return;
      }
      try {
        const result = await api('api/v1/console/options', {
          method: 'POST',
          body: JSON.stringify({ subscriptions: next }),
        });
        state.display = result.display;
        text('subNote', '已经记下，手机上的组件下一次刷新就会跟着变。');
      } catch {
        text('subNote', '没有存上，请再试一次。');
      }
    };
  };

  const render = (state) => {
    current = state;
    const qr = element('qr');
    if (qr && state.qr) qr.src = state.qr;
    if (qr && !state.qr) qr.closest('.qr')?.classList.add('empty');
    text('pairingURL', state.pairingURL || '还没有找到 Tailscale 地址');
    text(
      'pairNote',
      state.pairingURL
        ? '配对码只能用一次。手机装好组件后它会自动失效，再生成一个就能装第二台。'
        : 'Tailscale 没有连上，或者这台电脑没有尾网地址。手机和电脑要在同一个 Tailscale 里。'
    );
    text(
      'lifetime',
      '组件随 Magpie 运行：关掉 Magpie 之后，手机上显示的是上一次的结果，重新打开 Magpie 就会更新。'
    );
    renderFacts(state);
    renderSubscriptions(state);
  };

  const load = async () => {
    try {
      render(await api('api/v1/console/state'));
    } catch {
      text('pairNote', '这个页面没有连上本机的额度服务，关掉插件页面再打开一次。');
    }
  };

  element('copyLink')?.addEventListener('click', () => copy(current?.pairingURL, '配对链接'));
  element('copyToken')?.addEventListener('click', () => copy(current?.token, '只读令牌'));
  element('rotate')?.addEventListener('click', async () => {
    try {
      render(await api('api/v1/console/pair', { method: 'POST' }));
    } catch {
      text('pairNote', '没有换成新的配对码，请再试一次。');
    }
  });

  load();
})();
