import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../scriptable/UsageWidget.js', import.meta.url), 'utf8');
const SETTINGS_KEY = 'ameaq-rmrcxu-b2';

// The widget runs on a phone, not here. These stubs are the smallest world
// the script can live in: a widget that only remembers what was written on
// it, a keychain, a file manager and a request that answers the way the test
// wants it to. What is written on the widget is what the user sees.
class FakeElement {
  constructor() {
    this.font = null;
    this.textColor = null;
    this.lineLimit = 1;
    this.minimumScaleFactor = 1;
    this.imageSize = null;
    this.text = null;
  }
}

// The stub keeps the tree as well as the words: the height of a line of a
// card decides where the bar below it sits, and that is the thing this file
// has something to say about.
class FakeStack {
  constructor(log) {
    this.log = log;
    this.size = null;
    this.children = [];
  }
  addText(value) {
    this.log.push(String(value));
    const element = new FakeElement();
    element.text = String(value);
    this.children.push({ type: 'text', element });
    return element;
  }
  addStack() {
    const stack = new FakeStack(this.log);
    this.children.push({ type: 'stack', stack });
    return stack;
  }
  addImage() {
    const element = new FakeElement();
    this.children.push({ type: 'image', element });
    return element;
  }
  addSpacer(size = 0) {
    this.children.push({ type: 'spacer', size });
  }
  centerAlignContent() {}
  topAlignContent() {}
  layoutVertically() {}
  layoutHorizontally() {}
}

// The height of a piece of a card. A Scriptable line is about 1.2 times its
// font size. A line that holds nothing but a space takes no room: a phone
// measures it as it likes, and a card that leans on it leans with it.
const LINE_HEIGHT = 1.2;
const heightOf = node => {
  if (node.type === 'text') {
    const size = node.element.font && node.element.font.size ? node.element.font.size : 12;
    return node.element.text && node.element.text.trim() ? Math.round(size * LINE_HEIGHT) : 0;
  }
  if (node.type === 'spacer') return node.size || 0;
  if (node.type === 'image') return node.element.imageSize ? node.element.imageSize.height : 0;
  if (node.type === 'stack') {
    // A stack with a size of its own keeps it, whatever is inside it.
    if (node.stack.size) return node.stack.size.height;
    return node.stack.children.reduce((most, child) => Math.max(most, heightOf(child)), 0);
  }
  return 0;
};

// The height at which the bar of every card of the widget sits.
const barLevels = (node, found = []) => {
  if (node.type !== 'stack') return found;
  const stack = node.stack;
  const bar = stack.children.find(child => child.type === 'image');
  if (bar) {
    let level = 0;
    for (const child of stack.children) {
      if (child === bar) break;
      level += heightOf(child);
    }
    found.push(level);
  }
  for (const child of stack.children) if (child.type === 'stack') barLevels(child, found);
  return found;
};

class FakeSize {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
}

class FakeRect {
  constructor(x, y, width, height) {
    Object.assign(this, { x, y, width, height });
  }
}

class FakeColor {
  constructor(value) {
    this.value = value;
  }
  static dynamic(first) {
    return first;
  }
}

class FakeDrawContext {
  setFillColor() {}
  fillRect() {}
  getImage() {
    return { fake: true };
  }
}

const overview = (display = {}, cards = null) => ({
  schemaVersion: 1,
  generatedAt: Date.now(),
  display: { widgetMode: 'remaining', widgetCard: '', subscriptions: ['codex'], ...display },
  sources: {
    today: { state: 'ok', observedAt: new Date().toISOString(), outdated: false },
    week: { state: 'ok', observedAt: new Date().toISOString(), outdated: false },
    quotas: { state: 'ok', observedAt: new Date().toISOString(), outdated: false },
  },
  usage: {
    today: { totalTokens: 3500, input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, requests: 100 },
    week: { totalTokens: 10500, input: 4000, output: 2000, cacheRead: 4500, cacheWrite: 0, requests: 700 },
  },
  subscriptions: cards || [
    {
      id: 'codex@alpha',
      provider: 'codex',
      account: 'alpha',
      label: 'Codex · alpha',
      windows: [
        { label: '5h', usedPercent: 41, remainingPercent: 59, resetsAt: Date.now() + 3600000 },
        { label: 'week', usedPercent: 12, remainingPercent: 88, resetsAt: Date.now() + 86400000 },
      ],
      usage: { today: { totalTokens: 600 } },
      stale: false,
    },
  ],
});

const runWidget = async ({
  request,
  keychain = { [SETTINGS_KEY]: JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40) }) },
  config = {},
  args = {},
  paired = null,
  cache = '',
} = {}) => {
  const log = [];
  const widgets = [];
  const calls = { setWidget: 0, complete: 0 };
  // What the script keeps after itself: the exchanges of the keychain are the
  // way back in when a token runs out.
  const kept = [];
  const context = {
    console,
    Script: {
      setWidget: () => { calls.setWidget += 1; },
      complete: () => { calls.complete += 1; },
    },
    Keychain: {
      get: (key) => keychain[key],
      set: (key, value) => { keychain[key] = value; kept.push([key, value]); },
    },
    FileManager: {
      local: () => ({
        joinPath: (...parts) => parts.join('/'),
        documentsDirectory: () => '/tmp/documents',
        fileExists: () => Boolean(cache),
        readString: () => cache,
        writeString: () => {},
      }),
    },
    Request: request,
    ListWidget: class extends FakeStack {
      constructor() { super(log); widgets.push(this); }
      setPadding() {}
    },
    DrawContext: FakeDrawContext,
    Size: FakeSize,
    Rect: FakeRect,
    Color: FakeColor,
    Font: { systemFont: (size) => ({ size }), mediumSystemFont: (size) => ({ size, medium: true }) },
    config: { widgetFamily: 'medium', widgetParameter: '', runsInWidget: true, ...config },
    args: { widgetParameter: '', ...args },
    Device: { name: () => 'iPhone', model: () => 'iPhone', isUsingDarkAppearance: () => false },
  };
  vm.createContext(context);
  // A script that comes from the pairing page carries the address and a
  // one-time code; the service writes them into this line.
  const script = paired
    ? source.replace('let PAIRED = null;', `let PAIRED = ${JSON.stringify(paired)};`)
    : source;
  await vm.runInContext(`(async () => {\n${script}\n})();`, context);
  return { log, calls, kept, tree: widgets[0] };
};

// A request that fails. The response it leaves behind stands for the
// service, so it carries the name the service puts on its refusals.
const failing = (error, response = null) =>
  class {
    constructor() {
      this.response = response
        ? { ...response, headers: { 'x-token-widget-service': '@magpie-community/page-token-widget', ...(response.headers || {}) } }
        : null;
    }
    async loadJSON() {
      throw error;
    }
  };

// A request that answers by the road it is asked for. What is asked, in what
// order, and with which token is written down: the way back in after a dead
// token is the exchange, and it has to come first.
const listening = (answers = {}) => {
  const asked = [];
  const Request = class {
    constructor(url) {
      this.url = String(url);
      this.headers = {};
      this.method = 'GET';
      this.body = '';
      this.response = { statusCode: 200 };
    }
    async loadJSON() {
      asked.push({ url: this.url, auth: this.headers.Authorization || '', body: this.body });
      const key = Object.keys(answers).find((name) => this.url.endsWith(name));
      const answer = answers[key];
      if (answer === undefined) {
        this.response = { statusCode: 404 };
        throw new Error('The server returned status 404');
      }
      if (typeof answer === 'function') {
        // A route that fails in its own way: a network that does not answer,
        // a refusal that does not come from the service.
        return answer(this);
      }
      if (typeof answer === 'number') {
        // The refusal comes from the service itself, and it says so.
        this.response = { statusCode: answer, headers: { 'x-token-widget-service': '@magpie-community/page-token-widget' } };
        throw new Error('The server returned status ' + answer);
      }
      return answer;
    }
    async loadString() {
      asked.push({ url: this.url, auth: this.headers.Authorization || '', body: this.body });
      return '';
    }
  };
  return { Request, asked };
};

test('a new code is exchanged before the token the phone already has', async () => {
  const { Request, asked } = listening({
    '/api/v1/session': { token: 'n'.repeat(40) },
    '/api/v1/device/forget': { forgotten: true },
    '/api/v1/overview': overview(),
  });
  const keychain = { [SETTINGS_KEY]: JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40), code: 'old-code' }) };
  const run = await runWidget({
    request: Request,
    keychain,
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'fresh-code' },
  });
  // The exchange comes first, and the reading is asked for with the new token.
  const session = asked.findIndex((call) => call.url.endsWith('/api/v1/session'));
  const reading = asked.findIndex((call) => call.url.endsWith('/api/v1/overview'));
  assert.ok(session >= 0, 'the code is exchanged');
  assert.ok(reading > session, 'the reading comes after the exchange');
  assert.match(asked[reading].auth, /Bearer n{40}/);
  // The old token says goodbye: its row goes off the list.
  const goodbye = asked.find((call) => call.url.endsWith('/api/v1/device/forget'));
  assert.ok(goodbye, 'the old token is put away');
  assert.match(goodbye.auth, /Bearer a{40}/);
  // The new token is kept, with the code it came from, so the next run does
  // not ask again.
  assert.equal(run.kept.length, 1);
  const saved = JSON.parse(run.kept[0][1]);
  assert.equal(saved.token, 'n'.repeat(40));
  assert.equal(saved.code, 'fresh-code');
  assert.equal(run.calls.setWidget, 1);
});

test('a code that no longer works falls back to the token the phone has', async () => {
  const { Request, asked } = listening({
    '/api/v1/overview': overview(),
  });
  const run = await runWidget({
    request: Request,
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'a-code-that-was-used' },
  });
  // The session is not among the answers: the code was used, so the exchange
  // fails and the token that is there is used as it was.
  const reading = asked.find((call) => call.url.endsWith('/api/v1/overview'));
  assert.ok(reading);
  assert.match(reading.auth, /Bearer a{40}/);
  assert.equal(run.calls.setWidget, 1);
});

test('a code that has been used is not asked for again', async () => {
  const { Request, asked } = listening({
    '/api/v1/overview': overview(),
  });
  const keychain = { [SETTINGS_KEY]: JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40), code: 'the-same-code' }) };
  await runWidget({
    request: Request,
    keychain,
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'the-same-code' },
  });
  assert.equal(asked.find((call) => call.url.endsWith('/api/v1/session')), undefined);
});

test('a reading of another day is not shown as the usage of today', async () => {
  // The service answers with a reading of yesterday: neither the total nor
  // the number of the card may be shown as today's.
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const reading = overview();
  reading.sources.today = { state: 'stale', observedAt: yesterday, outdated: true };
  const { Request } = listening({
    '/api/v1/overview': reading,
  });
  // The medium widget shows the total of the day.
  const medium = await runWidget({ request: Request, config: { widgetFamily: 'medium' } });
  assert.ok(medium.log.some((line) => line.includes('今日 — Token')), medium.log.join(' | '));
  // The small widget shows the number of the card it shows.
  const small = await runWidget({ request: Request, config: { widgetFamily: 'small' } });
  assert.ok(small.log.some((line) => line.includes('今日 — token')), small.log.join(' | '));
});

test('the widget follows the first card that has a number for today', async () => {
  // The gateway did not report the first account today: the widget must not
  // stand on that card with only a dash, as long as another one has a number.
  const reading = overview();
  reading.display.widgetCard = '';
  reading.subscriptions = [
    {
      id: 'codex@alpha',
      provider: 'codex',
      account: 'alpha',
      label: 'Codex · alpha',
      windows: [{ label: '5h', usedPercent: 41, remainingPercent: 59, resetsAt: Date.now() + 3600000 }],
      usage: null,
      stale: false,
    },
    {
      id: 'codex@beta',
      provider: 'codex',
      account: 'beta',
      label: 'Codex · beta',
      windows: [{ label: '5h', usedPercent: 30, remainingPercent: 70, resetsAt: Date.now() + 3600000 }],
      usage: { today: { totalTokens: 600 } },
      stale: false,
    },
  ];
  const { Request } = listening({
    '/api/v1/overview': reading,
  });
  const run = await runWidget({ request: Request, config: { widgetFamily: 'small' } });
  assert.ok(run.log.some((line) => line.includes('Codex · beta')), run.log.join(' | '));
  assert.ok(run.log.some((line) => line.includes('今日 600 token')), run.log.join(' | '));
});

test('a card the user chose is shown even when it has no number', async () => {
  const reading = overview();
  reading.display.widgetCard = 'codex@alpha';
  reading.subscriptions = [
    {
      id: 'codex@alpha',
      provider: 'codex',
      account: 'alpha',
      label: 'Codex · alpha',
      windows: [{ label: '5h', usedPercent: 41, remainingPercent: 59, resetsAt: Date.now() + 3600000 }],
      usage: null,
      stale: false,
    },
  ];
  const { Request } = listening({
    '/api/v1/overview': reading,
  });
  const run = await runWidget({ request: Request, config: { widgetFamily: 'small' } });
  assert.ok(run.log.some((line) => line.includes('Codex · alpha')), run.log.join(' | '));
  assert.ok(run.log.some((line) => line.includes('今日 — token')), run.log.join(' | '));
});

test('a code that only failed because the service did not answer is asked again', async () => {
  // The service did not answer at all: that is not the code's fault, so the
  // code stays fresh and is tried again the next time.
  const { Request, asked } = listening({
    '/api/v1/overview': overview(),
    '/api/v1/session': () => { throw new Error('The request timed out.'); },
  });
  const keychain = { [SETTINGS_KEY]: JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40) }) };
  const run = await runWidget({
    request: Request,
    keychain,
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'a-fresh-code' },
  });
  const saved = JSON.parse(run.kept[run.kept.length - 1][1]);
  assert.equal(saved.code, '', 'the code is not spent by a timeout');
  // The next refresh tries the code again.
  await runWidget({
    request: Request,
    keychain: { [SETTINGS_KEY]: JSON.stringify(saved) },
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'a-fresh-code' },
  });
  assert.equal(asked.filter((call) => call.url.endsWith('/api/v1/session')).length, 2, 'the code is asked again');
});

test('a code that is refused for good is not asked again', async () => {
  const { Request, asked } = listening({
    '/api/v1/overview': overview(),
    '/api/v1/session': () => {
      const error = new Error('The server returned status 400');
      error.response = { statusCode: 400 };
      throw error;
    },
  });
  const run = await runWidget({
    request: Request,
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'a-stale-code' },
  });
  const saved = JSON.parse(run.kept[run.kept.length - 1][1]);
  assert.equal(saved.code, 'a-stale-code', 'the code is spent');
  // The next refresh does not try it again.
  await runWidget({
    request: Request,
    keychain: { [SETTINGS_KEY]: JSON.stringify(saved) },
    paired: { baseURL: 'http://127.0.0.1:8790', code: 'a-stale-code' },
  });
  assert.equal(asked.filter((call) => call.url.endsWith('/api/v1/session')).length, 1, 'the code is not asked again');
});

test('a token the service does not know is wiped and the phone is told to pair again', async () => {
  const { Request, asked } = listening({
    '/api/v1/device/forget': { forgotten: true },
    '/api/v1/overview': 401,
  });
  const run = await runWidget({ request: Request });
  assert.ok(run.log.some((line) => line.includes('令牌无效，请重新配对')), run.log.join(' | '));
  assert.equal(run.calls.setWidget, 1);
  // The token is taken out of the keychain, and the row it belonged to goes
  // off the list of the devices.
  const saved = JSON.parse(run.kept[run.kept.length - 1][1]);
  assert.equal(saved.token, '');
  assert.equal(saved.pairingNeeded, true);
  const goodbye = asked.find((call) => call.url.endsWith('/api/v1/device/forget'));
  assert.match(goodbye.auth, /Bearer a{40}/);
});

test('the phone that has to pair again says so on every refresh', async () => {
  // The first refresh hears the 401 and takes the token away. The next
  // refresh has no token to ask with, but the phone is still not paired —
  // and a widget that goes on showing the last numbers looks healthy while
  // the service has long stopped answering it.
  const { Request } = listening({
    '/api/v1/device/forget': { forgotten: true },
    '/api/v1/overview': 401,
  });
  const keychain = { [SETTINGS_KEY]: JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40) }) };
  const first = await runWidget({ request: Request, keychain });
  assert.ok(first.log.some((line) => line.includes('令牌无效，请重新配对')), first.log.join(' | '));

  // The second run: the reading of the last time is still in the file.
  const second = await runWidget({ request: Request, keychain, cache: JSON.stringify(overview()) });
  assert.ok(second.log.some((line) => line.includes('令牌无效，请重新配对')), second.log.join(' | '));
  assert.equal(second.calls.setWidget, 1);
  // The numbers of the last time are not shown as if they were fresh.
  assert.ok(!second.log.some((line) => line.includes('59%')), second.log.join(' | '));
});

test('a refusal that does not come from the service leaves the token alone', async () => {
  // Something stands in front of the service and answers with its own 401.
  // The token of the phone may still be good, so it is not thrown away.
  const Request = class {
    constructor() {
      this.response = { statusCode: 401, headers: { 'www-authenticate': 'Basic realm="proxy"' } };
    }
    async loadJSON() {
      throw new Error('The server returned status 401');
    }
  };
  const keychain = { [SETTINGS_KEY]: JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40) }) };
  const run = await runWidget({ request: Request, keychain });
  assert.ok(run.log.some(line => line.includes('服务返回 401')), run.log.join(' | '));
  // The token is still there.
  assert.equal(JSON.parse(keychain[SETTINGS_KEY]).token, 'a'.repeat(40));
  assert.equal(run.kept.length, 0, 'nothing is written to the keychain');
});

test('the widget tells a wrong token from a quiet network', async () => {
  const wrong = await runWidget({
    request: failing(new Error('The server returned status 401'), { statusCode: 401 }),
  });
  assert.equal(wrong.calls.setWidget, 1, 'the widget is set even when the service says no');
  assert.ok(wrong.log.some(line => line.includes('令牌无效，请重新配对')), wrong.log.join(' | '));

  const quiet = await runWidget({
    request: failing(new Error('The request timed out.')),
  });
  assert.equal(quiet.calls.setWidget, 1);
  assert.ok(quiet.log.some(line => line.includes('服务没有回答')), quiet.log.join(' | '));

  const gone = await runWidget({
    request: failing(new Error('The server could not be reached.')),
  });
  assert.equal(gone.calls.setWidget, 1);
  assert.ok(gone.log.some(line => line.includes('连不上服务')), gone.log.join(' | '));
});

test('the widget shows the numbers of the plugin page', async () => {
  const answering = class {
    constructor() {
      this.response = { statusCode: 200 };
    }
    async loadJSON() {
      return overview({ widgetMode: 'used' });
    }
  };
  const used = await runWidget({ request: answering });
  assert.equal(used.calls.setWidget, 1);
  assert.ok(used.log.some(line => line.includes('已用')), used.log.join(' | '));

  const remaining = await runWidget({
    request: class {
      constructor() { this.response = { statusCode: 200 }; }
      async loadJSON() { return overview(); }
    },
  });
  assert.ok(remaining.log.some(line => line.includes('剩余')), remaining.log.join(' | '));
  assert.ok(!remaining.log.some(line => line.includes('已用')), remaining.log.join(' | '));
});

// A world that measures. A line of text is as tall as its writing and a
// little air above and below, and the bar is four points. The card of a
// medium widget is measured here the way it is built, so a card that no
// longer fits is caught here and not on a phone.
const LEADING = 1.2;
class MeasuredElement {
  constructor() {
    this.font = null;
    this.imageSize = null;
    this.textColor = null;
    this.lineLimit = 1;
    this.minimumScaleFactor = 1;
  }
  height() {
    if (this.imageSize) return this.imageSize.height;
    if (this.font && this.font.size) return this.font.size * LEADING;
    return 0;
  }
}
class MeasuredStack {
  constructor() {
    this.children = [];
    this.vertical = false;
    this.size = null;
  }
  layoutVertically() { this.vertical = true; }
  layoutHorizontally() { this.vertical = false; }
  topAlignContent() {}
  centerAlignContent() {}
  addStack() {
    const stack = new MeasuredStack();
    this.children.push(stack);
    return stack;
  }
  addText() {
    const element = new MeasuredElement();
    this.children.push(element);
    return element;
  }
  addImage() {
    const element = new MeasuredElement();
    this.children.push(element);
    return element;
  }
  addSpacer(size) {
    this.children.push({ height: () => Number(size) || 0 });
  }
  height() {
    const heights = this.children.map(child => child.height());
    const content = !heights.length
      ? 0
      : this.vertical
        ? heights.reduce((sum, value) => sum + value, 0)
        : Math.max(...heights);
    // A stack with a height of its own keeps it: a line whose height is
    // pinned is as tall as it says, not as tall as the text inside it.
    return this.size && this.size.height ? Math.max(content, this.size.height) : content;
  }
}

const runMeasured = async ({ family = 'medium', screen = [320, 568], data = overview() } = {}) => {
  let created = null;
  const context = {
    console,
    Script: { setWidget: () => {}, complete: () => {} },
    Keychain: { get: () => JSON.stringify({ baseURL: 'http://127.0.0.1:8790', token: 'a'.repeat(40) }), set: () => {} },
    FileManager: {
      local: () => ({
        joinPath: (...parts) => parts.join('/'),
        documentsDirectory: () => '/tmp/documents',
        fileExists: () => false,
        readString: () => '',
        writeString: () => {},
      }),
    },
    Request: class {
      constructor() { this.response = { statusCode: 200 }; }
      async loadJSON() { return data; }
    },
    ListWidget: class extends MeasuredStack {
      constructor() {
        super();
        created = this;
        this.backgroundColor = null;
      }
      setPadding() {}
    },
    DrawContext: class {
      size = null;
      setFillColor() {}
      fillRect() {}
      getImage() { return { image: true }; }
    },
    Size: FakeSize,
    Rect: FakeRect,
    Color: FakeColor,
    Font: { systemFont: size => ({ size }), mediumSystemFont: size => ({ size }) },
    config: { widgetFamily: family, widgetParameter: '', runsInWidget: true },
    args: { widgetParameter: '' },
    Device: {
      name: () => 'iPhone',
      model: () => 'iPhone',
      isUsingDarkAppearance: () => false,
      screenSize: () => ({ width: screen[0], height: screen[1] }),
    },
  };
  vm.createContext(context);
  await vm.runInContext(`(async () => {\n${source}\n})();`, context);
  return created;
};

// The points a medium card may use on the smallest medium widget.
const smallestMedium = (height, vertical, header, footer) => height - vertical * 2 - header - footer;

test('the card of the medium widget fits the smallest medium widget', async () => {
  // 320x568 is the smallest phone that still carries a medium widget. The
  // frame gives the body 84 points: 12 above and below, 20 for the head and
  // 13 for the foot. The card has to live inside that.
  const widget = await runMeasured({ screen: [320, 568] });
  const body = widget.children.find(
    child => child instanceof MeasuredStack && child.vertical && child.size && child.size.height,
  );
  assert.ok(body, 'the body of the widget is there');
  assert.equal(body.size.height, 84);
  const grid = body.children.find(child => child instanceof MeasuredStack);
  assert.ok(grid, 'the cards are in the body');
  assert.ok(
    grid.height() <= body.size.height,
    `the card is ${grid.height().toFixed(1)} points tall, the body is ${body.size.height}`,
  );
});

test('the card of the medium widget fits a phone with room to spare', async () => {
  const widget = await runMeasured({ screen: [430, 932] });
  const body = widget.children.find(
    child => child instanceof MeasuredStack && child.vertical && child.size && child.size.height,
  );
  assert.ok(body, 'the body of the widget is there');
  const grid = body.children.find(child => child instanceof MeasuredStack);
  assert.ok(grid, 'the cards are in the body');
  assert.ok(
    grid.height() <= body.size.height,
    `the card is ${grid.height().toFixed(1)} points tall, the body is ${body.size.height}`,
  );
});

test('the parameter of the phone still wins over the plugin page', async () => {
  const answering = class {
    constructor() { this.response = { statusCode: 200 }; }
    async loadJSON() { return overview({ widgetMode: 'used' }); }
  };
  const overridden = await runWidget({ request: answering, args: { widgetParameter: 'remaining' } });
  assert.ok(overridden.log.some(line => line.includes('剩余')), overridden.log.join(' | '));
  assert.ok(!overridden.log.some(line => line.includes('已用')), overridden.log.join(' | '));
});

test('a parameter that is a token says so instead of hunting for it', async () => {
  const { Request } = listening({ '/api/v1/overview': overview() });
  const run = await runWidget({
    request: Request,
    config: { widgetFamily: 'small' },
    args: { widgetParameter: 'a'.repeat(40) },
  });
  // The token-shaped parameter is dropped, the first card is shown, and the
  // note says what happened instead of "没有找到 aaaa…".
  assert.ok(run.log.some((line) => line.includes('参数里的是令牌')), run.log.join(' | '));
  assert.ok(!run.log.some((line) => line.includes('没有找到')), run.log.join(' | '));
  assert.equal(run.calls.setWidget, 1);

  // On the medium family the word of the footer becomes the warning.
  const medium = await runWidget({
    request: Request,
    args: { widgetParameter: 'a'.repeat(40) },
  });
  assert.ok(medium.log.some((line) => line.includes('参数里的令牌已忽略')), medium.log.join(' | '));
});

// The four cards of a real page: two accounts of one vendor, a vendor without
// an account and a second one. The names are of different lengths and the
// accounts are of different lengths too, which is what used to put the bars
// of the cards on different lines.
const realCards = () => {
  const window = (label, used) => ({ label, usedPercent: used, remainingPercent: 100 - used, resetsAt: Date.now() + 3600000 });
  // The cards are mixed on purpose: a card with an account of its own and a
  // card without one stand next to each other, in the middle family as well
  // as in the large one. A fixture that keeps the two kinds apart would let
  // a row of one kind hide a card that sits a line too high.
  return [
    { id: 'minimax', provider: 'minimax', account: null, label: 'MiniMax', windows: [window('5h', 96)], usage: { today: { totalTokens: 282669693 } }, stale: false },
    { id: 'codex@liuzq1103', provider: 'codex', account: 'liuzq1103', label: 'Codex · liuzq1103', windows: [window('5h', 100), window('7d', 18)], usage: { today: { totalTokens: 7171104 } }, stale: false },
    { id: 'glm', provider: 'glm', account: null, label: 'GLM', windows: [window('5h', 7), window('7d', 40)], usage: { today: { totalTokens: 34228561 } }, stale: false },
    { id: 'codex@fangzt98', provider: 'codex', account: 'fangzt98', label: 'Codex · fangzt98', windows: [window('5h', 11), window('7d', 95)], usage: { today: { totalTokens: 1077940 } }, stale: false },
  ];
};

// The bars of the cards of the medium widget have to sit on one line. A card
// whose name is longer, or that has no account of its own, must not push its
// bar up or down: the four bars are read side by side.
test('the bars of the cards of the medium widget sit on one line', async () => {
  const cards = realCards();
  const { Request } = listening({
    '/api/v1/overview': overview({ subscriptions: cards.map(card => card.id) }, cards),
  });
  const run = await runWidget({ request: Request, config: { widgetFamily: 'medium' } });
  const levels = barLevels({ type: 'stack', stack: run.tree });
  assert.equal(levels.length, 4, 'four cards, four bars');
  assert.equal(new Set(levels).size, 1, 'the bars sit on one line, but they sit at ' + levels.join(', '));
});

// The same for the large widget: the cards are in two columns there, and the
// bars of a row are read side by side as well.
test('the bars of the cards of the large widget sit on one line', async () => {
  const cards = realCards();
  const { Request } = listening({
    '/api/v1/overview': overview({ subscriptions: cards.map(card => card.id) }, cards),
  });
  const run = await runWidget({ request: Request, config: { widgetFamily: 'large' } });
  const levels = barLevels({ type: 'stack', stack: run.tree });
  assert.equal(levels.length, 4, 'four cards, four bars');
  // The large widget puts the cards in two rows of two. The bars of a row are
  // read side by side, so they have to sit on one line; the rows themselves
  // are of course not on one line.
  assert.equal(levels[0], levels[1], 'the two cards of the first row are not on one line: ' + levels.join(', '));
  assert.equal(levels[2], levels[3], 'the two cards of the second row are not on one line: ' + levels.join(', '));
});
