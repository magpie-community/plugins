import { pairingLeft, remainingText } from './timing.mjs';

(() => {
  const token = document.querySelector('meta[name="service-token"]')?.content || '';
  let current = null;
  // The saves go one after another. Two that travel at the same time would
  // each carry a list of its own, and the one that is answered last would be
  // the one that is kept: a tick that was undone would come back.
  let saveQueue = Promise.resolve();
  // The names are saved one after another as well, for the same reason.
  let nameQueue = Promise.resolve();
  // The subscriptions the user has turned off. They are written down in the
// state file, so one that is hidden does not come back by itself, not even
// when the whole list of Magpie is followed. The list is one for the whole
// page: the rows are drawn again and again, and a second copy of it would
// be a second truth that the rows and the saves do not agree on.
  const hidden = new Set();
  // How many changes the user has made to that list. A response that comes
  // back after a newer change does not overwrite that newer change: the
  // next request in the queue carries it.
  let hiddenRevision = 0;
  // The list is taken from the service, which is the one that keeps it.
  const syncHidden = (list) => {
    hidden.clear();
    for (const id of list || []) hidden.add(id);
  };
  // Whether a subscription is shown on the phone, as the page understands
  // it: the choice of the user in the list, and the ones that were turned
  // off. The rows and the putting back of a refused tick both use this, so
  // that the page cannot show something the service does not keep.
  const shownOf = (subscription, display = {}) => {
    const id = subscription?.id;
    if (!id) return false;
    const family = subscription.provider || id;
    if (hidden.has(id) || hidden.has(family)) return false;
    const chosen = Array.isArray(display.subscriptions) ? display.subscriptions : [];
    if (chosen.includes('*')) return true;
    return chosen.includes(id) || chosen.includes(family);
  };
  // The order the rows are drawn in: the order the user gave, then the ones
  // that are shown, then the ones that are turned off. The order the user
  // gave is the whole order, and it is written down apart from the list of
  // the shown ones: a row that is turned off keeps its place even when the
  // list of the shown ones holds only the ones that are shown.
  const rowOrder = (display = {}) => {
    const seen = new Set();
    const out = [];
    const entries = [
      ...(Array.isArray(display.subscriptionOrder) ? display.subscriptionOrder : []),
      ...(Array.isArray(display.subscriptions) ? display.subscriptions : []).filter(entry => entry !== '*'),
      ...(Array.isArray(display.subscriptionHidden) ? display.subscriptionHidden : []),
    ];
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
    return out;
  };
  // The cards the phone is shown, as the page understands them. The service
  // says it after a reading; after a change it is worked out here, so that
  // the picker of the small widget does not offer a card that is not there.
  const refreshShown = (state) => {
    state.shown = (state.subscriptions || [])
      .filter(subscription => shownOf(subscription, state.display))
      .map(subscription => subscription.id);
  };
  // The words of an error are shown to the person at the keyboard. The ones
  // that carry an address or the name of a machine are not shown: they are
  // said in a way that says nothing.
  const safeError = (message, fallback) => {
    const text = String(message || '').trim();
    if (!text || text.length > 200) return fallback;
    if (/https?:\/\//i.test(text) || /@/.test(text) || /[\\/]/.test(text)) return fallback;
    return text;
  };
  const element = (id) => document.getElementById(id);
  const text = (id, value) => {
    const node = element(id);
    if (node) node.textContent = value;
  };

  // Everything that comes from the outside is put into the page as text, never
  // as markup. The name of a peer in the tailnet is chosen by somebody else,
  // so it is treated as text.
  const node = (tag, className, content) => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (content !== undefined && content !== null) made.textContent = String(content);
    return made;
  };

  const mono = (value) => node('span', 'mono', value);

  // The page saves by itself, so the user has to be able to see that it did.
  // Every block that can be changed says what happened to the last change,
  // and when the change did not go through it offers to try again.
  const saveState = (id, tone, message, retry) => {
    const holder = element(id);
    if (!holder) return;
    holder.replaceChildren();
    holder.append(node('span', 'state ' + tone, message));
    if (retry) {
      const again = node('button', 'quiet', '重试');
      again.type = 'button';
      again.addEventListener('click', retry);
      holder.append(again);
    }
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
    if (!response.ok) {
      let message = `request failed: ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.error) message = body.error;
      } catch {
        // The answer is not json; the number is all there is.
      }
      throw new Error(message);
    }
    return response.json();
  };

  const copy = async (value, label) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      text('pairNote', `${label}已经复制到剪贴板。`);
    } catch {
      // The Magpie window runs this page in a sandboxed frame, and the
      // clipboard wants a focused document. The text is selected instead,
      // so the copy itself is one shortcut away.
      const target = element('pairingURL');
      if (target && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        text('pairNote', `复制不了，已经帮你选中，按 ⌘C（ctrl+C）复制：${value}`);
      } else {
        text('pairNote', `复制不了，请手动选中：${value}`);
      }
    }
  };

  // The Magpie window runs this page inside a sandboxed frame, and a sandbox
  // without "allow-modals" swallows window.confirm: the browser writes
  // "Ignored call to 'confirm()'" into the log and the call answers false,
  // so the button looks dead. The question is asked inside the row instead.
  const askInRow = (row, holder, question, yesLabel, run) => {
    const ask = node('span', 'ask');
    const yes = node('button', 'danger', yesLabel);
    yes.type = 'button';
    const no = node('button', 'quiet', '算了');
    no.type = 'button';
    const putBack = () => {
      // The row may have been drawn again while the question was open; then
      // there is nothing to put back.
      if (ask.parentNode === row) row.replaceChild(holder, ask);
    };
    yes.addEventListener('click', async () => {
      putBack();
      await run();
    });
    no.addEventListener('click', putBack);
    ask.append(node('span', 'ask-question', question), yes, no);
    row.replaceChild(ask, holder);
  };

  const KIND_LABEL = {
    tailscale: 'Tailscale',
    wifi: '无线',
    ethernet: '有线',
    virtual: '虚拟',
    loopback: '回环',
    other: '其他',
  };

  const PATH_LABEL = {
    direct: '直连（端到端加密）',
    relay: '经由尾网中继设备',
    derp: '经由 Tailscale 中继服务器',
    unknown: '还不知道',
    offline: '不在线',
  };

  const timeOf = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { hour12: false });
  };

  // A list of name and value. Both of them are text.
  const fillFacts = (target, rows) => {
    const list = element(target);
    if (!list) return;
    list.replaceChildren();
    for (const [name, value, cellId] of rows) {
      list.append(node('dt', null, name));
      const cell = node('dd');
      if (cellId) cell.id = cellId;
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
      list.append(cell);
    }
  };

  const renderFacts = (state) => {
    const tailnet = state.tailnet || {};
    const forward = state.forward || {};
    fillFacts('facts', [
      ['服务地址', mono(state.serviceURL || '—')],
      [
        'Tailscale',
        tailnet.installed
          ? tailnet.connected
            ? '已连接'
            : `未连接（${tailnet.backendState || '未知'}）`
          : '没有安装',
      ],
      ['尾网地址', mono(tailnet.tailnetIP || '—')],
      ['MagicDNS', mono(tailnet.dnsName || '—')],
      ['本机连接路径', PATH_LABEL[tailnet.path] || PATH_LABEL.unknown],
      [
        '尾网转发',
        forward.ready ? '已就绪，手机从尾网连进来' : `没有建好：${forward.error || '还不知道原因'}`,
      ],
      [
        '同一网络里的 iPhone',
        tailnet.ios?.length ? tailnet.ios.map((phone) => phone.name).join('、') : '没有看到',
      ],
      ['Magpie 网关', mono(state.upstream || '—')],
    ]);
  };

  // The user may have a network of his own: a Headscale of his own, a
  // server of his own, a tunnel of his own. The address the phone is told to
  // use is written down here, and the phone side may listen on an address of
  // this computer.
  const renderOwnNetwork = (state) => {
    const external = state.external || {};
    const field = element('external');
    if (field && document.activeElement !== field) field.value = external.url || '';
    const note = element('externalNote');
    if (note) {
      const parts = [];
      const mode = external.mode || 'tailscale';
      if (mode === 'tailscale') {
        parts.push('现在的连法：Tailscale。手机从尾网地址连进来。');
      } else if (mode === 'https') {
        parts.push(`现在的连法：自己的 HTTPS 地址 ${external.url}。数据是加密的，令牌也走在加密里。`);
      } else if (mode === 'lan') {
        parts.push(`现在的连法：自己的内网 ${external.url}。`);
      } else {
        parts.push(`现在的连法：自己的地址 ${external.url}。`);
      }
      if (external.url && mode !== 'tailscale') {
        parts.push('留空就用 Tailscale 的地址。');
      }
      if (external.listenAddress) {
        parts.push(`手机那一侧的端口已经在 ${external.listenAddress} 上打开。`);
      }
      if (external.error) parts.push(external.error);
      if (external.listenError) parts.push(external.listenError);
      if (mode !== 'https') {
        parts.push('这条路上的数据是明文的 HTTP，令牌就走在里面；iPhone 会问你要「本地网络」的权限。');
      }
      parts.push('只有 HTTPS 地址可以随便写域名；明文 HTTP 只认内网地址、Tailscale 地址和本机回环地址。');
      note.textContent = parts.join(' ');
    }
    const list = element('bindList');
    if (!list) return;
    list.replaceChildren();
    const candidates = external.candidates || [];
    text('bindSummary', `手机可以从这里连（${candidates.length} 个地址）`);
    if (!candidates.length) {
      list.append(node('p', 'note', '没有找到这台电脑上可以给手机用的地址。'));
      return;
    }
    for (const item of candidates) {
      const row = node('div', 'row');
      row.append(node('strong', null, item.name));
      row.append(node('span', 'tag', KIND_LABEL[item.kind] || KIND_LABEL.other));
      row.append(node('span', 'mono', item.address));
      const use = node('button', null, '手机从这里连');
      use.type = 'button';
      use.addEventListener('click', () => { void useOwnAddress(item.address, row, use); });
      row.append(use);
      list.append(row);
    }
  };

  // The phone is told to go to an address of this computer, and the phone
  // side starts listening there.
  const useOwnAddress = async (address, row, trigger) => {
    try {
      const port = current?.phonePort;
      const host = address.includes(':') ? `[${address}]` : address;
      const url = port ? `http://${host}:${port}` : '';
      const before = current?.external?.url || '';
      const write = async () => {
        // The question is answered later, outside this try, so the refusal of
        // the service has to be caught here.
        try {
          await api('api/v1/console/options', {
            method: 'POST',
            body: JSON.stringify({
              listenAddress: address,
              externalURL: url,
            }),
          });
          await load();
        } catch (error) {
          text('externalNote', error.message || '这个地址没有用。');
        }
      };
      // The question is asked in the row: a window.confirm does not survive
      // the sandbox of the Magpie window.
      if (before && before !== url && row && trigger) {
        askInRow(row, trigger, `把手机换成 ${url}？原来填的地址会换掉。`, '换地址', write);
        return;
      }
      await write();
    } catch (error) {
      text('externalNote', error.message || '这个地址没有用。');
    }
  };

  const saveOwnAddress = async () => {
    const field = element('external');
    if (!field) return;
    try {
      await api('api/v1/console/options', {
        method: 'POST',
        body: JSON.stringify({ externalURL: field.value.trim() }),
      });
      await load();
    } catch (error) {
      text('externalNote', error.message || '这个地址写不了。');
    }
  };

  const renderNetwork = (state) => {
    const tailnet = state.tailnet || {};
    const peers = element('peers');
    if (peers) {
      peers.replaceChildren();
      const list = tailnet.ios || [];
      // The list of the phones of the tailnet is folded away; the number on
      // the lid says how many are in there.
      text('peersSummary', `尾网里的 iPhone（${list.length} 台）`);
      if (!list.length) {
        peers.append(node('p', 'note', '尾网里没有看到 iPhone。手机要和电脑在同一个 Tailscale 里。'));
      }
      for (const phone of list) {
        const row = node('div', 'row');
        row.append(node('strong', null, phone.name));
        row.append(node('span', 'mono', (phone.ips || []).join('、') || '没有地址'));
        row.append(node('span', 'tag', PATH_LABEL[phone.path] || PATH_LABEL.unknown));
        peers.append(row);
      }
    }

    const interfaces = element('interfaces');
    if (interfaces) {
      interfaces.replaceChildren();
      const list = tailnet.interfaces || [];
      // This list grows with the machine: a workstation has a dozen of them
      // and a phone has none. It stays folded until somebody asks for it.
      text('interfacesSummary', `这台电脑的网卡（${list.length} 张）`);
      if (!list.length) {
        interfaces.append(node('p', 'note', '没有读到这台电脑的网卡。'));
      }
      for (const item of list) {
        const row = node('div', 'row');
        const names = node('span', 'tag', KIND_LABEL[item.kind] || KIND_LABEL.other);
        row.append(node('strong', null, item.name), names);
        const addresses = [...(item.ipv4 || []), ...(item.ipv6 || [])].map(
          (address) => `${address.address}/${address.prefix}`
        );
        row.append(node('span', 'mono', addresses.join('、') || '没有地址'));
        interfaces.append(row);
      }
    }

    const lan = tailnet.lan || [];
    const lanNote = element('lanNote');
    if (lanNote) {
      lanNote.textContent = lan.length
        ? `家里网络上的地址：${lan
            .map((item) => `${item.name} ${(item.addresses || []).join('、')}`)
            .join('；')}。这些地址只是给这台电脑做诊断看的，手机不会走它们——手机默认走 Tailscale，流量是端到端加密的。`
        : '没有找到家里网络上的地址（RFC1918 网段）。手机默认走 Tailscale。';
    }
  };

  const renderDevices = (state) => {
    const list = element('devices');
    if (!list) return;
    list.replaceChildren();
    // The phones that are gone are put at the end, so the ones that still
    // work are the first ones to be read.
    const devices = [...(state.devices || [])].sort(
      (one, other) => Number(Boolean(one.revokedAt)) - Number(Boolean(other.revokedAt))
    );
    if (!devices.length) {
      list.append(node('p', 'note', '还没有手机配对过。'));
      return;
    }
    for (const device of devices) {
      const row = node('div', device.revokedAt ? 'row device gone' : 'row device');
      const name = node('input');
      name.type = 'text';
      name.value = device.name || '';
      name.setAttribute('aria-label', '设备名称');
      name.setAttribute('size', '12');
      name.className = 'device-name';
      row.append(name);
      const meta = node('span', 'note');
      // The row is one line, so the date is short: the year is the same for
      // every row and the second is of no use to anybody.
      const shortTime = value => timeOf(value).replace(/^\d{4}\//, '').replace(/:\d{2}$/, '');
      meta.textContent = [
        `配对 ${shortTime(device.createdAt)}`,
        device.lastAccessAt ? `最后 ${shortTime(device.lastAccessAt)}` : '还没用过',
        device.revokedAt ? `已撤销 ${shortTime(device.revokedAt)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      row.append(meta);
      const actions = node('span', 'actions');
      const rename = node('button', 'quiet', '改名');
      rename.type = 'button';
      rename.addEventListener('click', async () => {
        try {
          const result = await api('api/v1/console/device', {
            method: 'POST',
            body: JSON.stringify({ id: device.id, action: 'rename', name: name.value }),
          });
          if (current) current.devices = result.devices;
          text('deviceNote', '名字改好了。');
          renderDevices(current || {});
        } catch {
          text('deviceNote', '没有改成功，请再试一次。');
        }
      });
      actions.append(rename);
      // Revoking stops the phone; the row stays, as a record of it.
      if (!device.revokedAt) {
        const revoke = node('button', 'danger', '撤销');
        revoke.type = 'button';
        revoke.addEventListener('click', () => {
          askInRow(
            row,
            actions,
            `撤销「${device.name}」之后，这台手机上的组件就读不到用量了。`,
            '撤销',
            async () => {
              try {
                const result = await api('api/v1/console/device', {
                  method: 'POST',
                  body: JSON.stringify({ id: device.id, action: 'revoke' }),
                });
                if (current) current.devices = result.devices;
                text('deviceNote', '已经撤销这一台。别的手机不受影响。');
                renderDevices(current || {});
              } catch {
                text('deviceNote', '没有撤销成功，请再试一次。');
              }
            }
          );
        });
        actions.append(revoke);
      } else {
        // A revoked phone can be taken off the list for good. The server
        // refuses to delete a phone that is still in use: revoking first is
        // what stops it.
        const remove = node('button', 'danger', '删除');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          askInRow(
            row,
            actions,
            `把「${device.name}」这一行从名单里删掉？它已经被撤销了，删掉只是不再占地方。`,
            '删掉',
            async () => {
              try {
                const result = await api('api/v1/console/device', {
                  method: 'POST',
                  body: JSON.stringify({ id: device.id, action: 'delete' }),
                });
                if (current) current.devices = result.devices;
                text('deviceNote', '已经删掉了。别的手机不受影响。');
                renderDevices(current || {});
              } catch (error) {
                // The server says why it refused; the page says it in the
                // language of the page.
                const reason = String(error?.message || '');
                text('deviceNote', reason.includes('Revoke')
                  ? '这台手机还在用：先撤销它，再删。'
                  : reason.includes('Not found')
                    ? '这一行已经不在名单上了。'
                    : '没有删掉，请再试一次。');
              }
            }
          );
        });
        actions.append(remove);
      }
      row.append(actions);
      list.append(row);
    }
  };

  const renderRefresh = (state) => {
    const box = element('refresh');
    if (!box) return;
    box.replaceChildren();
    const chosen = state.refresh?.strategy || 'smart';
    for (const option of state.refresh?.options || []) {
      const label = node('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'refresh-strategy';
      input.value = option.id;
      input.checked = option.id === chosen;
      input.addEventListener('change', async () => {
        try {
          const result = await api('api/v1/console/options', {
            method: 'POST',
            body: JSON.stringify({ refreshStrategy: option.id }),
          });
          if (current) current.refresh = result.refresh;
          text('refreshNote', `已经换成「${option.label}」，下一次刷新就照新的来，不用重启服务。`);
        } catch {
          text('refreshNote', '没有换成功，请再试一次。');
        }
      });
      label.append(input, document.createTextNode(option.label));
      box.append(label);
    }
    text(
      'refreshNote',
      state.refresh?.strategy === 'smart'
        ? '智能更新：有人看的时候一分钟一次，没人看的时候慢下来。过期了手机来问，服务会先刷新一次，最多等两三秒。'
        : `已经换成「${state.refresh?.label || ''}」。`
    );
  };

  const renderAdvanced = (state) => {
    const forward = state.forward || {};
    fillFacts('advanced', [
      ['服务端口', mono(String(state.port ?? '—'))],
      ['手机端口', mono(String(state.phonePort ?? '—'))],
      ['Magpie 网关', mono(state.upstream || '—')],
      ['配对码剩余时间', remainingText(pairingLeft(state)), 'pairRemaining'],
      ['本插件的转发', forward.owned ? mono(`${forward.owned.publishedPort} → ${forward.owned.target}`) : '还没有记录'],
      ['配对记录', `${(state.paired || []).length} 条`],
    ]);
    text(
      'portNote',
      '端口和网关都是 Magpie 启动这个插件时给的参数：插件改不了自己听的端口，也改不了它去读的 Magpie，' +
        '所以它们在这里只看不改。要换，在 Magpie 的插件设置里改' +
        '（magpie plugin options @magpie-community/page-token-widget \'{"port":8890,"gatewayURL":"http://127.0.0.1:3500"}\'），' +
        '改完重启 Magpie；手机那边的地址带着端口，换了端口手机要重新配对一次。'
    );
  };

  // The names the user gives to the subscriptions. They are kept here and not
  // only in the fields of the page, so that a name that is being written is
  // not lost when the rows are drawn again.
  const nameFields = new Map();

  const renderSubscriptions = (state) => {
    const list = element('subscriptions');
    if (!list) return;
    list.replaceChildren();
    const chosen = new Set(state.display?.subscriptions || []);
    const all = chosen.has('*');
    const items = state.subscriptions || [];
    // The note says which of the two ways is in use, so that a subscription
    // that does not show up is not a mystery.
    const modeNote = following => {
      const mode = element('subMode');
      if (!mode) return;
      mode.textContent = following
        ? '现在跟着 Magpie 的订阅列表走：在 Magpie 里新增的订阅，下一次刷新就出现；删掉的也自己消失。你手动取消勾选的那几家会被记住，不会自己回来。'
        : '现在只显示勾上的这几家：在 Magpie 里新增的订阅不会自己出现，要在这里勾上才显示；你手动取消勾选的那几家会被记住，换回「全部订阅」时也不会自己回来。';
    };
    // Every account knows the vendor it belongs to. A vendor that is chosen
    // as a whole stands at the place of its first account.
    const familyOf = new Map(items.map(subscription => [subscription.id, subscription.provider || subscription.id]));
    // The order the user has given is the order of the cards on the phone and
    // in the widget, so the rows are drawn in that order and not in the order
    // the gateway happens to list them.
    const ordered = [];
    const seen = new Set();
    // The order of the rows is the order the phone follows. The whole order
    // is kept as it is: the rows that are turned off are written down after
    // the ones that are shown, but the order the user gave is the one that
    // is remembered, so a row that is turned off keeps its place even when
    // the list of the shown ones is written down again.
    const order = rowOrder(state.display || {});
    for (const entry of order) {
      for (const subscription of items) {
        const id = subscription.id;
        if (seen.has(id)) continue;
        if (entry === familyOf.get(id) || entry === id) {
          ordered.push(subscription);
          seen.add(id);
        }
      }
    }
    for (const subscription of items) if (!seen.has(subscription.id)) ordered.push(subscription);
    // A row is ticked when its subscription is shown on the phone. When the
    // whole list of Magpie is followed, everything is shown but the
    // subscriptions the user has turned off; in the other way, only the
    // ticked ones are shown.
    const isShown = subscription => shownOf(subscription, state.display);
    // The rows can be dragged into another order. The order is what the phone
    // and the widget follow, so it is written back with the selection.
    let dragging = null;
    // The rows are read in the order they are on the page, so a dragged row
    // is where it was put. Every row is written down as the account it is:
    // two accounts of one vendor can stand in any order the user gives them,
    // and a vendor written down as a vendor would put its accounts back in
    // the order the service happens to know them.
    const collect = () => {
      const checked = new Set(
        [...list.querySelectorAll('input')]
          // The first row is the whole list, not one of the subscriptions.
          .filter((input) => input.checked && !input.classList.contains('follow'))
          .map((input) => input.value)
      );
      const next = [];
      for (const row of list.querySelectorAll('label')) {
        const input = row.querySelector('input');
        if (!input || input.classList.contains('follow')) continue;
        const id = input.value;
        if (checked.has(id)) next.push(id);
      }
      return next;
    };
    // Every row of the list, in the order the page shows them, the ones
    // that are turned off among them. When the whole list of Magpie is
    // followed, this is the order that is written down: a row that is turned
    // off and then turned on again stands where the user put it, not at the
    // end of the list.
    const rows = () => {
      const next = [];
      for (const row of list.querySelectorAll('label')) {
        const input = row.querySelector('input');
        if (!input || input.classList.contains('follow')) continue;
        next.push(input.value);
      }
      return next;
    };
    // The names are sent one after another. Two names that travel at the
    // same time would each carry a map of its own, and the second one would
    // take the name of the first one with it: the service keeps the map it
    // is given, so a name that is not in it is gone. One name waits for the
    // one before it, and each one starts from what the last one was given.
    const sendName = (id, value) => {
      const send = async () => {
        const names = { ...(state.display?.names || {}) };
        if (value) names[id] = value;
        else delete names[id];
        const result = await api('api/v1/console/options', {
          method: 'POST',
          body: JSON.stringify({ names }),
        });
        state.display = result.display;
      };
      nameQueue = nameQueue.then(send, send);
      return nameQueue;
    };
    const save = async (input) => {
      const run = async () => {
        // The first row is the whole list: the subscriptions of Magpie are
        // followed, so one that is added shows up and one that is removed
        // goes away by itself. The rows below it are the ones that are picked.
        const follow = list.querySelector('input.follow');
        // The star says "and everything else", and the subscriptions that are
        // written down after it keep the order the user has given them. When
        // the whole list is followed, every row is written down, the ones
        // that are turned off among them: the order of the page is the order
        // that is kept, and a row that is turned off keeps its place.
        const next = follow && follow.checked ? ['*', ...rows()] : collect();
        // At least one subscription has to be left: the widgets would have
        // nothing to show. The row that was put back is not remembered as one
        // that was turned off. When there is no row at all — the list of the
        // gateway is not known yet — there is nothing to keep, and the choice
        // itself is written down.
        const boxes = [...list.querySelectorAll('input')]
          .filter(box => !box.classList.contains('follow'));
        const shown = boxes.filter(box => box.checked).length;
        if (boxes.length && !shown) {
          // Nothing would be left on the widget, so the last one is put back.
          if (input) input.checked = true;
          // A row that was put back is not remembered as one that was turned
          // off.
          if (input && !input.classList.contains('follow')) hidden.delete(input.value);
          saveState('subNote', 'bad', '至少要留一家订阅，中号和大号组件才有内容。');
          return;
        }
        saveState('subNote', 'busy', '保存中…');
        // The number of the change this request carries. A response that
        // comes back after a newer change was made does not overwrite that
        // newer change: the next request in the queue carries it.
        const revision = hiddenRevision;
        try {
          const result = await api('api/v1/console/options', {
            method: 'POST',
            // The subscriptions that were turned off go with it: they are
            // written down, so they do not come back by themselves.
            // The whole order of the rows goes with it as well: the list of
            // the shown ones only holds the ones that are shown, and a row
            // that is turned off would lose its place without it.
            body: JSON.stringify({
              subscriptions: next,
              subscriptionHidden: [...hidden],
              subscriptionOrder: rows(),
            }),
          });
          // A response that comes back after a newer change was made is
          // about an older state: it does not overwrite the newer change,
          // which is not yet written down and must not be lost. The next
          // request in the queue carries it.
          if (hiddenRevision === revision) {
            state.display = result.display;
            // The service may have refused a name it does not accept. What
            // it really keeps is what the page goes by from now on.
            syncHidden(result.display?.subscriptionHidden || []);
            // The rows are not drawn again: the order on the page is the
            // order that was sent, and drawing them again would take the
            // name that is being written out of its field. The ticks are
            // brought in line with what the service really keeps, by the
            // rule the rows are drawn by.
            for (const row of list.querySelectorAll('label.sub')) {
              const box = row.querySelector('input');
              if (!box || box.classList.contains('follow')) continue;
              const subscription = (state.subscriptions || [])
                .find(entry => entry.id === box.value);
              if (subscription) box.checked = shownOf(subscription, state.display);
            }
            if (follow) follow.checked = (state.display?.subscriptions || []).includes('*');
            // The cards the phone is shown are worked out again: the picker
            // of the small widget offers only the cards that are really
            // there.
            refreshShown(state);
            renderWidgetCard(state);
            // The note says which of the two ways is in use. It is written
            // again here: the rows are not drawn again, so it would still
            // speak of the way that was left behind.
            modeNote(Boolean(follow && follow.checked));
          }
          saveState('subNote', 'ok', '已经记下，手机上的组件下一次刷新就会跟着变。');
        } catch (error) {
          // Nothing was written. The rows are not drawn again: the tick that
          // was refused is put back the way the service really keeps it, and
          // the name that is being written stays in its field. A change that
          // was made after this request went out is not put back: it is not
          // this request that was refused, and it is still on its way.
          if (hiddenRevision === revision) {
            syncHidden(state.display?.subscriptionHidden || []);
            if (input && input.type === 'checkbox') {
              if (input.classList.contains('follow')) {
                input.checked = (state.display?.subscriptions || []).includes('*');
              } else {
                // The tick is put back the way the service really keeps it:
                // the rows and this put back go by one rule only.
                const subscription = (state.subscriptions || [])
                  .find(entry => entry.id === input.value);
                input.checked = subscription
                  ? shownOf(subscription, state.display)
                  : !hidden.has(input.value);
              }
            }
          }
          // The note says which of the two ways is in use. It is written
          // again here: the way that was refused is not the way that is in
          // use any more.
          const follow = list.querySelector('input.follow');
          modeNote(Boolean(follow && follow.checked));
          saveState('subNote', 'bad', safeError(error?.message, '没有存上，请再试一次。'), () => { void save(input); });
        }
      };
      // The saves wait for one another, so that the one that is answered
      // last is the one that is kept.
      saveQueue = saveQueue.then(run, run).catch(() => {});
      return saveQueue;
    };
    // The first row: the whole list of Magpie, followed. It is the way the
    // plugin is meant to be used, so it is the first thing the user sees.
    const followRow = document.createElement('label');
    followRow.className = 'sub follow';
    const followInput = document.createElement('input');
    followInput.type = 'checkbox';
    followInput.className = 'follow';
    followInput.value = '*';
    followInput.checked = all;
    followRow.append(followInput, node('span', 'name', '全部订阅（跟着 Magpie 走）'));
    list.append(followRow);
    for (const subscription of ordered) {
      // The name the user gives the subscription is his own: it is what the
      // widget and the phone show for it. It stands under the row, so that
      // the row itself keeps the order it is dragged into.
      const row = document.createElement('div');
      row.className = 'sub-row';
      const label = document.createElement('label');
      label.className = 'sub';
      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '⠿';
      // The order of the cards is the order the user has given, in both ways
      // of choosing. The handle is therefore always there.
      grip.title = '拖着换顺序';
      grip.draggable = true;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = subscription.id;
      input.checked = isShown(subscription);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = subscription.label || subscription.id;
      label.append(grip, input, name);
      // A subscription that the gateway only just told about is marked, so
      // that the person at the keyboard sees that something is new.
      if (state.newSubscriptions?.has(subscription.id)) {
        label.append(node('span', 'tag', '新'));
      }
      // The small widget is told which card to show with a parameter. The
      // names it understands are written here, so an old one (an account that
      // was renamed) can be seen and replaced.
      const names = [subscription.provider || subscription.id];
      if (subscription.account) names.push(subscription.id);
      const hint = document.createElement('span');
      hint.className = 'tag param';
      hint.textContent = '参数 ' + names.join(' / ');
      label.append(hint);
      // The drag lives on the little handle, so the row itself stays a row:
      // the checkbox keeps working and the text can still be picked. The
      // handle must not press the checkbox either, so the default of the
      // click is taken away.
      grip.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
      });
      grip.addEventListener('dragstart', event => {
        dragging = row;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', '');
        event.dataTransfer.setDragImage(row, 12, 12);
      });
      grip.addEventListener('dragend', () => {
        dragging = null;
        row.classList.remove('dragging');
        for (const marked of list.querySelectorAll('.over')) marked.classList.remove('over');
      });
      label.addEventListener('dragover', event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        label.classList.add('over');
      });
      label.addEventListener('dragleave', () => label.classList.remove('over'));
      label.addEventListener('drop', event => {
        event.preventDefault();
        label.classList.remove('over');
        if (!dragging || dragging === row) return;
        const rows = [...list.querySelectorAll('.sub-row')];
        const from = rows.indexOf(dragging);
        const to = rows.indexOf(row);
        if (from < 0 || to < 0) return;
        // The dragged row goes where it was dropped: below the row it was
        // dropped on, or above it.
        if (to > from) rows[to].after(dragging);
        else rows[to].before(dragging);
        dragging = null;
        void save();
      });
      // The name of the subscription, the one the user gives it. It is saved
      // while it is written, so that the user sees at once that the name is
      // taken. It is the name the card carries on the phone and in the
      // widget.
      const stored = (state.display?.names || {})[subscription.id] || '';
      const field = nameFields.get(subscription.id) || { value: stored, saved: stored, timer: 0 };
      nameFields.set(subscription.id, field);
      const rename = document.createElement('input');
      rename.type = 'text';
      rename.className = 'sub-name';
      rename.maxLength = 32;
      rename.placeholder = '自定义名称（留空就用软件里的名字）';
      rename.title = '手机上显示的名字，留空就用软件里的名字';
      rename.value = field.value;
      const write = async (value) => {
        saveState('subNote', 'busy', '保存中…');
        try {
          await sendName(subscription.id, value);
          field.saved = value;
          saveState('subNote', 'ok', '已经记下，手机上的组件下一次刷新就会跟着变。');
        } catch {
          saveState('subNote', 'bad', '没有存下这个名字，请再试一次。', () => { void write(value); });
        }
      };
      // The wait is short enough not to be in the way and long enough not to
      // send a request for every letter.
      const schedule = () => {
        field.value = rename.value;
        clearTimeout(field.timer);
        field.timer = setTimeout(() => {
          const value = String(field.value || '').trim();
          if (value === field.saved) return;
          void write(value);
        }, 400);
      };
      rename.addEventListener('input', schedule);
      // The field that is left is written out at once: the user does not have
      // to wait for the timer to say that the name is taken.
      rename.addEventListener('change', () => {
        clearTimeout(field.timer);
        field.value = rename.value;
        const value = String(field.value || '').trim();
        if (value === field.saved) return;
        void write(value);
      });
      row.append(label, rename);
      list.append(row);
    }
    modeNote(all);
    // A subscription that the user turned off can be shown on the phone all
    // the same: the widgets need something to show, and that floor is under
    // the choice of the user. When it happens, the page says so: a card
    // that comes back without being asked for is not a mystery.
    const warning = element('subWarn');
    if (warning) {
      const onThePhone = new Set(Array.isArray(state.shown) ? state.shown : []);
      const back = (state.subscriptions || []).filter((subscription) => {
        const id = subscription?.id;
        if (!id || !onThePhone.has(id)) return false;
        return hidden.has(id) || hidden.has(subscription.provider || id);
      });
      warning.textContent = back.length
        ? `你关掉的「${back.map(subscription => subscription.label || subscription.id).join('、')}」又在手机上出现了：手机上永远至少要留一家可看，勾上别的家以后它就会回去。`
        : '';
    }
    // The list of the subscriptions is read at a certain time. The page says
    // when, so that an old list is not passed for a new one.
    const reading = state.reading || {};
    const note = element('subsRefreshNote');
    if (note) {
      const stamp = reading.observedAt ? new Date(reading.observedAt) : null;
      const when = stamp && !Number.isNaN(stamp.getTime())
        ? stamp.toLocaleTimeString('zh-CN', { hour12: false })
        : '';
        // A gateway that answered and said that it has no subscription at
        // all is not a gateway that failed: the list is empty, and it is
        // said to be empty.
        const nothing = reading.answered && reading.empty && !reading.count;
      // A list that could not be read is an old one, and it is said so: an
      // old list is never passed for a new one. A list that was never read is
      // not an old one either: it is an unknown one.
      note.textContent = !reading.observedAt
        ? '还没有读过网关的订阅名单，点上面的按钮读一次。'
          : nothing
            ? `网关的订阅名单读于 ${when}，网关现在没有可读订阅。`
        : reading.stale
          ? `这是上一次读到的订阅名单（${when || '时间不详'}），网关这次没有给出新的。点上面的按钮重读一次。`
          : `网关的订阅名单读于 ${when}，点上面的按钮重读一次。`;
    }
    list.onchange = (event) => {
      // The name of a subscription is saved by its own field.
      if (event.target && event.target.type === 'text') return;
      const input = event.target;
      // A subscription that is not ticked is one the user has turned off. It
      // is written down, so it does not come back by itself, not even when
      // the whole list of Magpie is followed.
      if (input && input.type === 'checkbox' && !input.classList.contains('follow')) {
        const subscription = (state.subscriptions || [])
          .find(entry => entry.id === input.value);
        if (input.checked) {
          // It is turned on again: it leaves the list of the turned off ones.
          // A vendor that was turned off as a whole leaves it as well, and
          // the other accounts of that vendor stay off: the user turned this
          // one on, not the whole vendor.
          hidden.delete(input.value);
          const family = subscription?.provider || subscription?.id;
          if (family && hidden.has(family)) {
            hidden.delete(family);
            for (const other of state.subscriptions || []) {
              if ((other.provider || other.id) === family && other.id !== input.value) hidden.add(other.id);
            }
          }
        } else {
          hidden.add(input.value);
        }
        // The user has changed something: the answer of a request that is
        // on its way does not overwrite it.
        hiddenRevision += 1;
      }
      void save(input);
    };
  };

  // The direction of the numbers and the card of the small widget are chosen
  // here, on the plugin side. The Scriptable parameter may still say
  // otherwise, so one widget on the phone can differ from the others.
  // They are two blocks of their own: the direction is for every size of the
  // widget, and the card is for the small one only. One list of radios for
  // both of them could not be read: which of the two a choice belonged to
  // was not written anywhere.
  const renderWidgetMode = (state) => {
    const list = element('widgetMode');
    if (!list) return;
    list.replaceChildren();
    const display = state.display || {};
    const current = display.widgetMode || 'remaining';
    const choice = (value, label) => {
      const wrapper = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'widget-mode';
      input.value = value;
      input.checked = value === current;
      wrapper.append(input, node('span', 'name', label));
      list.append(wrapper);
    };
    choice('remaining', '剩余：还有多少');
    choice('used', '已用：用了多少');
    const apply = async (value) => {
      saveState('widgetModeNote', 'busy', '保存中…');
      try {
        const result = await api('api/v1/console/options', {
          method: 'POST',
          body: JSON.stringify({ widgetMode: value }),
        });
        state.display = result.display;
        // The rows are drawn again, so the radio stands where the service
        // really keeps it.
        renderWidgetMode(state);
        saveState('widgetModeNote', 'ok', '已经记下，三种尺寸的组件下一次刷新就跟着变。');
      } catch {
        saveState('widgetModeNote', 'bad', '没有存上，请再试一次。', () => { void apply(value); });
        // Nothing was saved, so the radio is put back where it was.
        renderWidgetMode(state);
      }
    };
    list.onchange = (event) => {
      const input = event.target;
      if (!input || input.type !== 'radio') return;
      void apply(input.value);
    };
  };

  // The list of the subscriptions is read again from the gateway, so that a
  // subscription that was added to Magpie shows up at once, and not with the
  // next reading of the numbers.
  const refreshSubscriptions = async () => {
    const button = element('refreshSubs');
    // The rows are held still while the gateway is read: a tick that is
    // made in between would be taken back by the drawing that follows.
    const boxes = [...(element('subscriptions')?.querySelectorAll('input') || [])];
    for (const box of boxes) box.disabled = true;
    // The rows cannot be dragged either: an order that is given in between
    // would be taken back by the drawing that follows.
    const grips = [...(element('subscriptions')?.querySelectorAll('.grip') || [])];
    for (const grip of grips) grip.draggable = false;
    if (button) button.disabled = true;
    saveState('subsRefreshNote', 'busy', '正在读网关…');
    try {
      // A save that is on its way is waited for: the rows are drawn again
      // after the reading, and a tick that was not stored yet would be taken
      // back by the drawing.
      await saveQueue;
      // A name that is being written is waited for as well: the drawing
      // that follows would take it out of its field.
      await nameQueue;
      const result = await api('api/v1/console/subscriptions/refresh', { method: 'POST', body: '{}' });
      if (current) {
        if (!result.ok) {
          // The reading failed: the list below is the one that was there.
          // It is not replaced by an empty one, and it is not passed for a
          // new one either.
          current.reading = { ...(current.reading || {}), stale: true };
        } else {
          current.subscriptions = result.subscriptions || [];
          // The service says which cards the phone is shown. When it does
          // not say, the old way of finding them is kept.
          if (Array.isArray(result.shown)) current.shown = result.shown;
          current.reading = {
            observedAt: result.observedAt || null,
            stale: false,
            count: (result.subscriptions || []).length,
            // The service says whether the gateway answered, and whether it
            // said that it holds nothing at all.
            answered: result.answered !== false,
            empty: result.empty === true,
          };
          // The service keeps the list of the turned off ones: a
          // subscription that was taken away in Magpie is taken off that
          // list as well.
          if (Array.isArray(result.hidden)) {
            syncHidden(result.hidden);
            current.display = { ...(current.display || {}), subscriptionHidden: result.hidden };
          }
          // What the gateway only just told about is marked in the list.
          current.newSubscriptions = new Set(result.added || []);
          // The rows are drawn again: a subscription that is new has to be
          // seen, and the order that was given is kept.
          renderSubscriptions(current);
          renderWidgetCard(current);
        }
      }
      const count = (result.subscriptions || []).length;
      const added = result.added || [];
      if (!result.ok) {
        saveState('subsRefreshNote', 'bad', `${safeError(result.error, '网关没有给出新的订阅列表。')}下面还是上一次读到的。`, () => { void refreshSubscriptions(); });
        return;
      }
      saveState('subsRefreshNote', 'ok', added.length
        ? `读到了 ${count} 家订阅，新出现了 ${added.length} 家：${added.join('、')}。`
        : count
          ? `读到了 ${count} 家订阅，还是这些。`
          : '网关现在没有可读订阅。');
    } catch {
      saveState('subsRefreshNote', 'bad', '没有读到网关，请再试一次。', () => { void refreshSubscriptions(); });
    } finally {
      for (const box of boxes) box.disabled = false;
      for (const grip of grips) grip.draggable = true;
      if (button) button.disabled = false;
    }
  };

  const renderWidgetCard = (state) => {
    const list = element('widgetCard');
    if (!list) return;
    list.replaceChildren();
    const display = state.display || {};
    const current = display.widgetCard || '';
    // Only the cards that are really shown are offered: a card that is not
    // projected would leave the small widget saying "not found". The service
    // says which cards those are; when it does not, the list of the display
    // choices is used, the way it was before.
    const shown = Array.isArray(state.shown) ? state.shown : null;
    const wanted = new Set(shown || display.subscriptions || []);
    const items = (state.subscriptions || []).filter(subscription => {
      const id = subscription.id || subscription.provider;
      if (!id) return false;
      // A card that was turned off is not offered: it would leave the small
      // widget saying "not found".
      if (hidden.has(id) || hidden.has(subscription.provider || id)) return false;
      if (shown) return wanted.has(id);
      return !wanted.size || wanted.has('*') || wanted.has(id) || wanted.has(subscription.provider);
    });
    // The card the small widget shows has to be one of the cards that are
    // shown. When it is not, the phone falls back to the first card with a
    // number, and the person at the keyboard is told about it. The note is
    // cleared as well when there is nothing to say, so that an old warning
    // does not stay on the page.
    const picked = display.widgetCard || '';
    const stillThere = (state.subscriptions || []).some(entry => {
      const id = entry.id || entry.provider;
      if (!id) return false;
      if (shown && !shown.includes(id)) return false;
      return entry.id === picked
        || entry.provider === picked
        || String(entry.account || '').toLowerCase() === String(picked).toLowerCase();
    });
    if (picked && !stillThere) {
      text('widgetCardWarn', `小号组件选的那张（${picked}）已经不显示了，手机上会退到第一张有数的卡片。要它回来，就把它勾上。`);
    } else {
      text('widgetCardWarn', '');
    }
    const choice = (field, value, label, hint) => {
      const wrapper = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = field;
      input.value = value;
      input.checked = value === current;
      wrapper.append(input, node('span', 'name', label));
      if (hint) wrapper.append(node('span', 'tag param', hint));
      list.append(wrapper);
    };
    choice('widget-card', '', '跟着第一个有数的');
    for (const subscription of items) {
      const id = subscription.id || subscription.provider;
      if (!id) continue;
      // An account the gateway did not report today has no number to show;
      // the widget would only have a dash for it.
      const hint = subscription.hasToday === false ? id + ' · 今天没数' : id;
      choice('widget-card', id, subscription.label || id, hint);
    }
    const apply = async (value) => {
      saveState('widgetCardNote', 'busy', '保存中…');
      try {
        const result = await api('api/v1/console/options', {
          method: 'POST',
          body: JSON.stringify({ widgetCard: value }),
        });
        state.display = result.display;
        // The rows are drawn again, so the radio stands where the service
        // really keeps it.
        renderWidgetCard(state);
        saveState('widgetCardNote', 'ok', '已经记下，小号组件下一次刷新就跟着变。');
      } catch {
        saveState('widgetCardNote', 'bad', '没有存上，请再试一次。', () => { void apply(value); });
        // Nothing was saved, so the radio is put back where it was.
        renderWidgetCard(state);
      }
    };
    list.onchange = (event) => {
      const input = event.target;
      if (!input || input.type !== 'radio') return;
      void apply(input.value);
    };
  };

  const renderPairing = (state) => {
    const qr = element('qr');
    if (qr && state.qr) qr.src = state.qr;
    if (qr && !state.qr) qr.closest('.qr')?.classList.add('empty');
    // The address is long and the rail is narrow: it is written in two
    // lines, the address itself and the code behind it.
    const url = element('pairingURL');
    if (url) {
      url.replaceChildren();
      const value = state.pairingURL || '';
      if (!value) {
        url.textContent = '还没有找到 Tailscale 地址';
      } else {
        const cut = value.indexOf('/p/');
        url.append(node('span', null, cut > 0 ? value.slice(0, cut) : value));
        if (cut > 0) url.append(node('span', 'code', value.slice(cut)));
      }
    }
    const blocked = Math.max(0, Math.round((state.pairingBlocked || 0) / 60));
    text(
      'pairNote',
      state.pairingBlocked
        ? `猜错的次数太多，配对先关上 ${blocked} 分钟。点「重新生成配对码」可以马上再开。`
        : state.pairingURL
          ? '配对码只能用一次，十分钟后也会作废。手机装好组件后它会自动失效，再生成一个就能装第二台。'
          : 'Tailscale 没有连上，或者这台电脑没有尾网地址。手机和电脑要在同一个 Tailscale 里。'
    );
    // The time left is written in its own place. The note above is shared by
    // the copy button and by the errors, and it must not be overwritten every
    // second.
    text('pairCountdown', state.pairingBlocked ? '' : remainingText(pairingLeft(state)));
  };

  const render = (state) => {
    current = state;
    // The service keeps the list of the turned off ones, and it is the one
    // that is written down: the page goes by it from now on.
    syncHidden(state.display?.subscriptionHidden || []);
    // The mark "new" is for one reading: the page is opened again, and the
    // subscriptions that were new are not new any more.
    state.newSubscriptions = new Set();
    renderPairing(state);
    text(
      'lifetime',
      '组件随 Magpie 运行：关掉 Magpie 之后，手机上显示的是上一次的结果，重新打开 Magpie 就会更新。'
    );
    renderFacts(state);
    renderNetwork(state);
    renderOwnNetwork(state);
    renderDevices(state);
    renderRefresh(state);
    renderAdvanced(state);
    renderSubscriptions(state);
    renderWidgetMode(state);
    renderWidgetCard(state);
  };

  // A pairing code that has run out is of no use to anybody. A new one is
  // made at once, so the first pairing after the install needs no extra click.
  const renewPairing = async () => {
    // The page never came up: ask the service again instead of waiting for
    // the next tick. The service may only have been busy for a moment.
    if (!current) {
      await load();
      return false;
    }
    if (pairingLeft(current) > 0) {
      // The note counts down on the page itself.
      renderPairing(current);
      renderAdvanced(current);
      return false;
    }
    try {
      const result = await api('api/v1/console/pair', { method: 'POST', body: '{}' });
      current = result;
      renderPairing(result);
      renderAdvanced(result);
      return true;
    } catch {
      text('pairNote', '没能换一个新的配对码，过一会儿再试一次。');
      return false;
    }
  };

  // The page opens itself. When the service is not ready yet, or when the
  // window lost it for a moment, the page tries again by itself: a person
  // should not have to close the window and open it again.
  let retryTimer = 0;
  let retryDelay = 3000;
  const load = async () => {
    try {
      render(await api('api/v1/console/state'));
      await renewPairing();
      clearTimeout(retryTimer);
      retryTimer = 0;
      retryDelay = 3000;
      element('reconnect')?.setAttribute('hidden', '');
    } catch (error) {
      const reason = error?.message ? `（${error.message}）` : '';
      text('pairNote', `这个页面没有连上本机的额度服务${reason}，过一会儿会自己再试。`);
      element('reconnect')?.removeAttribute('hidden');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { void load(); }, retryDelay);
      // The first tries are close together, later ones are further apart: a
      // service that is gone for good is not asked every second.
      retryDelay = Math.min(retryDelay * 2, 15000);
    }
  };

  // The page stays open, so the code is looked at now and then. When it has
  // run out, a new one is made without being asked for.
  setInterval(() => { void renewPairing(); }, 30000);

  // The time left on the code is counted here, on the page, so the numbers
  // move while the page is open. Nothing is asked of the service, and the
  // note above is left alone.
  const tickCountdown = () => {
    if (document.hidden || !current) return;
    const left = pairingLeft(current);
    // While the door is shut the line stays empty; the note next to it says why.
    if (!current.pairingBlocked) text('pairCountdown', remainingText(left));
    const cell = element('pairRemaining');
    if (cell) cell.textContent = remainingText(left);
  };
  setInterval(tickCountdown, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tickCountdown();
  });

  element('copyLink')?.addEventListener('click', () => copy(current?.pairingURL, '配对链接'));
  element('reconnect')?.addEventListener('click', () => {
    clearTimeout(retryTimer);
    retryDelay = 3000;
    void load();
  });
  element('manualToken')?.addEventListener('click', async () => {
    const name = element('manualName')?.value?.trim() || '';
    try {
      const result = await api('api/v1/console/device', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', name }),
      });
      if (current) current.devices = result.devices;
      renderDevices(current || {});
      // The token is shown here and nowhere else. The service keeps only its
      // hash, so it cannot be shown a second time.
      text('manualNote', `给「${result.device.name}」的令牌（只显示这一次，复制后交给那台手机）：${result.token}`);
      await copy(result.token, '令牌');
    } catch {
      text('manualNote', '没有做成，请再试一次。');
    }
  });
  element('rotate')?.addEventListener('click', async () => {
    try {
      render(await api('api/v1/console/pair', { method: 'POST' }));
    } catch {
      text('pairNote', '没有换成新的配对码，请再试一次。');
    }
  });
  element('saveExternal')?.addEventListener('click', () => { void saveOwnAddress(); });
  element('restoreTailscale')?.addEventListener('click', async () => {
    const button = element('restoreTailscale');
    if (button) button.disabled = true;
    text('restoreNote', '正在关掉自己开的端口，让 Tailscale 回来…');
    try {
      const result = await api('api/v1/console/network/reset', { method: 'POST', body: '{}' });
      await load();
      const mode = result?.network?.mode || 'tailscale';
      text(
        'restoreNote',
        mode === 'tailscale'
          ? '已经回到 Tailscale：自己填的地址和在内网上开的端口都关掉了，手机从尾网连进来。'
          : '已经恢复了一部分，请看上面的连接方式。',
      );
    } catch (error) {
      text('restoreNote', error.message || '没有恢复成功，请再试一次。');
    } finally {
      if (button) button.disabled = false;
    }
  });
  element('diagnose')?.addEventListener('click', async () => {
    text('diagnoseNote', '正在问 Tailscale…');
    try {
      const result = await api('api/v1/console/diagnose', { method: 'POST', body: '{}' });
      if (current) current.tailnet = result.tailnet;
      renderNetwork(current || {});
      const ping = result.ping || {};
      text(
        'diagnoseNote',
        ping.ok
          ? `到 ${ping.target} 的路径：${PATH_LABEL[ping.path] || PATH_LABEL.unknown}。`
          : `诊断没有成功：${ping.error || '还不知道原因'}`
      );
    } catch {
      text('diagnoseNote', '诊断没有跑起来，请再试一次。');
    }
  });
  element('refreshSubs')?.addEventListener('click', () => { void refreshSubscriptions(); });

  load();
})();
