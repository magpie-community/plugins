// No data read is requested until Magpie provides a permissioned quota-window read.
(async () => {
  const words = {
    en: {
      title: "Quota estimates", intro: "Token capacity and API-equivalent USD for a full allowance window",
      status: "Waiting for a Magpie data read", unavailable: "Quota estimates are not available yet",
      reason: "Magpie's page bridge currently exposes usage totals and provider names, but not account-specific quota windows or their matching usage. Those totals cannot estimate a 5-hour or weekly allowance.",
      five: "5-hour allowance", week: "Weekly allowance", capacity: "Full-window estimate",
      pending: "Awaiting a permissioned quota-window read", details: "Data needed",
      needed: "Each account needs its quota percentage, reset and sample times, and usage totals for that same window, with coverage and API-price status. Local and Remote data must stay separate. Native Claude usage needs a host-supported import; the page does not read session files.",
      footer: "Estimates will remain observations, not provider guarantees or subscription bills.",
      boundary: "Page only · No data reads or background collector",
    },
    zh: {
      title: "额度预估", intro: "预估额度用满对应的 Token 与 API 等值美元",
      status: "等待 Magpie 数据接口", unavailable: "额度预估暂不可用",
      reason: "Magpie 页面桥接目前仅提供用量总计和供应商名称，尚未提供按账号划分的额度窗口及其对应用量。这些总计无法用于推算 5 小时或周额度。",
      five: "5 小时额度", week: "周额度", capacity: "用满预估",
      pending: "等待带权限声明的额度窗口接口", details: "所需数据",
      needed: "每个账号需要额度比例、重置时间、采样时间，以及同一窗口内的用量、记录覆盖和 API 价格状态。本机与 Remote 数据须分别归属。Claude 原生用量需要宿主支持导入；页面不读取会话文件。",
      footer: "预估属于观察值，不是供应商承诺的额度或订阅账单。",
      boundary: "纯页面 · 不读取数据，不运行后台采集",
    },
    "zh-TW": {
      title: "額度預估", intro: "預估額度用滿對應的 Token 與 API 等值美元",
      status: "等待 Magpie 資料介面", unavailable: "額度預估暫不可用",
      reason: "Magpie 頁面橋接目前僅提供用量總計和供應商名稱，尚未提供按帳號劃分的額度視窗及其對應用量。這些總計無法用於推算 5 小時或週額度。",
      five: "5 小時額度", week: "週額度", capacity: "用滿預估",
      pending: "等待帶權限宣告的額度視窗介面", details: "所需資料",
      needed: "每個帳號需要額度比例、重置時間、取樣時間，以及同一視窗內的用量、記錄涵蓋和 API 價格狀態。本機與 Remote 資料須分別歸屬。Claude 原生用量需要宿主支援匯入；頁面不讀取工作階段檔案。",
      footer: "預估屬於觀察值，不是供應商承諾的額度或訂閱帳單。",
      boundary: "純頁面 · 不讀取資料，不執行背景收集",
    },
    ja: {
      title: "クォータの推定", intro: "利用枠全体の Token 数と API 料金相当額（米ドル）",
      status: "Magpie の読み取り API を待っています", unavailable: "クォータはまだ推定できません",
      reason: "現在のページブリッジが提供するのは使用量の合計とプロバイダー名のみです。アカウント別の利用枠と同じ期間の使用量がないため、5 時間枠や週間枠は推定できません。",
      five: "5 時間の利用枠", week: "週間の利用枠", capacity: "利用枠全体の推定",
      pending: "権限を宣言する利用枠 API が必要です", details: "必要なデータ",
      needed: "アカウントごとの使用率、リセット時刻、取得時刻、同じ期間の使用量、記録の網羅性、API 料金の有無が必要です。ローカルと Remote のデータは区別します。Claude のネイティブ使用量にはホスト側のインポート対応が必要で、ページは会話ファイルを読みません。",
      footer: "推定は観測値であり、プロバイダーが保証する上限やサブスクリプションの請求額ではありません。",
      boundary: "ページのみ · データの読み取りやバックグラウンド収集なし",
    },
    de: {
      title: "Kontingentschätzung", intro: "Token-Kapazität und API-Gegenwert in USD für ein volles Kontingent",
      status: "Warten auf eine Magpie-Leseschnittstelle", unavailable: "Kontingentschätzungen sind noch nicht verfügbar",
      reason: "Die Seiten-Bridge liefert derzeit nur Nutzungssummen und Anbieternamen. Ohne kontobezogene Kontingentfenster und deren passende Nutzung lässt sich weder das 5-Stunden- noch das Wochenkontingent schätzen.",
      five: "5-Stunden-Kontingent", week: "Wochenkontingent", capacity: "Schätzung des vollen Kontingents",
      pending: "Eine Kontingent-Leseschnittstelle mit deklarierter Berechtigung fehlt", details: "Benötigte Daten",
      needed: "Pro Konto werden Nutzungsanteil, Rücksetz- und Abfragezeit sowie die Nutzung im selben Fenster samt Abdeckung und API-Preisstatus benötigt. Lokale und Remote-Daten müssen getrennt bleiben. Native Claude-Nutzung erfordert einen Import durch Magpie; die Seite liest keine Sitzungsdateien.",
      footer: "Schätzungen sind Beobachtungen, keine garantierten Anbieterlimits oder Abonnementrechnungen.",
      boundary: "Nur Seite · Keine Datenabfragen oder Hintergrundsammlung",
    },
  };
  function paint(theme) {
    const lang = theme.lang || "en";
    const t = words[lang] || words[lang.split("-")[0]] || words.en;
    document.title = t.title;
    document.querySelectorAll("[data-t]").forEach(node => { node.textContent = t[node.dataset.t]; });
    document.getElementById("cards").setAttribute("aria-busy", "false");
  }
  paint(await magpie.ready);
  magpie.onTheme(paint);
})();
