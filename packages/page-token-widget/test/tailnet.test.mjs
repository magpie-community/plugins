import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindCandidates, detect, interfaceKind, interfaces, lanCandidates, peerPath, pingPath, prefixLength,
} from '../lib/tailnet.mjs';
import { mockTailscale, tailscaleStatus } from './helpers.mjs';

// The network cards of a computer that has a real network card, a wireless
// card, a card of a virtual machine and the card of Tailscale.
const cards = {
  'Loopback Pseudo-Interface 1': [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true },
    { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true },
  ],
  'Ethernet': [
    { address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', mac: 'a4:bb:6d:11:22:33' },
    { address: 'fe80::1a2b:3c4d:5e6f:7a8b', netmask: '64', family: 'IPv6', mac: 'a4:bb:6d:11:22:33' },
    { address: 'fd00:1234::5', netmask: '64', family: 'IPv6', mac: 'a4:bb:6d:11:22:33' },
  ],
  'WLAN 2': [
    { address: '10.0.0.42', netmask: '255.255.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff' },
    { address: '169.254.9.9', netmask: '255.255.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff' },
    { address: '224.0.0.251', netmask: '224.0.0.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff' },
  ],
  'vEthernet (WSL)': [
    { address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', mac: '00:15:5d:00:00:01' },
  ],
  'Tailscale': [
    { address: '100.64.0.1', netmask: '255.192.0.0', family: 'IPv4', mac: '00:15:5d:00:00:02' },
    { address: 'fd7a:115c:a1e0::1', netmask: '64', family: 'IPv6', mac: '00:15:5d:00:00:02' },
  ],
};

test('the kinds of the network cards are told apart', () => {
  assert.equal(interfaceKind('Tailscale'), 'tailscale');
  assert.equal(interfaceKind('Loopback Pseudo-Interface 1'), 'loopback');
  assert.equal(interfaceKind('WLAN 2'), 'wifi');
  assert.equal(interfaceKind('Ethernet'), 'ethernet');
  // A virtual card of a virtual machine is not a wire.
  assert.equal(interfaceKind('vEthernet (WSL)'), 'virtual');
  assert.equal(interfaceKind('VMware Network Adapter VMnet8'), 'virtual');
  assert.equal(interfaceKind('Docker Desktop'), 'virtual');
});

test('every network card of the machine is listed with its addresses', () => {
  const list = interfaces(cards);
  assert.equal(list.length, 5);
  const ethernet = list.find(entry => entry.name === 'Ethernet');
  assert.equal(ethernet.kind, 'ethernet');
  assert.equal(ethernet.ipv4[0].address, '192.168.1.50');
  assert.equal(ethernet.ipv4[0].prefix, 24);
  // The private address of IPv6 is kept, the link local one is not.
  assert.deepEqual(ethernet.ipv6.map(item => item.address), ['fd00:1234::5']);
  const wireless = list.find(entry => entry.name === 'WLAN 2');
  // The address that only says something about the local wire is left out.
  assert.deepEqual(wireless.ipv4.map(item => item.address), ['10.0.0.42']);
  const loopback = list.find(entry => entry.name === 'Loopback Pseudo-Interface 1');
  assert.equal(loopback.ipv4.length, 0);
  assert.equal(loopback.ipv6.length, 0);
});

test('the addresses of the home network are the private ones', () => {
  const candidates = lanCandidates(cards);
  const names = candidates.map(entry => entry.name);
  assert.deepEqual(names.sort(), ['Ethernet', 'WLAN 2']);
  const ethernet = candidates.find(entry => entry.name === 'Ethernet');
  // The private address of the network and the private address of IPv6.
  assert.deepEqual(ethernet.addresses, ['192.168.1.50', 'fd00:1234::5']);
  const wireless = candidates.find(entry => entry.name === 'WLAN 2');
  assert.deepEqual(wireless.addresses, ['10.0.0.42']);
  // The card of Tailscale and the cards of the virtual machines are not
  // addresses of the home network.
  assert.equal(candidates.some(entry => entry.name === 'Tailscale'), false);
  assert.equal(candidates.some(entry => entry.name === 'vEthernet (WSL)'), false);
});

test('the length of the network part is read from the mask', () => {
  assert.equal(prefixLength('255.255.255.0', 'IPv4'), 24);
  assert.equal(prefixLength('255.255.240.0', 'IPv4'), 20);
  assert.equal(prefixLength('255.255.0.0', 'IPv4'), 16);
  assert.equal(prefixLength('64', 'IPv6'), 64);
  assert.equal(prefixLength('nonsense', 'IPv4'), null);
});

test('the way to a phone is told apart', () => {
  // A phone that answers straight from its own address.
  assert.equal(peerPath({ Online: true, CurAddr: '192.168.10.44:41641' }), 'direct');
  // A phone that goes through a relay server.
  assert.equal(peerPath({ Online: true, CurAddr: '', Relay: 'hkg' }), 'derp');
  // A phone that goes through another device of the tailnet.
  assert.equal(peerPath({ Online: true, CurAddr: '', Relay: '', PeerRelay: 'lin-cpu' }), 'relay');
  // A phone that is not there.
  assert.equal(peerPath({ Online: false, CurAddr: '', Relay: 'hkg' }), 'offline');
  // A path that is not known is called unknown.
  assert.equal(peerPath({ Online: true, CurAddr: '', Relay: '' }), 'unknown');
  assert.equal(peerPath(null), 'unknown');
});

test('the answer of a ping tells the way as well', () => {
  assert.equal(pingPath('pong from 100.64.0.1:41641 in 12ms'), 'direct');
  assert.equal(pingPath('pong via 192.168.1.5 in 8ms'), 'direct');
  assert.equal(pingPath('pong via hkg (100.64.0.1) in 24ms'), 'derp');
  assert.equal(pingPath('pong via peer relay in 40ms'), 'relay');
  assert.equal(pingPath('something else'), 'unknown');
});

test('the status of the tailnet is read with the mock of the command', async () => {
  const mock = mockTailscale({ status: tailscaleStatus });
  const answer = await detect(mock.runner);
  assert.equal(answer.installed, true);
  assert.equal(answer.connected, true);
  assert.equal(answer.backendState, 'Running');
  assert.equal(answer.tailnetIP, '100.64.0.1');
  assert.equal(answer.dnsName, 'testnode.tail1234.ts.net');
  // The phone is on the same network, so the tailnet reaches it straight.
  assert.equal(answer.ios.length, 1);
  assert.equal(answer.ios[0].name, 'iphone');
  assert.equal(answer.ios[0].path, 'direct');
  assert.deepEqual(answer.ios[0].ips, ['100.64.0.2']);
  // The command of the mock was used, not the real one.
  assert.deepEqual(mock.calls, ['status --json']);
});

test('a tailnet that is not ready is not called ready', async () => {
  // The daemon of Tailscale can be there but not logged in. Then the tailnet
  // is not connected, and the console has to say so.
  for (const backendState of ['NeedsLogin', 'Starting', 'Stopped']) {
    const mock = mockTailscale({
      status: { ...tailscaleStatus, BackendState: backendState },
    });
    const answer = await detect(mock.runner);
    assert.equal(answer.installed, true);
    assert.equal(answer.connected, false);
    assert.equal(answer.backendState, backendState);
  }
});

test('a phone that is not there is not guessed at', async () => {
  const mock = mockTailscale({
    status: {
      ...tailscaleStatus,
      Peer: {
        p1: {
          HostName: 'iphone', DNSName: 'iphone.tail1234.ts.net.', OS: 'iOS',
          Online: false, Relay: 'hkg', CurAddr: '', TailscaleIPs: ['100.64.0.2'],
        },
      },
    },
  });
  const answer = await detect(mock.runner);
  assert.equal(answer.ios[0].online, false);
  assert.equal(answer.ios[0].path, 'offline');
});

test('the ping of a phone is asked for only when the user wants it', async () => {
  const mock = mockTailscale({ status: tailscaleStatus, ping: 'pong from 100.64.0.2:41641 in 9ms' });
  const { ping } = await import('../lib/tailnet.mjs');
  const answer = await ping('100.64.0.2', mock.runner);
  assert.equal(answer.ok, true);
  assert.equal(answer.path, 'direct');
  assert.deepEqual(mock.calls, ['ping --c 3 --timeout 3s 100.64.0.2']);
});

test('the network cards of this computer are listed as well', () => {
  // The computer of the test may have any number of cards; the list only has
  // to be there and to tell the kinds apart.
  const list = interfaces();
  assert.ok(Array.isArray(list));
  for (const entry of list) {
    assert.ok(typeof entry.name === 'string');
    assert.ok(['tailscale', 'loopback', 'wifi', 'virtual', 'ethernet', 'other'].includes(entry.kind));
  }
});

test('the addresses of a headscale of the user count too', () => {
  const cards = {
    tailscale0: [{ address: '100.64.0.1', family: 'IPv4', internal: false }],
    headscale0: [{ address: '100.64.0.7', family: 'IPv4', internal: false }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  };
  const addresses = bindCandidates(cards).map((entry) => entry.address);
  assert.ok(addresses.includes('100.64.0.7'), 'the address of the headscale');
  assert.ok(addresses.includes('192.168.1.20'), 'the address of the house');
  assert.ok(addresses.includes('100.64.0.1'), 'the address of the tailnet is one of them');
  assert.ok(!addresses.includes('127.0.0.1'), 'the loopback is left out');
});
