import { pairingLeft, remainingText } from './timing.mjs';

(() => {
  const token = document.querySelector('meta[name="service-token"]')?.content || '';
  let current = null;
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

  const renderSubscriptions = (state) => {
    const list = element('subscriptions');
    if (!list) return;
    list.replaceChildren();
    const chosen = new Set(state.display?.subscriptions || []);
    const all = chosen.has('*');
    const items = state.subscriptions || [];
    // Every account knows the vendor it belongs to. A vendor that is chosen
    // as a whole stands at the place of its first account.
    const familyOf = new Map(items.map(subscription => [subscription.id, subscription.provider || subscription.id]));
    // The order the user has given is the order of the cards on the phone and
    // in the widget, so the rows are drawn in that order and not in the order
    // the gateway happens to list them.
    const ordered = [];
    const seen = new Set();
    for (const entry of state.display?.subscriptions || []) {
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
          .filter((input) => input.checked)
          .map((input) => input.value)
      );
      const next = [];
      for (const row of list.querySelectorAll('label')) {
        const id = row.querySelector('input').value;
        if (checked.has(id)) next.push(id);
      }
      return next;
    };
    const save = async () => {
      const next = collect();
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
        // The rows are drawn again, so what is on the page is the order that
        // was really saved.
        renderSubscriptions(state);
      } catch {
        text('subNote', '没有存上，请再试一次。');
      }
    };
    for (const subscription of ordered) {
      const family = subscription.provider || subscription.id;
      const label = document.createElement('label');
      label.className = 'sub';
      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '⠿';
      grip.title = '拖着换顺序';
      grip.draggable = true;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = subscription.id;
      input.checked = all || chosen.has(family) || chosen.has(subscription.id);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = subscription.label || subscription.id;
      label.append(grip, input, name);
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
        dragging = label;
        label.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', '');
        event.dataTransfer.setDragImage(label, 12, 12);
      });
      grip.addEventListener('dragend', () => {
        dragging = null;
        label.classList.remove('dragging');
        for (const row of list.querySelectorAll('.over')) row.classList.remove('over');
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
        if (!dragging || dragging === label) return;
        const rows = [...list.querySelectorAll('label')];
        const from = rows.indexOf(dragging);
        const to = rows.indexOf(label);
        if (from < 0 || to < 0) return;
        // The dragged row goes where it was dropped: below the row it was
        // dropped on, or above it.
        if (to > from) label.after(dragging);
        else label.before(dragging);
        dragging = null;
        void save();
      });
      list.append(label);
    }
    list.onchange = () => {
      void save();
    };
  };

  // The direction of the numbers and the card of the small widget are chosen
  // here, on the plugin side. The Scriptable parameter may still say
  // otherwise, so one widget on the phone can differ from the others.
  const renderWidgetSettings = (state) => {
    const list = element('widgetSettings');
    if (!list) return;
    list.replaceChildren();
    const display = state.display || {};
    // Only the cards that are really shown are offered: a card that is not
    // projected would leave the small widget saying "not found".
    const wanted = new Set(display.subscriptions || []);
    const items = (state.subscriptions || []).filter(subscription => {
      const id = subscription.id || subscription.provider;
      if (!id) return false;
      // Only the cards that are really shown are offered: a card that is not
      // projected would leave the small widget saying "not found". A card of
      // an account is not the card of its vendor, so only the id itself is
      // taken.
      if (!wanted.size || wanted.has('*') || wanted.has(id)) return true;
      return false;
    });
    const choice = (field, value, label, hint) => {
      const wrapper = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = field;
      input.value = value;
      const current = field === 'widget-mode' ? (display.widgetMode || 'remaining') : (display.widgetCard || '');
      input.checked = value === current;
      wrapper.append(input, node('span', 'name', label));
      if (hint) wrapper.append(node('span', 'tag param', hint));
      list.append(wrapper);
    };
    choice('widget-mode', 'remaining', '剩余：还有多少');
    choice('widget-mode', 'used', '已用：用了多少');
    choice('widget-card', '', '小号组件：跟着第一个有数的');
    for (const subscription of items) {
      const id = subscription.id || subscription.provider;
      if (!id) continue;
      // An account the gateway did not report today has no number to show;
      // the widget would only have a dash for it.
      const hint = subscription.hasToday === false ? id + ' · 今天没数' : id;
      choice('widget-card', id, `小号组件：${subscription.label || id}`, hint);
    }
    list.onchange = async (event) => {
      const input = event.target;
      if (!input || input.type !== 'radio') return;
      const body = input.name === 'widget-mode' ? { widgetMode: input.value } : { widgetCard: input.value };
      try {
        const result = await api('api/v1/console/options', { method: 'POST', body: JSON.stringify(body) });
        state.display = result.display;
        text('widgetNote', '已经记下，手机上的组件下一次刷新就会跟着变。');
      } catch {
        // Nothing was saved, so the radio is put back where it was.
        text('widgetNote', '没有存上，请再试一次。');
        renderWidgetSettings(state);
      }
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
    renderWidgetSettings(state);
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

  load();
})();
