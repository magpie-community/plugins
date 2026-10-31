import { describe, expect, it } from "vitest";
import { initLocale, normalizeLang, t } from "../../web/src/i18n/index.js";

describe("i18n", () => {
  it("normalizeLang: zh variants → zh, anything else → en", () => {
    expect(normalizeLang("zh")).toBe("zh");
    expect(normalizeLang("zh-CN")).toBe("zh");
    expect(normalizeLang("en")).toBe("en");
    expect(normalizeLang("ja")).toBe("en");
  });

  it("UI text is English with ?lang=en", () => {
    initLocale("?lang=en");
    expect(t("sidebar.newProject")).toBe("New project");
    expect(t("app.title")).toBe("Agent Console");
    initLocale("?lang=zh");
    expect(t("sidebar.newProject")).toBe("新建项目");
    expect(t("app.title")).toBe("Agent 控制台");
  });
});
