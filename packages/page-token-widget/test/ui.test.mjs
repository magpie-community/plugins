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
  // the small widget.
  assert.match(page, /id="widgetSettings"/);
  assert.match(script, /widgetMode/);
  assert.match(script, /widgetCard/);
  // The phone reads that choice; the Scriptable parameter may still change
  // it for one widget.
  assert.match(widget, /data\.display/);
  assert.match(widget, /plugin\.widgetMode/);
  assert.match(widget, /plugin\.widgetCard/);
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
  assert.match(page, /label\.after\(dragging\)|label\.before\(dragging\)/);
  assert.match(page, /api\/v1\/console\/options/);
  // The rows are drawn in the order the user has given, not in the order the
  // gateway happens to list them.
  assert.match(page, /for \(const entry of state\.display\?\.subscriptions \|\| \[\]\)/);
  assert.match(styles, /\.grip/);
});

test('the phone says goodbye to its row on the list', async () => {
  const page = await read('mobile/app.js');
  assert.match(page, /api\/v1\/device\/forget/);
  assert.match(page, /PC 名单上那一行也删掉了/);
});

test('the cards of the medium widget keep their bars on one line', async () => {
  const widget = await read('scriptable/UsageWidget.js');
  // A card without an account keeps the line of the account empty (a space
  // of its own, so the line keeps its height), so the bars of the cards sit
  // on one line and can be read side by side.
  assert.match(widget, /text\(column, " ", accountSize, colors\.muted\)/);
  // The time of the reset and the share of the week each get a line of their
  // own: together on one line they were cut short, and the time was the first
  // thing to go.
  assert.match(widget, /const first = \(sharedWindow \? "" : windowLabel\(primary\) \+ " · "\) \+ shortReset\(primary\)/);
  assert.match(widget, /const weekly = windowLabel\(secondary\) \+ " " \+ percent\(secondary\)/);
});
