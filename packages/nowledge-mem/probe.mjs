// The page's connection test, run by the small loopback service the page
// navigates to. Magpie's page sandbox has no network (connect-src 'none'), so
// the page cannot call Mem itself; the service tests the saved plugin options,
// so no URL or key crosses the page and no page can aim it at another host.
import { MemFailure, request, resolveOptions } from "./mem.mjs";

const texts = {
    en: { testing: "Testing the connection…", connected: "Connected", failed: "Connection failed", back: "Back to settings", noReturn: "No settings page to return to.", noService: "The local test service did not answer.", unauthorized: "key rejected", unbound: "Space not found", unavailable: "unreachable", invalid: "invalid address", notfound: "Working Memory not supported", empty: "no answer", run: "Test" },
    zh: { testing: "正在测试连接…", connected: "连接正常", failed: "连接失败", back: "返回设置", noReturn: "没有可返回的设置页面。", noService: "本地测试服务没有响应。", unauthorized: "密钥被拒绝", unbound: "Space 不存在", unavailable: "无法连接", invalid: "地址无效", notfound: "不支持 Working Memory", empty: "没有返回内容", run: "测试" },
    "zh-TW": { testing: "正在測試連線…", connected: "連線正常", failed: "連線失敗", back: "返回設定", noReturn: "沒有可返回的設定頁面。", noService: "本機測試服務沒有回應。", unauthorized: "金鑰被拒絕", unbound: "Space 不存在", unavailable: "無法連線", invalid: "位址無效", notfound: "不支援 Working Memory", empty: "沒有傳回內容", run: "測試" },
    ja: { testing: "接続を確認しています…", connected: "接続できました", failed: "接続に失敗しました", back: "設定に戻る", noReturn: "戻る設定ページがありません。", noService: "ローカルのテストサービスが応答しません。", unauthorized: "キーが拒否されました", unbound: "Space が見つかりません", unavailable: "接続できません", invalid: "アドレスが無効です", notfound: "Working Memory 非対応", empty: "応答がありません", run: "テスト" },
    de: { testing: "Verbindung wird geprüft…", connected: "Verbunden", failed: "Verbindung fehlgeschlagen", back: "Zurück zu den Einstellungen", noReturn: "Keine Einstellungsseite zum Zurückkehren.", noService: "Der lokale Testdienst antwortet nicht.", unauthorized: "Schlüssel abgelehnt", unbound: "Space nicht gefunden", unavailable: "nicht erreichbar", invalid: "ungültige Adresse", notfound: "Working Memory nicht unterstützt", empty: "keine Antwort", run: "Test" },
};

export function textsFor(lang) {
    return texts[lang] ?? texts.en;
}

// testConnection makes the two requests the page promises: reachability
// through the public health route, then the key and Space through Working
// Memory. It reports fixed codes, never Mem's own text.
export async function testConnection(raw = {}, fetcher = fetch, timeoutMs = 5000) {
    const started = Date.now();
    try {
        const o = resolveOptions({ ...raw, recall: true, capture: false });
        const health = await request(o, { method: "GET", route: "health", timeoutMs, fetch: fetcher });
        const route = `agent/working-memory${o.spaceId ? `?space_id=${encodeURIComponent(o.spaceId)}` : ""}`;
        await request(o, { method: "GET", route, timeoutMs, fetch: fetcher });
        return {
            ok: true,
            ms: Date.now() - started,
            version: typeof health.body?.version === "string" ? health.body.version : undefined,
        };
    }
    catch (error) {
        return {
            ok: false,
            code: error instanceof MemFailure ? error.code : "unavailable",
            ms: Date.now() - started,
        };
    }
}
