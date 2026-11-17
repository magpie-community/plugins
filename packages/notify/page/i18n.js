// English source strings; the window's language (magpie.theme.lang) picks
// zh, zh-TW, ja or de. A string with no entry shows in English.
(function () {
  "use strict"
  var T = {
    "Notify": { zh: "通知", "zh-TW": "通知", ja: "通知", de: "Benachrichtigungen" },
    "Notifications on": { zh: "开启通知", "zh-TW": "開啟通知", ja: "通知をオン", de: "Benachrichtigungen an" },
    "Channels": { zh: "渠道", "zh-TW": "管道", ja: "チャンネル", de: "Kanäle" },
    "Add channel": { zh: "添加渠道", "zh-TW": "新增管道", ja: "チャンネルを追加", de: "Kanal hinzufügen" },
    "No channel yet. Nothing is sent.": { zh: "还没有渠道，不会发送任何推送。", "zh-TW": "還沒有管道，不會發送任何推播。", ja: "チャンネルがありません。何も送信されません。", de: "Noch kein Kanal. Es wird nichts gesendet." },
    "Remove": { zh: "删除", "zh-TW": "刪除", ja: "削除", de: "Entfernen" },
    "Sending": { zh: "发送", "zh-TW": "發送", ja: "送信", de: "Senden" },
    "Incomplete, skipped": { zh: "未填完整，已跳过", "zh-TW": "未填完整，已略過", ja: "未入力のためスキップ", de: "Unvollständig, übersprungen" },
    "When to send": { zh: "何时推送", "zh-TW": "何時推播", ja: "送信する条件", de: "Wann senden" },
    "Only turns longer than (minutes)": { zh: "只推送超过（分钟）的任务", "zh-TW": "只推播超過（分鐘）的任務", ja: "この時間（分）を超えたターンのみ", de: "Nur Durchläufe länger als (Minuten)" },
    "One push per conversation every (seconds)": { zh: "同一会话推送间隔（秒）", "zh-TW": "同一對話推播間隔（秒）", ja: "同じ会話への送信間隔（秒）", de: "Eine Meldung je Unterhaltung alle (Sekunden)" },
    "Turns that end in an error": { zh: "出错结束的任务", "zh-TW": "出錯結束的任務", ja: "エラーで終わったターン", de: "Durchläufe, die mit Fehler enden" },
    "Account needs signing in again": { zh: "账号需要重新登录", "zh-TW": "帳號需要重新登入", ja: "アカウントの再サインインが必要", de: "Konto muss neu angemeldet werden" },
    "Include the start of the reply": { zh: "附上回复开头", "zh-TW": "附上回覆開頭", ja: "返信の冒頭を含める", de: "Anfang der Antwort anhängen" },
    "Also gateway-key and remote requests": { zh: "也包括网关密钥和远程设备的请求", "zh-TW": "也包括閘道金鑰和遠端裝置的請求", ja: "ゲートウェイキーとリモートのリクエストも対象", de: "Auch Gateway-Key- und Remote-Anfragen" },
    "Only these agents (ids, comma separated)": { zh: "只限这些 agent（id，逗号分隔，留空为全部）", "zh-TW": "只限這些 agent（id，逗號分隔，留空為全部）", ja: "対象 agent（id をカンマ区切り、空欄は全て）", de: "Nur diese Agents (IDs, kommagetrennt, leer: alle)" },
    "Language of the push": { zh: "推送语言", "zh-TW": "推播語言", ja: "通知の言語", de: "Sprache der Meldung" },
    "Save": { zh: "保存", "zh-TW": "儲存", ja: "保存", de: "Speichern" },
    "Saved": { zh: "已保存", "zh-TW": "已儲存", ja: "保存しました", de: "Gespeichert" },
    "Unsaved changes": { zh: "有未保存的更改", "zh-TW": "有未儲存的變更", ja: "未保存の変更があります", de: "Ungespeicherte Änderungen" },
    "Could not save": { zh: "保存失败", "zh-TW": "儲存失敗", ja: "保存できませんでした", de: "Speichern fehlgeschlagen" },
    "Could not read the settings": { zh: "读取设置失败", "zh-TW": "讀取設定失敗", ja: "設定を読み込めませんでした", de: "Einstellungen nicht lesbar" },
    "Topic": { zh: "主题", "zh-TW": "主題", ja: "トピック", de: "Topic" },
    "Server": { zh: "服务器", "zh-TW": "伺服器", ja: "サーバー", de: "Server" },
    "Token": { zh: "令牌", "zh-TW": "權杖", ja: "トークン", de: "Token" },
    "Key": { zh: "密钥", "zh-TW": "金鑰", ja: "キー", de: "Schlüssel" },
    "Secret": { zh: "签名密钥", "zh-TW": "簽名金鑰", ja: "署名シークレット", de: "Secret" },
    "Group": { zh: "分组", "zh-TW": "群組", ja: "グループ", de: "Gruppe" },
    "Sound": { zh: "铃声", "zh-TW": "鈴聲", ja: "サウンド", de: "Ton" },
    "Priority": { zh: "优先级", "zh-TW": "優先順序", ja: "優先度", de: "Priorität" },
    "Chat ID": { zh: "聊天 ID", "zh-TW": "聊天 ID", ja: "チャット ID", de: "Chat-ID" },
    "Webhook URL": { zh: "Webhook 地址", "zh-TW": "Webhook 位址", ja: "Webhook URL", de: "Webhook-URL" },
    "Custom webhook": { zh: "自定义 webhook", "zh-TW": "自訂 webhook", ja: "カスタム webhook", de: "Eigener Webhook" },
    "Server酱": { ja: "Server酱", de: "Server酱" },
    "Feishu": { zh: "飞书", "zh-TW": "飛書", ja: "Feishu", de: "Feishu" },
    "DingTalk": { zh: "钉钉", "zh-TW": "釘釘", ja: "DingTalk", de: "DingTalk" },
    "WeCom": { zh: "企业微信", "zh-TW": "企業微信", ja: "WeCom", de: "WeCom" }
  }
  var lang = "en"
  var listeners = []
  function t(s) { var e = T[s]; return (e && e[lang]) || s }
  function apply(theme) {
    var l = theme && theme.lang
    lang = l === "zh" || l === "zh-TW" || l === "ja" || l === "de" ? l : "en"
    document.documentElement.lang = lang
    document.title = t("Notify")
    listeners.forEach(function (f) { f() })
  }
  window.NotifyI18n = { t: t, onChange: function (f) { listeners.push(f) } }
  var m = window.magpie
  if (m) {
    apply(m.theme)
    if (m.ready) m.ready.then(apply).catch(function () {})
    if (m.onTheme) m.onTheme(apply)
  }
})()
