// 1.3: auto titles of a message sent with "添加到对话" quotes use the user's own words.
import { describe, it, expect } from "vitest";
import { titleText } from "../../daemon/src/agents/manager.js";

describe("titleText (1.3 quotes)", () => {
  it("auto titles skip the leading quote blocks", () => {
    expect(titleText("> [src/a.ts]\n> const x = 1;\n\n>  second\n\n这句什么意思？")).toBe("这句什么意思？");
    expect(titleText("帮我  启动\n一下")).toBe("帮我 启动 一下");
    expect(titleText("> only a quote")).toBe("only a quote");
  });
});
