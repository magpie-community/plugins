import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, TOKEN_HEADER } from '../lib/server.mjs';
import { noteAccess } from '../lib/state.mjs';
import { cleanup, freePort, mockTailscale, tempDir } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const start = async (dir, options = {}) =>
  startServer({
    root,
    dataDir: dir,
    magpieDir: dir,
    options: {
      port: await freePort(),
      phonePort: await freePort(),
      listenTailnet: false,
      forward: false,
      gatewayURL: 'http://127.0.0.1:1',
      // The tests never touch the real Tailscale of this computer.
      tailscaleRunner: mockTailscale().runner,
      ...options,
    },
  });

const post = (base, route, value, headers = {}) =>
  fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value || {}),
  });

// The console of the computer opens a moment after the service starts.
const waitForConsole = async (base, consoleToken) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(base + '/api/v1/console/state', {
      headers: { [TOKEN_HEADER]: consoleToken },
    });
    if (response.status !== 503) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the console of the service never opened');
};

const consoleTokenOf = async (dir) =>
  JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).consoleToken;

let dir;
let service;
let base;

before(async () => {
  dir = await tempDir();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
  await waitForConsole(base, await consoleTokenOf(dir));
});

after(async () => {
  await service?.close();
  await cleanup(dir);
});

test('a pairing code that is too old does not open the door', async () => {
  const file = path.join(dir, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  // The code was handed out ten minutes ago and is past its time.
  state.pairing.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(file, JSON.stringify(state));
  await service.close();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
  await waitForConsole(base, state.consoleToken);

  const answer = await post(base, '/api/v1/session', { code: state.pairing.code });
  assert.equal(answer.status, 403);
  // The page of the phone says the same thing.
  const page = await fetch(base + '/p/' + state.pairing.code);
  assert.equal(page.status, 410);
});

test('a code that was rotated does not open the door any more', async () => {
  const file = path.join(dir, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const old = state.pairing.code;
  const consoleToken = state.consoleToken;
  const rotated = await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  assert.equal(rotated.status, 200);
  const answer = await post(base, '/api/v1/session', { code: old });
  assert.equal(answer.status, 403);
});

test('ten wrong tries at one code shut that code for a while', async () => {
  // A service of its own, so that the door of the other tests stays open.
  const otherDir = await tempDir();
  const other = await start(otherDir);
  const otherBase = `http://127.0.0.1:${other.port}`;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await post(otherBase, '/api/v1/session', { code: 'wrong' });
      assert.equal(wrong.status, 403);
    }
    const locked = await post(otherBase, '/api/v1/session', { code: 'wrong' });
    assert.equal(locked.status, 429);
  } finally {
    await other.close();
    await cleanup(otherDir);
  }
});

test('a wrong try does not shut the pairing of the other phones', async () => {
  // Behind the forwarding of Tailscale every phone of the tailnet arrives as
  // the loopback of this computer, so they all share one address. The lock
  // follows the code, not the address: a peer that guesses wrong can only
  // lock the code it guessed wrong at.
  const otherDir = await tempDir();
  const other = await start(otherDir);
  const otherBase = `http://127.0.0.1:${other.port}`;
  try {
    const state = JSON.parse(await readFile(path.join(otherDir, 'state.json'), 'utf8'));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await post(otherBase, '/api/v1/session', { code: 'wrong-' + attempt });
      assert.equal(wrong.status, 403);
    }
    // The phone that has the real code still gets in.
    const good = await post(otherBase, '/api/v1/session', { code: state.pairing.code, name: 'iPhone' });
    assert.equal(good.status, 200);
    const body = await good.json();
    assert.equal(typeof body.token, 'string');
  } finally {
    await other.close();
    await cleanup(otherDir);
  }
});

test('two phones get two tokens of their own', async () => {
  const file = path.join(dir, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const consoleToken = state.consoleToken;
  await waitForConsole(base, consoleToken);

  // The code of the last test is too old, so a new one is handed out.
  await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  const fresh = JSON.parse(await readFile(file, 'utf8'));

  const first = await post(base, '/api/v1/session', { code: fresh.pairing.code, name: 'iPhone A' });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.device.name, 'iPhone A');

  await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  const again = JSON.parse(await readFile(file, 'utf8'));
  const second = await post(base, '/api/v1/session', { code: again.pairing.code, name: 'iPhone B' });
  assert.equal(second.status, 200);
  const secondBody = await second.json();

  assert.notEqual(firstBody.token, secondBody.token);
  // The token of a phone is never the token of the console.
  assert.notEqual(firstBody.token, consoleToken);

  // Behind the forwarding of Tailscale every phone of the tailnet arrives as
  // the loopback of this computer, so the address in the history cannot tell
  // the phones apart. The name of the device can.
  const history = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(history.paired[0].name, 'iPhone B');
  assert.equal(history.paired[1].name, 'iPhone A');

  // Both phones read the numbers.
  for (const token of [firstBody.token, secondBody.token]) {
    const answer = await fetch(base + '/api/v1/overview', {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(answer.status, 200);
  }

  // One phone is revoked. The other one keeps working.
  const revoked = await post(
    base,
    '/api/v1/console/device',
    { id: firstBody.device.id, action: 'revoke' },
    { [TOKEN_HEADER]: consoleToken }
  );
  assert.equal(revoked.status, 200);
  const after = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + firstBody.token },
  });
  assert.equal(after.status, 401);
  const untouched = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + secondBody.token },
  });
  assert.equal(untouched.status, 200);

  // The list of the devices says who is gone.
  const list = await fetch(base + '/api/v1/console/state', {
    headers: { [TOKEN_HEADER]: consoleToken },
  });
  const body = await list.json();
  const gone = body.devices.find((device) => device.id === firstBody.device.id);
  assert.ok(gone.revokedAt);
  assert.doesNotMatch(JSON.stringify(body.devices), /"hash"/);
});

test('a revoked device can be taken off the list for good', async () => {
  const file = path.join(dir, 'state.json');
  const consoleToken = await consoleTokenOf(dir);
  await waitForConsole(base, consoleToken);

  // A phone of its own, so the other devices of this file are not touched.
  await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  const paired = JSON.parse(await readFile(file, 'utf8'));
  const phone = await post(base, '/api/v1/session', { code: paired.pairing.code, name: '要删掉的 iPhone' });
  assert.equal(phone.status, 200);
  const phoneBody = await phone.json();

  const before = JSON.parse(await readFile(file, 'utf8'));
  const others = before.devices.filter((device) => device.id !== phoneBody.device.id);
  assert.ok(others.length >= 1);

  // Revoked first: the token stops working, the row stays as a record.
  // Before that, deleting is refused: the console has to say "this phone is
  // stopped" before the row may go.
  const tooEarly = await post(
    base,
    '/api/v1/console/device',
    { id: phoneBody.device.id, action: 'delete' },
    { [TOKEN_HEADER]: consoleToken }
  );
  assert.equal(tooEarly.status, 409);
  const stillThere = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(stillThere.devices.find((device) => device.id === phoneBody.device.id));

  const revoked = await post(
    base,
    '/api/v1/console/device',
    { id: phoneBody.device.id, action: 'revoke' },
    { [TOKEN_HEADER]: consoleToken }
  );
  assert.equal(revoked.status, 200);

  // And now the row can go.
  const deleted = await post(
    base,
    '/api/v1/console/device',
    { id: phoneBody.device.id, action: 'delete' },
    { [TOKEN_HEADER]: consoleToken }
  );
  assert.equal(deleted.status, 200);
  const list = (await deleted.json()).devices;
  assert.equal(list.find((device) => device.id === phoneBody.device.id), undefined);
  // The other devices are still there, with their own tokens.
  for (const device of others) {
    assert.ok(list.find((entry) => entry.id === device.id));
  }

  // The file itself has forgotten it.
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.devices.find((device) => device.id === phoneBody.device.id), undefined);
  assert.equal(after.devices.length, others.length);

  // The token of the phone does not work, and it never comes back.
  const answer = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + phoneBody.token },
  });
  assert.equal(answer.status, 401);

  // A device that is not there cannot be deleted twice.
  const again = await post(
    base,
    '/api/v1/console/device',
    { id: phoneBody.device.id, action: 'delete' },
    { [TOKEN_HEADER]: consoleToken }
  );
  assert.equal(again.status, 404);

  // The console is the only one who may do this.
  const stranger = await post(base, '/api/v1/console/device', {
    id: others[0].id,
    action: 'delete',
  });
  assert.equal(stranger.status, 403);
});

test('a phone that is going away takes its row with it', async () => {
  const file = path.join(dir, 'state.json');
  const consoleToken = await consoleTokenOf(dir);
  await waitForConsole(base, consoleToken);

  // Two phones of their own, so the other devices of this file are not touched.
  await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  let paired = JSON.parse(await readFile(file, 'utf8'));
  const first = await post(base, '/api/v1/session', { code: paired.pairing.code, name: '留下的 iPhone' });
  const firstBody = await first.json();
  await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  paired = JSON.parse(await readFile(file, 'utf8'));
  const second = await post(base, '/api/v1/session', { code: paired.pairing.code, name: '要走的 iPhone' });
  const secondBody = await second.json();

  // A phone that has been revoked cannot read any more, but it can still say
  // goodbye: its token is the proof of which row is its own.
  const revoked = await post(
    base,
    '/api/v1/console/device',
    { id: secondBody.device.id, action: 'revoke' },
    { [TOKEN_HEADER]: consoleToken }
  );
  assert.equal(revoked.status, 200);

  const goodbye = await post(base, '/api/v1/device/forget', {}, {
    Authorization: 'Bearer ' + secondBody.token,
  });
  assert.equal(goodbye.status, 200);
  assert.equal((await goodbye.json()).forgotten, true);

  // Its row is gone, the row of the other phone is not, and the reading of
  // the other phone still works.
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.devices.find((device) => device.id === secondBody.device.id), undefined);
  assert.ok(after.devices.find((device) => device.id === firstBody.device.id));
  const reading = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + firstBody.token },
  });
  assert.equal(reading.status, 200);

  // A token that says goodbye twice takes nobody with it, and a token that
  // was never handed out takes nobody either.
  const again = await post(base, '/api/v1/device/forget', {}, {
    Authorization: 'Bearer ' + secondBody.token,
  });
  assert.equal((await again.json()).forgotten, false);
  const stranger = await post(base, '/api/v1/device/forget', {}, {
    Authorization: 'Bearer not-a-token-of-any-phone',
  });
  assert.equal((await stranger.json()).forgotten, false);
  const stillThere = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(stillThere.devices.find((device) => device.id === firstBody.device.id));

  // A phone that is still live may take its own row as well: that is a revoke
  // said by the phone itself. Its reading dies with the row.
  const leaving = await post(base, '/api/v1/device/forget', {}, {
    Authorization: 'Bearer ' + firstBody.token,
  });
  assert.equal((await leaving.json()).forgotten, true);
  const gone = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(gone.devices.find((device) => device.id === firstBody.device.id), undefined);
  const deadReading = await fetch(base + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + firstBody.token },
  });
  assert.equal(deadReading.status, 401);
});

test('the goodbye door is on the phone port, where the phone can reach it', async () => {
  // The widget and the phone page only ever reach the phone port. The door
  // that takes a row off the list has to be there, not only on the console.
  const file = path.join(dir, 'state.json');
  const consoleToken = await consoleTokenOf(dir);
  await waitForConsole(base, consoleToken);
  await post(base, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
  const paired = JSON.parse(await readFile(file, 'utf8'));
  const session = await post(base, '/api/v1/session', { code: paired.pairing.code, name: '端口上的 iPhone' });
  const body = await session.json();
  const phone = `http://127.0.0.1:${service.phonePort}`;

  const goodbye = await post(phone, '/api/v1/device/forget', {}, {
    Authorization: 'Bearer ' + body.token,
  });
  assert.equal(goodbye.status, 200);
  assert.equal((await goodbye.json()).forgotten, true);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.devices.find((device) => device.id === body.device.id), undefined);

  // The console port does not serve the phone side of the service.
  const reading = await fetch(phone + '/api/v1/overview', {
    headers: { Authorization: 'Bearer ' + body.token },
  });
  assert.equal(reading.status, 401);
});

test('leaning on the goodbye door is slowed down on its own', async () => {
  // A stranger with made-up tokens finds no row and changes nothing, but the
  // tries are counted in a bag of their own: after sixty of them the door
  // answers 429 and stays shut for a while. An isolated service, so the bag of
  // the other tests is not spent here.
  const own = await tempDir();
  const ownService = await start(own);
  const ownBase = `http://127.0.0.1:${ownService.port}`;
  try {
    let answered = 0;
    let refused = 0;
    for (let i = 0; i < 80; i += 1) {
      const response = await post(ownBase, '/api/v1/device/forget', {}, {
        Authorization: 'Bearer ' + 'g'.repeat(40) + i,
      });
      if (response.status === 200) {
        const body = await response.json();
        assert.equal(body.forgotten, false);
        answered += 1;
      } else {
        assert.equal(response.status, 429);
        refused += 1;
      }
    }
    assert.ok(answered >= 55, `the first tries go through (${answered})`);
    assert.ok(refused >= 1, `the door shuts after the budget (${refused})`);
  } finally {
    await ownService.close();
    await cleanup(own);
  }
});

test('the goodbye door does not spend the bag of the pairing', async () => {
  // The bag the whole service shares is there for people who guess codes.
  // A phone that says goodbye guesses nothing, so it must not be able to fill
  // that bag — and a bag that is already full must not keep a phone from
  // leaving.
  const own = await tempDir();
  const ownService = await start(own);
  const ownBase = `http://127.0.0.1:${ownService.port}`;
  const phone = `http://127.0.0.1:${ownService.phonePort}`;
  try {
    const file = path.join(own, 'state.json');
    const consoleToken = await consoleTokenOf(own);
    await waitForConsole(ownBase, consoleToken);
    await post(ownBase, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: consoleToken });
    const paired = JSON.parse(await readFile(file, 'utf8'));
    const session = await post(ownBase, '/api/v1/session', { code: paired.pairing.code, name: '要走的那台' });
    const body = await session.json();

    // The bag of the pairing is filled with wrong codes.
    let locked = false;
    for (let i = 0; i < 120; i += 1) {
      const response = await post(ownBase, '/api/v1/session', { code: 'wrong-code-' + i, name: 'x' });
      if (response.status === 429) { locked = true; break; }
    }
    assert.ok(locked, 'the door of the pairing is shut');

    // The phone can still go.
    const goodbye = await post(phone, '/api/v1/device/forget', {}, {
      Authorization: 'Bearer ' + body.token,
    });
    assert.equal(goodbye.status, 200);
    assert.equal((await goodbye.json()).forgotten, true);
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(after.devices.find((device) => device.id === body.device.id), undefined);
  } finally {
    await ownService.close();
    await cleanup(own);
  }
});

test('the service starts again and the devices are still there', async () => {
  const file = path.join(dir, 'state.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  await service.close();
  service = await start(dir);
  base = `http://127.0.0.1:${service.port}`;
  await waitForConsole(base, before.consoleToken);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.devices.length, before.devices.length);
  assert.deepEqual(
    after.devices.map((device) => device.id).sort(),
    before.devices.map((device) => device.id).sort()
  );
});

test('the shared token of the old version is gone', async () => {
  // A state file of the old version: a shared token, a pairing code and
  // the record of the phones that were paired before. Nobody paired a phone
  // with that version, so the shared token is taken away when the file is
  // read, and a new phone pairs as if it were the first one.
  const oldDir = await tempDir();
  const legacyToken = 'legacy-shared-token-'.padEnd(43, 'x');
  await writeFile(
    path.join(oldDir, 'state.json'),
    JSON.stringify({
      version: 1,
      token: legacyToken,
      pairing: { code: 'old-code', createdAt: new Date().toISOString() },
      settings: { subscriptions: ['codex'] },
      paired: [{ at: new Date().toISOString(), address: '100.64.0.9' }],
    })
  );
  const old = await start(oldDir);
  const oldBase = `http://127.0.0.1:${old.port}`;
  try {
    // The shared token of the old version opens nothing.
    const answer = await fetch(oldBase + '/api/v1/overview', {
      headers: { Authorization: 'Bearer ' + legacyToken },
    });
    assert.equal(answer.status, 401);

    const saved = JSON.parse(await readFile(path.join(oldDir, 'state.json'), 'utf8'));
    assert.equal(saved.token, undefined);
    assert.equal(saved.devices.length, 0);

    // The console of this computer keeps a token of its own.
    const oldConsole = saved.consoleToken;
    assert.equal(typeof oldConsole, 'string');
    await waitForConsole(oldBase, oldConsole);
    const body = await (await fetch(oldBase + '/api/v1/console/state', {
      headers: { [TOKEN_HEADER]: oldConsole },
    })).json();
    assert.equal(body.devices.length, 0);
    assert.equal(body.token, undefined);

    // A new phone gets a token of its own.
    const fresh = JSON.parse(await readFile(path.join(oldDir, 'state.json'), 'utf8'));
    const paired = await post(oldBase, '/api/v1/session', { code: fresh.pairing.code, name: 'new phone' });
    assert.equal(paired.status, 200);
    const pairedBody = await paired.json();
    assert.notEqual(pairedBody.token, legacyToken);
    const allowed = await fetch(oldBase + '/api/v1/overview', {
      headers: { Authorization: 'Bearer ' + pairedBody.token },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await old.close();
    await cleanup(oldDir);
  }
});

test('the console of 0.2 survives the change to 0.2.1', async () => {
  // The state file of 0.2.0: a token for the console of this computer, the
  // shared token of the phones and one device that still carries the old
  // mark. The change takes the shared token away, but the console keeps the
  // token it had, so the page does not have to be opened again.
  const oldDir = await tempDir();
  const consoleToken = 'console-token-'.padEnd(43, 'x');
  const sharedToken = 'shared-token-'.padEnd(43, 'x');
  const moment = new Date().toISOString();
  await writeFile(
    path.join(oldDir, 'state.json'),
    JSON.stringify({
      version: 1,
      consoleToken,
      token: sharedToken,
      pairing: { code: 'old-code', createdAt: moment, expiresAt: new Date(Date.now() + 600000).toISOString() },
      settings: { subscriptions: ['codex'] },
      paired: [{ at: moment, address: '100.64.0.9', name: 'old phone' }],
      devices: [
        {
          id: 'legacy',
          name: 'old shared token',
          hash: 'x'.repeat(64),
          createdAt: moment,
          lastAccessAt: null,
          revokedAt: null,
          legacy: true,
        },
        {
          id: 'phone-a',
          name: 'iPhone A',
          hash: 'y'.repeat(64),
          createdAt: moment,
          lastAccessAt: null,
          revokedAt: null,
          legacy: false,
        },
      ],
    })
  );
  const old = await start(oldDir);
  const oldBase = `http://127.0.0.1:${old.port}`;
  try {
    // The console opens with the token it had before the change.
    await waitForConsole(oldBase, consoleToken);
    const body = await (await fetch(oldBase + '/api/v1/console/state', {
      headers: { [TOKEN_HEADER]: consoleToken },
    })).json();
    assert.equal(body.token, undefined);

    // The shared token of the phones opens nothing.
    const answer = await fetch(oldBase + '/api/v1/overview', {
      headers: { Authorization: 'Bearer ' + sharedToken },
    });
    assert.equal(answer.status, 401);

    // The file is cleaned up in place: the shared token is gone, the device
    // that carried the old mark is gone, the other phone stays.
    const saved = JSON.parse(await readFile(path.join(oldDir, 'state.json'), 'utf8'));
    assert.equal(saved.token, undefined);
    assert.equal(saved.consoleToken, consoleToken);
    assert.equal(saved.devices.length, 1);
    assert.equal(saved.devices[0].id, 'phone-a');
    assert.deepEqual(saved.settings, { subscriptions: ['codex'] });

    // A new phone pairs as if it were the first one.
    const fresh = JSON.parse(await readFile(path.join(oldDir, 'state.json'), 'utf8'));
    const paired = await post(oldBase, '/api/v1/session', { code: fresh.pairing.code, name: 'new phone' });
    assert.equal(paired.status, 200);
    const pairedBody = await paired.json();
    const allowed = await fetch(oldBase + '/api/v1/overview', {
      headers: { Authorization: 'Bearer ' + pairedBody.token },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await old.close();
    await cleanup(oldDir);
  }
});

test('the console and the phone put foreign words into the page as text', async () => {
  // There is no innerHTML left in the pages: everything that comes from
  // outside goes into the page as text.
  for (const file of ['ui/app.js', 'mobile/app.js', 'page/boot.js']) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'srcdoc', 'javascript:', 'eval(', 'new Function']) {
      assert.equal(source.includes(sink), false, `${file} must not use ${sink}`);
    }
  }
  // The console builds its rows with the API of the page.
  const app = await readFile(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(app, /textContent/);
  assert.match(app, /createElement/);
});

test('the console and the service use the same header for the token', async () => {
  // A different letter in the name of the header would close the console
  // without the tests noticing, so the name is compared here.
  const app = await readFile(path.join(root, 'ui/app.js'), 'utf8');
  assert.ok(
    app.includes(TOKEN_HEADER),
    'ui/app.js must send the same token header as lib/server.mjs expects',
  );
});

test('the address in the header of the request is not believed', async () => {
  // A service of its own, so that the door of the other tests stays open.
  const otherDir = await tempDir();
  const other = await start(otherDir);
  const otherBase = `http://127.0.0.1:${other.port}`;
  try {
    // Every try comes with a different address in the header. The address is
    // written by whoever asks, so it must not count as a new computer.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await post(otherBase, '/api/v1/session', { code: 'wrong' }, {
        'X-Forwarded-For': `10.0.0.${attempt + 1}`,
      });
      assert.equal(wrong.status, 403);
    }
    const locked = await post(otherBase, '/api/v1/session', { code: 'wrong' }, {
      'X-Forwarded-For': '10.9.9.9',
    });
    assert.equal(locked.status, 429);
  } finally {
    await other.close();
    await cleanup(otherDir);
  }
});

test('the page of the pairing code and the script are shut out as well', async () => {
  // The page of the code says whether a code is good. It is a door as well,
  // so it goes through the same limiter. Every door counts on its own: the
  // script is shut after ten tries, the page after thirty, and the door of
  // the pairing itself is not touched by them.
  const otherDir = await tempDir();
  const other = await start(otherDir);
  const otherBase = `http://127.0.0.1:${other.port}`;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const warm = await fetch(otherBase + '/scriptable/UsageWidget.js?code=wrong');
      assert.equal(warm.status, 403);
    }
    const script = await fetch(otherBase + '/scriptable/UsageWidget.js?code=wrong');
    assert.equal(script.status, 429);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const page = await fetch(otherBase + '/p/wrong');
      assert.equal(page.status, 410);
    }
    const page = await fetch(otherBase + '/p/wrong');
    assert.equal(page.status, 429);
    // The pairing itself is still open.
    const session = await post(otherBase, '/api/v1/session', { code: 'wrong' });
    assert.equal(session.status, 403);
  } finally {
    await other.close();
    await cleanup(otherDir);
  }
});

test('the file of the state belongs to the user of this computer alone', async (t) => {
  // Windows does not keep the rights of a file, so the check is only of
  // meaning on the other systems.
  if (process.platform === 'win32') {
    t.skip('Windows does not keep the rights of a file');
    return;
  }
  const file = path.join(dir, 'state.json');
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  const folder = (await stat(dir)).mode & 0o777;
  assert.equal(folder, 0o700);
});

test('the time of the last visit is written at most every five minutes', async () => {
  const device = { lastAccessAt: null };
  const now = Date.now();
  // The first visit is written down.
  assert.equal(noteAccess(device, now), true);
  assert.equal(device.lastAccessAt, new Date(now).toISOString());
  // The next one is not, the file is not written every time.
  assert.equal(noteAccess(device, now + 1000), false);
  assert.equal(device.lastAccessAt, new Date(now).toISOString());
  // After five minutes it is written again.
  assert.equal(noteAccess(device, now + 5 * 60_000), true);
  assert.equal(device.lastAccessAt, new Date(now + 5 * 60_000).toISOString());
});

test('a flood of wrong codes is shut out, and a new code opens the door again', async () => {
  // The service keeps one budget for all of its doors: a hundred wrong tries
  // in five minutes, whichever code they were aimed at, and the pairing is
  // closed for everybody. The person at the computer empties that budget by
  // asking for a new code, so the door is never stuck for good.
  const otherDir = await tempDir();
  const other = await start(otherDir);
  const otherBase = `http://127.0.0.1:${other.port}`;
  try {
    const token = await consoleTokenOf(otherDir);
    await waitForConsole(otherBase, token);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const wrong = await post(otherBase, '/api/v1/session', { code: `wrong-${attempt}` });
      assert.equal(wrong.status, 403);
    }
    // The bag is full now, so the next try is told to wait.
    const shut = await post(otherBase, '/api/v1/session', { code: 'wrong-again' });
    assert.equal(shut.status, 429);
    // The page of the code and the script are shut as well.
    const page = await fetch(otherBase + '/p/wrong-again');
    assert.equal(page.status, 429);
    const script = await fetch(otherBase + '/scriptable/UsageWidget.js?code=wrong-again');
    assert.equal(script.status, 429);
    // A new code at the computer empties the bag at once.
    const rotated = await post(otherBase, '/api/v1/console/pair', {}, { [TOKEN_HEADER]: token });
    assert.equal(rotated.status, 200);
    const fresh = (await rotated.json()).pairingCode;
    const good = await post(otherBase, '/api/v1/session', { code: fresh });
    assert.equal(good.status, 200);
    assert.ok((await good.json()).token);
  } finally {
    await other.close();
    await cleanup(otherDir);
  }
});
