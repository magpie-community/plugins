// All user-facing plugin text, in magpie's plugin i18n shape: the English
// string is the default (label/description), and per-locale maps (labels /
// descriptions) override it. Locales follow the community plugins (zh first,
// then zh-TW / ja where they read naturally).

export const LOGIN_INSTRUCTIONS =
  "Open the link below and sign in to TokenRhythm; the plugin waits for the OAuth callback on 127.0.0.1 and then creates or reuses the account's managed model key. The plaintext key is shown once by TokenRhythm and kept by the plugin for model calls."

export const OAUTH_METHOD = {
  type: "oauth",
  label: "Browser sign-in (managed model key + balance)",
  labels: {
    zh: "浏览器登录（托管密钥 + 余额）",
    "zh-TW": "瀏覽器登入（託管金鑰 + 餘額）",
    ja: "ブラウザでサインイン（管理モデルキー + 残高）",
  },
}

export const API_METHOD = {
  type: "api",
  label: "API key only (models, no balance card)",
  labels: {
    zh: "仅 API 密钥（模型可用，无余额卡片）",
    "zh-TW": "僅 API 金鑰（模型可用，無餘額卡片）",
    ja: "API キーのみ（モデル利用可、残高カードなし）",
  },
}

export const API_KEY_PROMPT_MESSAGE = "TokenRhythm model API key (sk_tr_…)"

export const CREATE_KEY_OPTION = {
  key: "create_key",
  label: "Create a managed model key on browser sign-in",
  labels: {
    zh: "浏览器登录后自动创建托管模型 Key",
    "zh-TW": "瀏覽器登入後自動建立託管模型 Key",
    ja: "ブラウザサインイン後に管理モデルキーを自動作成",
  },
  description:
    "After the TokenRhythm browser sign-in, obtain the account's managed model key (the OpenAI-compatible Bearer). TokenRhythm shows the plaintext once; the plugin keeps it for model calls.",
  descriptions: {
    zh: "TokenRhythm 浏览器登录成功后，自动获取账户的托管模型密钥（OpenAI 兼容 Bearer）。明文密钥只在 TokenRhythm 显示一次，由插件保存用于模型调用。",
    "zh-TW": "TokenRhythm 瀏覽器登入成功後，自動取得帳戶的託管模型金鑰（OpenAI 相容 Bearer）。明文金鑰只在 TokenRhythm 顯示一次，由外掛保存用於模型呼叫。",
    ja: "TokenRhythm のブラウザサインイン後、アカウントの管理モデルキー（OpenAI 互換 Bearer）を取得します。平文のキーは TokenRhythm に一度だけ表示され、プラグインがモデル呼び出しのために保管します。",
  },
  default: true,
}
