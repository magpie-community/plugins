(() => {
  const messages = {
    en: {
      title: 'Fingerprint',
      connecting: 'Connecting to Fingerprint…',
      remote:
        'Upgrade Magpie for remote plugin services, or forward the service port to this computer over SSH.',
      invalidPort: 'Invalid Fingerprint service port.',
      failed: 'Could not connect',
      fallback: 'If the page does not open, copy this address into a browser on this computer:',
      copyAddress: 'Copy address',
      copied: 'Address copied.',
      copyFallback: 'Address selected. Copy it and open it in a browser on this computer.',
    },
    'zh-Hans': {
      title: '模型指纹',
      connecting: '正在连接模型指纹服务…',
      remote: '请升级 Magpie 以支持远程插件服务，或将服务器的服务端口通过 SSH 转发到本机。',
      invalidPort: '模型指纹服务端口无效。',
      failed: '连接失败',
      fallback: '如果页面未打开，请将此地址复制到本机浏览器：',
      copyAddress: '复制地址',
      copied: '地址已复制。',
      copyFallback: '已选中地址，请复制后在本机浏览器中打开。',
    },
    'zh-Hant': {
      title: '模型指紋',
      connecting: '正在連線至模型指紋服務…',
      remote: '請升級 Magpie 以支援遠端外掛服務，或透過 SSH 將伺服器的服務連接埠轉送至本機。',
      invalidPort: '模型指紋服務連接埠無效。',
      failed: '連線失敗',
      fallback: '如果頁面未開啟，請將此網址複製到本機瀏覽器：',
      copyAddress: '複製網址',
      copied: '網址已複製。',
      copyFallback: '已選取網址，請複製後在本機瀏覽器中開啟。',
    },
    ja: {
      title: 'モデル指紋',
      connecting: 'モデル指紋サービスに接続中…',
      remote:
        'リモートプラグインサービスを利用するには、Magpie を更新するか、SSH でサービスポートをこのコンピューターに転送してください。',
      invalidPort: 'モデル指紋サービスのポートが無効です。',
      failed: '接続できませんでした',
      fallback:
        'ページが開かない場合は、このアドレスをこのコンピューターのブラウザーにコピーしてください：',
      copyAddress: 'アドレスをコピー',
      copied: 'アドレスをコピーしました。',
      copyFallback: 'アドレスを選択しました。このコンピューターのブラウザーに貼り付けてください。',
    },
    de: {
      title: 'Modell-Fingerabdruck',
      connecting: 'Verbindung zum Fingerabdruck-Dienst wird hergestellt…',
      remote:
        'Aktualisieren Sie Magpie für entfernte Plugin-Dienste oder leiten Sie den Dienstport per SSH an diesen Computer weiter.',
      invalidPort: 'Ungültiger Port für den Fingerabdruck-Dienst.',
      failed: 'Verbindung fehlgeschlagen',
      fallback:
        'Falls sich die Seite nicht öffnet, diese Adresse im Browser auf diesem Computer öffnen:',
      copyAddress: 'Adresse kopieren',
      copied: 'Adresse kopiert.',
      copyFallback: 'Adresse ausgewählt. Kopieren und im Browser auf diesem Computer öffnen.',
    },
  };
  let text = messages.en;
  const status = document.getElementById('status');
  function followLanguage(theme) {
    const language = String(theme?.lang || 'en')
      .toLowerCase()
      .replaceAll('_', '-');
    const parts = language.split('-');
    const key =
      parts[0] === 'zh'
        ? parts.includes('hant') ||
          (!parts.includes('hans') && parts.some((part) => ['tw', 'hk', 'mo'].includes(part)))
          ? 'zh-Hant'
          : 'zh-Hans'
        : parts[0];
    text = messages[key] || messages.en;
    document.documentElement.lang = messages[key] ? key : 'en';
    document.title = text.title;
    document.getElementById('title').textContent = text.title;
    status.textContent = text.connecting;
  }
  return (async () => {
    const theme = await window.magpie?.ready;
    followLanguage(theme);
    window.magpie?.onTheme?.(followLanguage);
    const config = (await window.magpie?.options?.get?.()) || {};
    const port = Number(config.port ?? 4388);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(text.invalidPort);
    let service = window.magpie?.service;
    let localFallback = '';
    if (!service) {
      // This computer's window: wails://localhost on macOS and Linux,
      // http://wails.localhost on Windows (Wails v3, WebView2).
      const host = String(location.hostname || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '');
      const local =
        !host ||
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '::1' ||
        /^127\./.test(host);
      if (!local) {
        status.textContent = text.remote;
        return;
      }
      service = `http://127.0.0.1:${port}/`;
      localFallback = service;
    }
    const url = new URL(service, location.href);
    // Opaque Magpie web frames need the concrete proxy origin in connect-src.
    url.searchParams.set('uiOrigin', url.origin);
    if (theme) {
      url.searchParams.set('theme', theme.dark ? 'dark' : 'light');
      if (theme.lang) url.searchParams.set('lang', theme.lang);
    }
    const context = window.magpie?.context?.provider;
    if (context?.id) url.searchParams.set('provider', context.id);
    window.magpie?.onAction((action) => {
      if (action?.provider?.id) {
        url.searchParams.set('provider', action.provider.id);
        location.replace(url.href);
      }
    });
    if (localFallback) {
      setTimeout(() => {
        status.textContent = text.fallback;
        const field = document.getElementById('service-url');
        field.value = localFallback;
        const copy = document.getElementById('copy-service-url');
        copy.textContent = text.copyAddress;
        copy.onclick = async () => {
          try {
            const clipboard = window.navigator?.clipboard;
            if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
            await clipboard.writeText(localFallback);
            status.textContent = text.copied;
          } catch {
            field.focus();
            field.select();
            status.textContent = text.copyFallback;
          }
        };
        document.getElementById('fallback').hidden = false;
      }, 4000);
    }
    location.replace(url.href);
  })().catch((error) => {
    status.textContent = `${text.failed}: ${String(error?.message || error)}`;
  });
})();
