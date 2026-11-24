// Turn mihomo's /proxies map into a usable node catalogue.
// Clash subscriptions often put ad / "remaining traffic" placeholders inside
// proxy groups; those are proxies too, but not places you can route through.

const BUILTIN_TYPE_RE = /^(Direct|Reject|Compatible|Pass|PassRule|Relay)/i;
const BUILTIN_NAMES = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'PASS-RULE', 'REJECT-DROP']);

// Names used by airport subscriptions for informational pseudo-nodes.
const AD_PATTERNS = [
  /剩余流量|距离下次重置|套餐到期|到期时间|流量重置|已用流量|总流量/,
  /^\s*(剩余|重置|到期|套餐|官网|客服|购买|订阅)\s*[:：]/,
  /^https?:\/\//i,
  /官网|机场|订阅|购买|客服|群|推广|广告|一元\d+G/i,
  /^\d+元\d+G/i,
  /\b(GB|TB)\b.*(剩余|流量)/i,
];

export function isAdNode(name) {
  return AD_PATTERNS.some((re) => re.test(name));
}

export function isBuiltin(name, info) {
  return BUILTIN_TYPE_RE.test(info?.type || '') || BUILTIN_NAMES.has(name);
}

/** A node you can actually send traffic through. */
export function isRealNode(name, info) {
  if (!info || isBuiltin(name, info)) return false;
  if (Array.isArray(info.all)) return false; // a group, not a node
  if (isAdNode(name)) return false;
  return typeof info.type === 'string' && info.type.length > 0;
}

const REGIONS = [
  ['香港', /香港|HK|Hong ?Kong|港/i],
  ['日本', /日本|JP|Japan|东京|大阪|Tokyo/i],
  ['美国', /美国|US|United ?States|洛杉矶|硅谷|America/i],
  ['新加坡', /新加坡|SG|Singapore|狮城/i],
  ['台湾', /台湾|TW|Taiwan|台北/i],
  ['韩国', /韩国|KR|Korea|首尔/i],
  ['英国', /英国|UK|London|伦敦/i],
  ['德国', /德国|DE|Germany|法兰克福/i],
  ['法国', /法国|FR|France/i],
  ['荷兰', /荷兰|NL|Netherlands/i],
  ['加拿大', /加拿大|CA|Canada/i],
  ['澳大利亚', /澳大利亚|AU|Australia|悉尼/i],
  ['俄罗斯', /俄罗斯|RU|Russia/i],
  ['印度', /印度|IN|India/i],
  ['土耳其', /土耳其|TR|Turkey/i],
  ['越南', /越南|VN|Vietnam/i],
  ['泰国', /泰国|TH|Thailand/i],
  ['马来西亚', /马来西亚|MY|Malaysia/i],
  ['菲律宾', /菲律宾|PH|Philippines/i],
  ['巴西', /巴西|BR|Brazil/i],
];

export function regionOf(name) {
  for (const [label, re] of REGIONS) if (re.test(name)) return label;
  return '其他';
}

export function delayOf(info) {
  const h = info?.history;
  if (!Array.isArray(h) || h.length === 0) return null;
  const last = h[h.length - 1];
  return typeof last?.delay === 'number' ? last.delay : null;
}

/**
 * @param {object} proxies the `proxies` object from GET /proxies
 * @returns {{groups:Array, nodes:Array, byName:Map, all:Array}}
 */
export function catalogue(proxies) {
  const entries = Object.entries(proxies || {});
  const groups = [];
  const byName = new Map();

  for (const [name, info] of entries) {
    if (Array.isArray(info?.all)) {
      groups.push({
        name,
        type: info.type || 'Selector',
        now: info.now || '',
        all: info.all.slice(),
        selectable: /selector/i.test(info.type || '') || info.type === 'Selector',
      });
    }
    byName.set(name, info);
  }

  const set = new Set();
  for (const g of groups) {
    for (const n of g.all) if (isRealNode(n, byName.get(n))) set.add(n);
  }
  // Nodes that belong to no group are still usable.
  for (const [name, info] of entries) if (isRealNode(name, info)) set.add(name);

  const nodes = [...set].map((name) => {
    const info = byName.get(name) || {};
    return {
      name,
      type: info.type || '',
      region: regionOf(name),
      delay: delayOf(info),
      alive: info.alive !== false,
      udp: !!info.udp,
    };
  });
  nodes.sort((a, b) => a.region.localeCompare(b.region, 'zh') || a.name.localeCompare(b.name, 'zh'));

  return { groups, nodes, byName, all: entries.map(([n]) => n) };
}

/** The group a user's "pick a node" click should act on. */
export function pickMainGroup(groups, preferred = '') {
  if (preferred && groups.some((g) => g.name === preferred)) {
    return groups.find((g) => g.name === preferred);
  }
  const selector = groups.find((g) => g.selectable && g.name !== 'GLOBAL' && g.all.length > 2);
  if (selector) return selector;
  return groups.find((g) => g.name !== 'GLOBAL') || groups[0] || null;
}
