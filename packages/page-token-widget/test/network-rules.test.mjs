// The rules of the addresses: one file decides them for the service, and the
// installer of the phone has to decide the same thing the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkExternalURL, checkGatewayURL, isTrustedAddress } from '../lib/network.mjs';

// The rules of the installer of the phone, taken out of the script as it is
// written and run in a plain context: the script itself cannot be imported
// (it wants Scriptable), but these two functions only work on strings.
const installerSource = readFileSync(
  new URL('../scriptable/SetupUsageWidget.js', import.meta.url),
  'utf8',
);
const rules = installerSource.slice(
  installerSource.indexOf('const PLAIN_TEXT_REFUSAL'),
  installerSource.indexOf('const checked = checkServiceAddress'),
);
const context = vm.createContext({});
vm.runInContext(`${rules}\nthis.checkServiceAddress = checkServiceAddress;`, context);
const checkServiceAddress = context.checkServiceAddress;

test('the address the phone is told to use is checked', () => {
  const good = [
    'http://192.168.1.50:3499',
    'http://10.0.0.7:3499',
    'http://172.16.3.9:3499',
    'http://100.64.0.5:3499',
    'http://169.254.1.1:3499',
    'http://127.0.0.1:3499',
    'http://[::1]:3499',
    'http://[fd00::1]:3499',
    'http://[fe80::1]:3499',
    'http://box.local:3499',
    'http://myserver:3499',
    'https://example.com',
    'https://my-server.example.com',
    'https://example.com:8443',
  ];
  for (const address of good) {
    const answer = checkExternalURL(address);
    assert.equal(answer.ok, true, `${address} should be allowed: ${answer.error || ''}`);
    assert.ok(answer.url.startsWith('http'), `${address} should keep its scheme`);
  }

  const bad = [
    'http://example.com',
    'http://93.184.216.34:3499',
    'http://[2001:db8::1]:3499',
    'https://example.com/widget',
    'http://192.168.1.50:3499/widget',
    'http://example.com:99999',
    'http://example.com:0',
    'http://user@example.com',
    'http://user:secret@example.com',
    'http://example.com?token=1',
    'http://example.com#part',
    'ftp://example.com',
    'http://exa mple.com',
    'this is not an address',
  ];
  for (const address of bad) {
    const answer = checkExternalURL(address);
    assert.equal(answer.ok, false, `${address} should be refused`);
    assert.ok(answer.error && answer.error.length > 4, `${address} should say why`);
  }
});

test('an empty address means the default way', () => {
  const answer = checkExternalURL('');
  assert.equal(answer.ok, true);
  assert.equal(answer.empty, true);
});

test('a refused address says why it was refused', () => {
  const plain = checkExternalURL('http://example.com');
  assert.match(plain.error, /HTTPS/);

  const path = checkExternalURL('https://example.com/widget');
  assert.match(path.error, /路径/);
});

test('the rules of the phone and of the service are the same', () => {
  const addresses = [
    'http://192.168.1.50:3499',
    'http://10.0.0.7:3499',
    'http://172.16.3.9:3499',
    'http://100.64.0.5:3499',
    'http://169.254.1.1:3499',
    'http://127.0.0.1:3499',
    'http://[::1]:3499',
    'http://[fd00::1]:3499',
    'http://box.local:3499',
    'http://box.ts.net',
    'http://myserver:3499',
    'https://example.com',
    'https://my-server.example.com',
    'https://example.com:8443',
    'http://example.com',
    'http://93.184.216.34:3499',
    'http://[2001:db8::1]:3499',
    'https://example.com/widget',
    'http://example.com:99999',
    'http://example.com:0',
    'http://user@example.com',
    'http://example.com?token=1',
    'http://example.com#part',
    'ftp://example.com',
  ];
  for (const address of addresses) {
    const server = checkExternalURL(address);
    const phone = checkServiceAddress(address);
    assert.equal(
      phone.ok,
      server.ok,
      `${address}: the phone says ${phone.ok ? 'allowed' : 'refused'}, the service says ${server.ok ? 'allowed' : 'refused'}`,
    );
  }
});

test('a trusted address is decided by the text of it, not by a name', () => {
  assert.equal(isTrustedAddress('192.168.1.1'), true);
  assert.equal(isTrustedAddress('100.64.0.5'), true);
  assert.equal(isTrustedAddress('100.128.0.5'), false);
  assert.equal(isTrustedAddress('[fd00::1]'), true);
  assert.equal(isTrustedAddress('[2001:db8::1]'), false);
  assert.equal(isTrustedAddress('box.local'), true);
  assert.equal(isTrustedAddress('example.com'), false);
});

test('the gateway of Magpie has to be on this computer', () => {
  assert.equal(checkGatewayURL('').url, 'http://127.0.0.1:3425');
  assert.equal(checkGatewayURL('http://127.0.0.1:3425').ok, true);
  assert.equal(checkGatewayURL('http://127.0.0.1:3500').ok, true);
  assert.equal(checkGatewayURL('http://[::1]:3425').ok, true);
  assert.equal(checkGatewayURL('http://localhost:3425').ok, true);

  const far = checkGatewayURL('http://magpie.example.com:3425');
  assert.equal(far.ok, false);
  assert.match(far.error, /本机/);

  assert.equal(checkGatewayURL('http://10.0.0.5:3425').ok, false);
  assert.equal(checkGatewayURL('ftp://127.0.0.1:3425').ok, false);
  assert.equal(checkGatewayURL('not an address').ok, false);
  assert.equal(checkGatewayURL('http://127.0.0.1:3425/magpie').ok, false);
  // A trailing slash does not make two slashes of the path.
  assert.equal(checkGatewayURL('http://127.0.0.1:3425/').url, 'http://127.0.0.1:3425');
});
