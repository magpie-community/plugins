import { createHash } from "node:crypto";

export function revision(provider) {
  return createHash("sha256").update(JSON.stringify(provider)).digest("hex").slice(0, 24);
}

export function safeAddress(address) {
  if (!address || address === "direct" || address.startsWith("@")) return address || "";
  try {
    const parsed = new URL(address);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "自定义代理（地址已隐藏）";
  }
}

export function validateAddress(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error("请输入完整的 HTTP、HTTPS 或 SOCKS5 代理地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) ||
      !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw new Error("代理地址只填写协议、主机和端口，认证请使用单独的输入框");
  }
  return address;
}

export function projectState(settings, listing, storedProviders, history) {
  const publicChoice = (choice) => !choice || choice === "direct" || choice.startsWith("@") ? choice || "" : "__custom__";
  const proxies = (settings.proxies || []).map((proxy) => {
    const record = history.proxies[proxy.id] || {};
    return {
      id: proxy.id, name: proxy.name, url: safeAddress(proxy.url),
      user: proxy.user || "", hasPass: !!proxy.hasPass,
      uses: proxy.uses || [], check: record.last || null,
      expectedIp: record.expectedIp || "",
      lastGood: record.lastGood || null,
      changed: !!record.expectedIp && !!record.lastGood?.ip && record.expectedIp !== record.lastGood.ip
    };
  });
  const globalChoice = settings.settings?.proxy || "";
  const globalAddress = settings.proxyNow || "";
  function exit(choice) {
    if (choice === "direct") return { label: "VPS 直连", kind: "direct", ip: "", state: "unmeasured" };
    if (choice.startsWith("@")) {
      const proxy = proxies.find((item) => item.id === choice.slice(1));
      if (!proxy) return { label: "代理已丢失", kind: "missing", ip: "", state: "missing" };
      const state = !proxy.check ? "unchecked" : !proxy.check.ok ? "failed" : proxy.changed ? "changed" : "ok";
      return { label: proxy.name, kind: "saved", id: proxy.id, ip: proxy.lastGood?.ip || "", state };
    }
    if (!choice) {
      if (globalChoice) return { ...exit(globalChoice), inheritedGlobal: true };
      if (globalAddress) return { label: "全局 / 环境代理", kind: "custom", address: safeAddress(globalAddress), ip: "", state: "unmeasured" };
      return { label: "VPS 直连", kind: "direct", ip: "", state: "unmeasured" };
    }
    return { label: "自定义代理", kind: "custom", address: safeAddress(choice), ip: "", state: "unmeasured" };
  }
  const providers = (listing.providers || []).map((provider) => {
    const stored = storedProviders.find((item) => item.id === provider.id);
    const own = stored?.accountProxies || provider.accountProxies || {};
    const providerChoice = stored?.proxy ?? provider.proxy ?? "";
    const logins = provider.account?.logins || [];
    const accounts = logins.length ? logins.map((login) => {
      const account = (login.user || "").trim().toLowerCase();
      return {
        id: account, kind: "account",
        name: provider.accountNames?.[account] || login.user || "未命名账号",
        on: login.on !== false, choice: publicChoice(own[account] || ""),
        exit: exit(own[account] || providerChoice), active: !!login.active
      };
    }) : provider.account?.user ? [{
      id: provider.account.user.trim().toLowerCase(), kind: "account",
      name: provider.account.user, on: true,
      choice: publicChoice(own[provider.account.user.trim().toLowerCase()] || ""),
      exit: exit(own[provider.account.user.trim().toLowerCase()] || providerChoice)
    }] : (provider.keyList || []).map((key) => ({
      id: key.id, kind: "key", name: key.name || key.masked || `Key ${key.id.slice(0, 6)}`,
      on: key.on !== false, choice: publicChoice(own[key.id] || ""),
      exit: exit(own[key.id] || providerChoice), active: !!key.active
    }));
    return {
      id: provider.id, name: provider.name || provider.id,
      off: !!provider.off, plugin: provider.account?.agent === "plugin",
      choice: publicChoice(providerChoice), exit: exit(providerChoice), accounts,
      revision: stored ? revision(stored) : "",
      editable: !!stored
    };
  });
  return {
    proxies, providers, global: { choice: publicChoice(globalChoice), exit: exit("") },
    events: history.events.slice(0, 40),
    checkedAt: Date.now()
  };
}

export function recordCheck(history, id, result, now = Date.now()) {
  const previous = history.proxies[id] || {};
  const next = { ...previous, last: { ...result, at: result.at ? result.at * 1000 : now } };
  if (result.ok && result.ip) {
    next.lastGood = next.last;
    next.expectedIp ||= result.ip;
  }
  history.proxies[id] = next;
  const previousIp = previous.lastGood?.ip;
  if (result.ok && previousIp && previousIp !== result.ip) {
    history.events.unshift({ type: "ip-change", proxy: id, before: previousIp, after: result.ip, at: now });
  }
  if (!result.ok && previous.last?.ok !== false) {
    history.events.unshift({ type: "failure", proxy: id, at: now, message: result.error || "检测失败" });
  }
  history.events = history.events.slice(0, 100);
}

export function bindingPayload(stored, input, provider, savedProxies) {
  if (input.revision !== revision(stored)) throw Object.assign(new Error("供应商设置已变化，请刷新页面后重试"), { status: 409 });
  if (typeof input.choice !== "string" ||
      !["", "direct", ...savedProxies.map((proxy) => `@${proxy.id}`)].includes(input.choice)) {
    throw new Error("请选择已登记的代理、继承设置或直连");
  }
  const payload = structuredClone(stored);
  if (input.kind === "provider") {
    payload.proxy = input.choice;
  } else if (["account", "key"].includes(input.kind)) {
    const target = provider.accounts.find((account) => account.kind === input.kind && account.id === input.account);
    if (!target) throw new Error("账号或 Key 已不存在，请刷新页面");
    payload.accountProxies = { ...(stored.accountProxies || {}) };
    if (input.choice) payload.accountProxies[input.account] = input.choice;
    else delete payload.accountProxies[input.account];
  } else {
    throw new Error("不支持的绑定类型");
  }
  return payload;
}

export function changedFields(before, after) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
