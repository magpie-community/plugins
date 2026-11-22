import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairingLeft, remainingText } from '../ui/timing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The line endings of the checkout are not the same on every computer: a
// page read on Windows ends its lines with CRLF. The tests look at the
// lines, so they all read the same line endings.
const read = async (file) => (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');

test('the time left on a pairing code is counted on the page', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const state = { pairingExpiresAt: new Date(now + 9 * 60 * 1000 + 59 * 1000).toISOString() };
  assert.equal(pairingLeft(state, now), 599);
  assert.equal(remainingText(599), '还剩 9 分 59 秒');
  assert.equal(remainingText(60), '还剩 1 分 0 秒');
  assert.equal(remainingText(59), '还剩 59 秒');
  assert.equal(remainingText(0), '已经作废');
  assert.equal(remainingText(-5), '已经作废');
  // A code without a time is gone already.
  assert.equal(pairingLeft({}, now), 0);
  assert.equal(pairingLeft({ pairingExpiresAt: 'nonsense' }, now), 0);
});

test('the console is a rail and a sheet, and the long lists are folded', async () => {
  const page = await read('ui/index.html');
  const css = await read('ui/style.css');
  // One rail with the code, one sheet with everything else. The row of
  // rounded cards is gone: a machine with a dozen network cards made the
  // page longer than anybody wanted to scroll.
  assert.match(page, /<aside class="rail">/);
  assert.match(page, /<div class="sheet">/);
  assert.doesNotMatch(page, /class="cards"/);
  assert.match(css, /grid-template-columns: 296px minmax\(0, 1fr\)/);
  assert.match(css, /align-items: start/);
  // The rail follows the page when it is long.
  assert.match(css, /\.rail \{\s*position: sticky;/);
  // One column on a narrow window.
  assert.match(css, /@media \(max-width: 880px\)/);
  // The type is smaller than it was.
  assert.match(css, /font: 13px\/1\.55/);
  // The lists that grow with the machine are folded away, and the lid says
  // how many are in there.
  for (const id of ['peersSummary', 'interfacesSummary', 'bindSummary']) {
    assert.match(page, new RegExp(`<summary id="${id}"`));
  }
  const script = await read('ui/app.js');
  assert.match(script, /尾网里的 iPhone（\$\{list\.length\} 台）/);
  assert.match(script, /这台电脑的网卡（\$\{list\.length\} 张）/);
  assert.match(script, /手机可以从这里连（\$\{candidates\.length\} 个地址）/);
});

test('every piece of the page the script reaches for is on the page', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // The script looks a piece of the page up by its name and quietly does
  // nothing when it is not there. A rewritten page that drops one name
  // would blank that panel with no test saying so, so every name the
  // script asks for has to be in the page.
  const names = [...script.matchAll(/(?:element|text|fillFacts)\(\s*'([A-Za-z0-9_-]+)'/g)]
    .map((match) => match[1]);
  assert.ok(names.length >= 30, `only ${names.length} names found in the script`);
  // A few names are not in the page because the script writes them itself
  // (the cell of the countdown in the advanced settings). Those are the
  // ones that close an array of a row.
  const written = new Set([...script.matchAll(/'([A-Za-z0-9_-]+)'\s*\]/g)].map((match) => match[1]));
  assert.ok(written.size <= 3, `${written.size} names are written by the script, that is a lot`);
  for (const name of new Set(names)) {
    if (written.has(name)) continue;
    assert.match(page, new RegExp(`id="${name}"`), `the page has no #${name}`);
  }
});

test('the small widget picker offers the accounts covered by the display selection', async () => {
  const script = await read('ui/app.js');
  const renderer = script.match(/  const renderWidgetCard = [\s\S]*?\n  \};/)[0];
  const list = { children: [], replaceChildren() { this.children = []; }, append(row) { this.children.push(row); } };
  const document = { createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }) };
  const render = new Function('document', 'element', 'node', 'saveState', 'text', 'hidden', `${renderer}\nreturn renderWidgetCard;`)(document, () => list, document.createElement, () => {}, () => {}, new Set());
  const subscriptions = ['codex@alpha', 'codex@beta', 'glm'].map(id => ({ id, provider: id.split('@')[0] }));
  const offered = selected => {
    render({ subscriptions, display: { subscriptions: selected } });
    return list.children.map(row => row.children[0]).filter(input => input.name === 'widget-card' && input.value).map(input => input.value);
  };
  assert.deepEqual(offered(['codex']), ['codex@alpha', 'codex@beta']);
  assert.deepEqual(offered(['codex@beta']), ['codex@beta']);
  assert.deepEqual(offered(['*']), ['codex@alpha', 'codex@beta', 'glm']);
});

test('the parameter of the subscription sits on the right', async () => {
  const script = await read('ui/app.js');
  const css = await read('ui/style.css');
  // The row is a flex row: the name takes what is left, the parameter of the
  // small widget is pushed to the right. Both texts give up width instead of
  // pushing the row out of the card.
  assert.match(css, /\.checks label \{[^}]*display: flex;/);
  assert.match(css, /\.checks \.param \{[^}]*margin-left: auto;/);
  assert.match(css, /\.checks \.param \{[^}]*text-overflow: ellipsis;/);
  assert.match(css, /\.checks label \.name \{[^}]*min-width: 0/);
  assert.match(script, /hint\.className = 'tag param'/);
});

test('the rows that are not ticked keep their place in the order', async () => {
  const script = await read('ui/app.js');
  const source = script.match(/    const rows = \(\) => \{[\s\S]*?\n    \};/);
  assert.ok(source, 'the page has no list of the rows any more');
  // The list of the rows is every row of the page, the ones that are not
  // ticked among them: a row that is turned off has to be written down as
  // well, or it loses its place.
  const rows = new Function('list', `${source[0]}\nreturn rows;`)({
    querySelectorAll: () => ['codex', 'minimax', 'qoder-cn', '*'].map(value => ({
      querySelector: () => ({ value, classList: { contains: name => name === 'follow' && value === '*' } }),
    })),
  });
  assert.deepEqual(rows(), ['codex', 'minimax', 'qoder-cn']);
});

test('the order of the rows is kept when the way of choosing changes', async () => {
  const script = await read('ui/app.js');
  const source = script.match(/  const rowOrder = [\s\S]*?\n  \};/);
  assert.ok(source, 'the page has no order of the rows any more');
  const rowOrder = new Function(`${source[0]}\nreturn rowOrder;`)();
  // The order the user gave is the whole order: a row that is turned off
  // keeps its place, also when only the ticked ones are shown.
  assert.deepEqual(
    rowOrder({
      subscriptionOrder: ['codex', 'minimax', 'qoder-cn'],
      subscriptions: ['codex', 'qoder-cn'],
      subscriptionHidden: ['minimax'],
    }),
    ['codex', 'minimax', 'qoder-cn'],
  );
  // A state of an older version has no order of its own: the list of the
  // shown ones comes first, and the ones that are turned off after them.
  assert.deepEqual(
    rowOrder({ subscriptions: ['*', 'codex', 'qoder-cn'], subscriptionHidden: ['minimax'] }),
    ['codex', 'qoder-cn', 'minimax'],
  );
});

test('the refresh button asks the service for the list of the subscriptions', async () => {
  const script = await read('ui/app.js');
  const source = script.match(/  const refreshSubscriptions = async \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(source, 'the page has no refresh of the subscriptions any more');
  const calls = [];
  const api = async (route) => {
    calls.push(route);
    return { ok: true, subscriptions: [], shown: [], added: [], removed: [], hidden: [], observedAt: null };
  };
  const refresh = new Function(
    'element', 'saveState', 'saveQueue', 'nameQueue', 'api', 'current',
    'renderSubscriptions', 'renderWidgetCard', 'hidden', 'syncHidden', 'safeError',
    `${source[0]}\nreturn refreshSubscriptions;`,
  )(
    () => null,
    () => {},
    Promise.resolve(),
    Promise.resolve(),
    api,
    { display: {}, subscriptions: [] },
    () => {},
    () => {},
    new Set(),
    () => {},
    (message, fallback) => message || fallback,
  );
  await refresh();
  assert.deepEqual(calls, ['api/v1/console/subscriptions/refresh']);
});

test('a subscription that is turned off is not offered by the small widget', async () => {
  const script = await read('ui/app.js');
  const renderer = script.match(/  const renderWidgetCard = [\s\S]*?\n  \};/)[0];
  const list = { children: [], replaceChildren() { this.children = []; }, append(row) { this.children.push(row); } };
  const document = { createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }) };
  // The minimax subscription is turned off: it is not offered, or the small
  // widget would say "not found" for it.
  const render = new Function('document', 'element', 'node', 'saveState', 'text', 'hidden', `${renderer}\nreturn renderWidgetCard;`)(
    document, () => list, document.createElement, () => {}, () => {}, new Set(['minimax']),
  );
  render({
    subscriptions: [{ id: 'codex@example.com', provider: 'codex' }, { id: 'minimax', provider: 'minimax' }],
    display: { subscriptions: ['*'] },
  });
  const offered = list.children.map(row => row.children[0]).filter(input => input.name === 'widget-card' && input.value).map(input => input.value);
  assert.deepEqual(offered, ['codex@example.com']);
});

test('a device can be taken off the list', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // The console says why there is a token, and that the phone gets one by
  // itself when it scans the code.
  assert.match(page, /手机自己换到一枚只读的令牌/);
  assert.match(page, /令牌是每台手机一枚/);
  // A row can be deleted, not only revoked.
  assert.match(script, /node\('button', 'danger', '删除'\)/);
  assert.match(script, /action: 'delete'/);
});

test('the buttons that sit in a row are smaller', async () => {
  const css = await read('ui/style.css');
  // Only the direct children of a row; the ones inside .actions keep their
  // size.
  assert.match(css, /\.row > button \{/);
  // A plain ".row button" would also shrink the buttons in .actions.
  assert.doesNotMatch(css, /\.row button \{/);
});

test('the countdown moves while the page is open', async () => {
  const script = await read('ui/app.js');
  assert.match(script, /setInterval\(tickCountdown, 1000\)/);
  assert.match(script, /document\.hidden/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /import \{ pairingLeft, remainingText \} from '\.\/timing\.mjs'/);
  // The note under the code is shared with the copy button and with the
  // errors, so the timer must not write it.
  assert.doesNotMatch(script, /setInterval\([^)]*pairNote/);
  assert.match(script, /text\('pairCountdown'/);
  assert.match(script, /element\('pairRemaining'\)/);
  const page = await read('ui/index.html');
  assert.match(page, /<script type="module" src="app\.js"><\/script>/);
  assert.match(page, /id="pairCountdown"/);
});

test('the gateway is not edited in the console any more', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  assert.doesNotMatch(page, /id="gateway"/);
  assert.doesNotMatch(page, /id="saveGateway"/);
  assert.doesNotMatch(script, /saveGateway/);
  // The console never sends a gateway of its own; the address comes from the
  // plugin settings of Magpie. The name may still be mentioned in the note.
  assert.doesNotMatch(script, /JSON\.stringify\(\{ gatewayURL/);
  assert.doesNotMatch(script, /gatewayURL: /);
});

test('the way back to the tailnet is on the page', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // A button that puts the tailnet back, and it has to say what it does.
  assert.match(page, /id="restoreTailscale"/);
  assert.match(page, /恢复 Tailscale 默认连接/);
  assert.match(page, /id="restoreNote"/);
  // The button has to ask the service, not only change the page.
  assert.match(script, /restoreTailscale/);
  assert.match(script, /api\/v1\/console\/network\/reset/);
  // And it has to tell the user how it went.
  assert.match(script, /restoreNote/);
});

test('the phone page does not ask for a tailnet of its own', async () => {
  const page = await read('mobile/index.html');
  const installer = await read('scriptable/SetupUsageWidget.js');
  // The address of the user may be a tailnet address, a home address or his
  // own https name: none of them needs the sentence "keep Tailscale on".
  assert.doesNotMatch(page, /保持 Tailscale 已连接/);
  assert.doesNotMatch(installer, /先连接 Tailscale/);
  assert.match(installer, /确保 iPhone 能访问你填写的服务地址/);
});

test('the console never asks with a dialog', async () => {
  const script = await read('ui/app.js');
  // The Magpie window runs the page in a sandbox: a confirm() or an alert()
  // is swallowed there and the button looks dead. The page asks in the row
  // instead, where the answer is written down.
  // The comments talk about these calls on purpose, so they are taken away
  // before the page is looked at.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/);
  assert.match(script, /askInRow/);
});

test('the widget is set up on the plugin side', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  const widget = await read('scriptable/UsageWidget.js');
  // The console has the choice: the direction of the numbers and the card of
  // the small widget. They are two blocks of their own, so that it is clear
  // which choice belongs to which one.
  assert.match(page, /id="widgetMode"/);
  assert.match(page, /id="widgetCard"/);
  assert.match(script, /widgetMode/);
  assert.match(script, /widgetCard/);
  // The phone reads that choice; the Scriptable parameter may still change
  // it for one widget.
  assert.match(widget, /data\.display/);
  assert.match(widget, /plugin\.widgetMode/);
  assert.match(widget, /plugin\.widgetCard/);
});

test('the two choices of the widget are two blocks of their own', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // The direction of the numbers is for every size of the widget, and the
  // card is for the small one only. One list of radios for both of them
  // could not be read: which of the two a choice belonged to was not written
  // down anywhere.
  assert.match(page, /<h3>显示内容<\/h3>/);
  assert.match(page, /<h3>小号组件显示哪一张<\/h3>/);
  assert.match(page, /id="widgetMode" class="checks"/);
  assert.match(page, /id="widgetCard" class="checks"/);
  // The two lists are drawn by two renderers, and the radios of the two are
  // two groups of their own.
  assert.match(script, /const renderWidgetMode = /);
  assert.match(script, /const renderWidgetCard = /);
  assert.match(script, /input\.name = 'widget-mode'/);
  assert.match(script, /input\.name = field/);
  // Each block says for itself what it is for.
  assert.match(script, /三种尺寸的组件下一次刷新就跟着变/);
  assert.match(script, /小号组件下一次刷新就跟着变/);
  // The old list of both of them is gone.
  assert.doesNotMatch(page, /id="widgetSettings"/);
  assert.doesNotMatch(script, /renderWidgetSettings/);
});

test('a change is saved at once, and the page says what happened', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // The console saves by itself, so the user has to be able to see that it
  // did. Every block that can be changed has a line of its own for it.
  assert.match(script, /const saveState = /);
  assert.match(page, /id="subNote"/);
  assert.match(page, /id="widgetModeNote"/);
  assert.match(page, /id="widgetCardNote"/);
  // The line says that it is saving, and that it is done.
  assert.match(script, /saveState\('subNote', 'busy', '保存中…'\)/);
  assert.match(script, /saveState\('subNote', 'ok'/);
  // A change that did not go through is not lost: it is written down, and it
  // can be tried again. This is where the button belongs: on the failure and
  // not on every change.
  assert.match(script, /saveState\('subNote', 'bad'[^;]*\(\) => \{ void save\(input\); \}\)/);
  assert.match(script, /saveState\('widgetModeNote', 'bad'[^;]*\(\) => \{ void apply\(value\); \}\)/);
  assert.match(script, /node\('button', 'quiet', '重试'\)/);
  // The page says that nothing has to be pressed.
  assert.match(page, /改完是直接记下的，不用再点哪里/);
});

test('the name of a subscription is saved while it is written', async () => {
  const script = await read('ui/app.js');
  // The name is written out while it is typed, so that the user sees at once
  // that the name is taken. The wait is short, and the field that is left is
  // written out at once.
  assert.match(script, /rename\.addEventListener\('input', schedule\)/);
  assert.match(script, /field\.timer = setTimeout\(/);
  assert.match(script, /rename\.addEventListener\('change'/);
  // Two names that travel at the same time would each carry a map of its own,
  // and the second one would take the name of the first one with it: the
  // service keeps the map it is given. One name waits for the one before it.
  assert.match(script, /nameQueue = nameQueue\.then\(send, send\)/);
  // The rows are not drawn again when a change is saved: the order on the
  // page is the order that was sent, and drawing them again would take the
  // name that is being written out of its field.
  const save = script.match(/    const save = async \(input\) => \{[\s\S]*?\n    \};/)[0];
  assert.doesNotMatch(save, /renderSubscriptions/);
  // The last subscription cannot be left out: the widget would have nothing
  // to show, so the checkbox is put back.
  assert.match(save, /if \(input\) input\.checked = true;/);
  assert.match(save, /至少要留一家订阅/);
});

test('the phone page keeps the token on the phone', async () => {
  const page = await read('mobile/index.html');
  const script = await read('mobile/app.js');
  // Safari forgets a session when the tab is closed, and the page is opened
  // from the widget days later. The token stays in the phone until 「断开」.
  assert.match(script, /localStorage/);
  assert.match(page, /id="forget"/);
  // The token is not left in the address of the page.
  assert.match(script, /history\.replaceState/);
  // A frame that refuses the storage (the Magpie window runs the page in a
  // sandbox) must not take the page down: every use of the storage goes
  // through the helper that catches the refusal.
  const storage = script.match(/(?:local|session)Storage\.\w+/g) || [];
  assert.ok(storage.length > 0, 'the phone page should use the storage');
  const helper = script.slice(0, script.indexOf('const savedTheme'));
  for (const call of storage) assert.ok(helper.includes(call), `the storage call ${call} should live in the helper`);
});

test('the phone page reads smaller on a small screen', async () => {
  const css = await read('mobile/style.css');
  // The percent of the quota was the loudest thing on the page.
  assert.match(css, /@media\(max-width:860px\)/);
  const small = css.slice(css.indexOf('@media(max-width:860px)'));
  assert.match(small, /\.daily-number\{font-size:34px/);
  assert.match(small, /\.quota-card \.window-value[^{]*\{font-size:19px/);
  // The wide window was loud too: the percentage next to the big number.
  assert.match(css, /\.primary \.window-value small\{font-size:13px/);
  assert.match(css, /\.daily-number\{font-size:42px/);
});

test('a wide window uses the space on both sides', async () => {
  const css = await read('ui/style.css');
  const html = await read('ui/index.html');
  // The page is wider now, and the right half splits in two when there is
  // room for it.
  assert.match(css, /max-width:\s*1440px/);
  assert.match(css, /@media\s*\(min-width:\s*1180px\)/);
  // The two columns are wrapped, so the grid has two children and not six.
  assert.match(html, /class="col"/);
  // A device is one line when there is room: the name, the note and the
  // buttons share it, and the long note gives way instead of pushing the
  // buttons off the row. When even that is not enough the buttons move to a
  // line of their own — never out of the card.
  const device = css.slice(css.indexOf('.row.device'));
  assert.match(device, /flex-wrap:\s*wrap/);
  assert.match(device, /flex:\s*1 1 0/);
  assert.match(device, /text-overflow:\s*ellipsis/);
  assert.match(device, /min-width:\s*0/);
});

test('a row that says a lot does not push the buttons off the card', async () => {
  const css = await read('ui/style.css');
  // The lists are grids. Without a track of its own, a row is as wide as the
  // longest word in it, and the buttons end up outside the card.
  assert.match(css, /\.checks \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.list \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.list \.row \{[^}]*min-width:\s*0/);
  assert.match(css, /\.checks label \{[^}]*min-width:\s*0/);
});

test('the actions of a device still reach the service', async () => {
  const script = await read('ui/app.js');
  assert.match(script, /action: 'revoke'/);
  assert.match(script, /action: 'delete'/);
  // The name of a device can still be changed.
  assert.match(script, /action: 'rename'/);
});

test('the widget script has the words for a wrong token and for a quiet network', async () => {
  const widget = await read('scriptable/UsageWidget.js');
  const installer = await read('scriptable/SetupUsageWidget.js');
  // The service answers 401 and loadJSON() throws before the status can be
  // read, so the status is read where Scriptable keeps it.
  assert.match(widget, /req\.response/);
  assert.match(widget, /令牌无效，请重新配对/);
  // The installer had the same dead check: a wrong token showed a raw
  // Scriptable error instead of a sentence.
  assert.match(installer, /probe\.response/);
  assert.match(installer, /只读令牌无效。/);
});

test('the widget tries a new code before the token it keeps', async () => {
  const widget = await read('scriptable/UsageWidget.js');
  // A token the service does not know any more must not block the way back
  // in: when the script carries a code that has not been used, the exchange
  // comes first, and the old token is only used when it fails.
  assert.match(widget, /\(!storedToken \|\| \(settings\.code \|\| ""\) !== PAIRED\.code\)/);
  const exchange = widget.indexOf('"/api/v1/session"');
  const overview = widget.indexOf('"/api/v1/overview"');
  assert.ok(exchange >= 0 && overview >= 0 && exchange < overview);
  // The old token is put away when a new one takes its place, and on a 401
  // the phone is told to be paired again rather than set up again.
  assert.match(widget, /forgetToken\(storedToken, PAIRED\.baseURL\)/);
  assert.match(widget, /Keychain\.set\(SETTINGS_KEY, JSON\.stringify\(settings\)\);[\s\S]{0,80}await forgetToken\(dead, settings\.baseURL\)/);
  assert.match(widget, /api\/v1\/device\/forget/);
  // The new token is put away before the old row is cleaned up: a code that
  // has been used cannot be used a second time, so the token must not be
  // lost while the service is being asked to forget the old one.
  const swap = widget.indexOf('if (exchanged) {');
  const put = widget.indexOf('Keychain.set(SETTINGS_KEY, JSON.stringify(settings));', swap);
  const forget = widget.indexOf('forgetToken(storedToken', swap);
  assert.ok(swap >= 0 && put > swap, 'the new token is written down');
  assert.ok(forget > put, 'and only then the old row is cleaned up');
});

test('a dragged row keeps the place it was dragged into', async () => {
  const page = await read('ui/app.js');
  // The rows are read in the order they stand on the page. Grouping them by
  // vendor first would put a dragged row back where its vendor stands.
  assert.doesNotMatch(page, /families\.set\(family/);
  assert.match(page, /for \(const row of list\.querySelectorAll\('label'\)\)/);
  // Every row is written down as the account it is. A vendor written down as
  // a vendor would put its own accounts back in the order the service knows
  // them — the two accounts of one vendor would jump back on every save.
  assert.doesNotMatch(page, /next\.push\(family\)/);
  assert.match(page, /if \(checked\.has\(id\)\) next\.push\(id\)/);
  // The handle must not press the checkbox of the row either.
  assert.match(page, /grip\.addEventListener\('click',[\s\S]{0,160}preventDefault/);
});

test('the subscription rows can be dragged into another order', async () => {
  const page = await read('ui/app.js');
  const styles = await read('ui/style.css');
  // The handle is on the row, the row goes where it is dropped, and the order
  // is written back with the selection.
  assert.match(page, /className = 'grip'/);
  assert.match(page, /dragstart/);
  // The row that moves is the wrapper of the label, so that the name the user
  // gives a subscription travels with it.
  assert.match(page, /querySelectorAll\('\.sub-row'\)/);
  assert.match(page, /rows\[to\]\.after\(dragging\)|rows\[to\]\.before\(dragging\)/);
  assert.match(page, /api\/v1\/console\/options/);
  // The rows are drawn in the order the user has given, not in the order the
  // gateway happens to list them. The rows that are turned off keep their
  // place as well: the whole order is written down apart from the list of
  // the shown ones.
  assert.match(page, /for \(const entry of order\)/);
  assert.match(page, /const order = rowOrder\(state\.display \|\| \{\}\)/);
  assert.match(page, /display\.subscriptionOrder/);
  assert.match(page, /display\.subscriptionHidden/);
  assert.match(styles, /\.grip/);
});

test('a subscription can be given a name of its own', async () => {
  const page = await read('ui/app.js');
  const styles = await read('ui/style.css');
  // The name is a field of its own under the row, and it holds the name that
  // was given to this subscription.
  assert.match(page, /const rename = document\.createElement\('input'\)/);
  assert.match(page, /rename\.type = 'text'/);
  assert.match(page, /rename\.maxLength = 32/);
  // The field holds the name that was given to this subscription, and the name
  // is kept in the page as well, so that it is not lost when the rows are
  // drawn again.
  assert.match(page, /const stored = \(state\.display\?\.names \|\| \{\}\)\[subscription\.id\] \|\| ''/);
  assert.match(page, /rename\.value = field\.value/);
  // The name goes to the service with the other choices of the page. An empty
  // field means the name of the software is used again.
  assert.match(page, /body: JSON\.stringify\(\{ names \}\)/);
  assert.match(page, /delete names\[id\]/);
  // A change of the name must not be taken for a change of the selection.
  assert.match(page, /if \(event\.target && event\.target\.type === 'text'\) return;/);
  assert.match(styles, /\.checks \.sub-name/);
});

test('the console offers to follow the subscriptions of Magpie', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // The first row of the list is the whole list: the subscriptions of Magpie
  // are followed, so one that is added shows up and one that is removed goes
  // away by itself.
  assert.match(script, /followInput\.value = '\*'/);
  assert.match(script, /全部订阅（跟着 Magpie 走）/);
  // The list that is sent is the whole one when that row is ticked, and the
  // rows below it only decide when it is not. The subscriptions that are
  // written down after the star keep the order the user has given them.
  // When the whole list is followed, every row is written down, the ones
  // that are turned off among them: a row that is turned off keeps its
  // place instead of falling to the end of the list.
  assert.match(script, /follow && follow\.checked \? \['\*', \.\.\.rows\(\)\] : collect\(\)/);
  assert.match(script, /const rows = \(\) => \{/);
  // The first row is not a subscription of its own: it is not written down
  // with the others.
  assert.match(script, /!input\.classList\.contains\('follow'\)/);
  // The page says which of the two ways is in use, so that a subscription
  // that does not show up is not a mystery.
  assert.match(page, /id="subMode"/);
  assert.match(script, /element\('subMode'\)/);
});

test('the subscriptions can be read again from the gateway', async () => {
  const page = await read('ui/index.html');
  const script = await read('ui/app.js');
  // The button and the line that says what the reading was.
  assert.match(page, /id="refreshSubs"/);
  assert.match(page, /id="subsRefreshNote"/);
  assert.match(page, /刷新订阅/);
  // The button asks the service to read the gateway again, and the answer
  // says what is new.
  assert.match(script, /api\/v1\/console\/subscriptions\/refresh/);
  assert.match(script, /result\.added/);
  // A reading that failed is told as a failure.
  assert.match(script, /!result\.ok/);
});

test('a subscription can be turned off in both ways of choosing', async () => {
  const script = await read('ui/app.js');
  // The rows below the star are not disabled any more: following Magpie does
  // not take away the choice of the number and the order of the cards.
  assert.doesNotMatch(script, /input\.disabled = all/);
  assert.doesNotMatch(script, /box\.disabled = following/);
  assert.match(script, /grip\.draggable = true/);
  // What the user turns off is written down with the choice, so that it does
  // not come back by itself.
  assert.match(script, /hidden\.add\(input\.value\)/);
  assert.match(script, /hidden\.delete\(input\.value\)/);
  assert.match(script, /subscriptionHidden: \[\.\.\.hidden\]/);
});

test('the warning about the small widget is written where the list of the shown cards is', async () => {
  const script = await read('ui/app.js');
  // The warning needs the list of the cards that are really shown. That list
  // only exists in the function that draws the card of the small widget: a
  // function that used it without having it would stop the page altogether.
  const start = script.indexOf('const renderWidgetMode = (state) =>');
  const end = script.indexOf('const refreshSubscriptions = async () =>');
  assert.ok(start > 0 && end > start, 'the page has both functions');
  const mode = script.slice(start, end);
  assert.doesNotMatch(mode, /\bshown\b/, 'the mode of the widget does not use the shown list');
  const cardStart = script.indexOf('const renderWidgetCard = (state) =>');
  const card = script.slice(cardStart, script.indexOf('const renderPairing = (state) =>'));
  assert.match(card, /widgetCardWarn/);
  // The warning is cleared as well when there is nothing to say, so that an
  // old warning does not stay on the page.
  assert.match(card, /text\('widgetCardWarn', ''\)/);
});

test('the saves of the page go one after another', async () => {
  const script = await read('ui/app.js');
  // Two saves that travel at the same time would each carry a list of their
  // own, and the one that is answered last would be the one that is kept.
  assert.match(script, /saveQueue = saveQueue\.then\(run, run\)/);
  // A reading of the gateway waits for the save that is on its way, so that
  // the rows are not drawn over a tick that was not stored yet.
  assert.match(script, /await saveQueue;/);
});

test('a late answer does not overwrite a newer change', async () => {
  const script = await read('ui/app.js');
  // Every change of the user has a number. A response that comes back after
  // a newer change is about an older state, and it does not overwrite it:
  // the request that is queued behind it carries the newer change.
  assert.match(script, /hiddenRevision \+= 1;/);
  assert.match(script, /if \(hiddenRevision === revision\)/);
  // The ticks that are put back after a change go by the same rule the rows
  // are drawn by, so that the page cannot show something the service does
  // not keep.
  assert.match(script, /box\.checked = shownOf\(subscription, state\.display\)/);
  // The rows cannot be dragged while the gateway is read: an order that is
  // given in between would be taken back by the drawing that follows.
  assert.match(script, /grip\.draggable = false/);
});

test('the phone says goodbye to its row on the list', async () => {
  const page = await read('mobile/app.js');
  assert.match(page, /api\/v1\/device\/forget/);
  assert.match(page, /PC 名单上那一行也删掉了/);
});

test('the cards of the medium widget keep their bars on one line', async () => {
  const widget = await read('scriptable/UsageWidget.js');
  // Every line of a card has a height of its own: a card without an
  // account keeps the line of the account empty without moving its
  // bar up or down, so the bars of the cards sit on one line and can
  // be read side by side.
  assert.match(widget, /function line\(parent, size, width\)/);
  assert.match(widget, /const emptyRow = line\(column, accountSize, cellWidth\)/);
  // The time of the reset and the share of the week each get a line of their
  // own: together on one line they were cut short, and the time was the first
  // thing to go.
  assert.match(widget, /const first = \(sharedWindow \? "" : windowLabel\(primary\) \+ " · "\) \+ shortReset\(primary\)/);
  assert.match(widget, /const weekly = windowLabel\(secondary\) \+ " " \+ percent\(secondary\)/);
});


// The window of a quota is written the same way on the phone: the gateway
// calls one window "5 hours" and another one "4 hours", and the page used
// to write the second one as it came.
test('the window of a quota is written the same way on the phone', async () => {
  const phone = await read('mobile/app.js');
  const start = phone.indexOf('function windowName(');
  const end = phone.indexOf('\n}', start) + 2;
  assert.ok(start > 0 && end > start, 'the phone page has a windowName');
  const make = new Function('quotaMode', `${phone.slice(start, end)}\nreturn windowName;`);
  const name = make('remaining');
  assert.equal(name('5 hours'), '5 小时剩余');
  assert.equal(name('4 hours'), '4 小时剩余');
  assert.equal(name('7 days'), '本周剩余');
  assert.equal(name('2 days'), '2 天剩余');
  assert.equal(name('hours'), '1 小时剩余');
  assert.equal(name('day'), '1 天剩余');
  assert.equal(name('weekly'), '本周剩余');
  assert.equal(name('monthly'), '30 天剩余');
  assert.equal(make('used')('4 hours'), '4 小时已用');
});
