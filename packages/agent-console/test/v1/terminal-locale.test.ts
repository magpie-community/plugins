import { describe, expect, it } from "vitest";
import { withUtf8Locale } from "../../daemon/src/terminal/service.js";

describe("withUtf8Locale", () => {
  it("sets LC_CTYPE=UTF-8 on darwin when the locale is unset", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/a" };
    const out = withUtf8Locale(env, "darwin");
    expect(out.LC_CTYPE).toBe("UTF-8");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/Users/a");
    expect(env.LC_CTYPE).toBeUndefined();
  });

  it("sets LC_CTYPE=C.UTF-8 on linux when the locale is unset", () => {
    const env = { PATH: "/usr/bin" };
    expect(withUtf8Locale(env, "linux").LC_CTYPE).toBe("C.UTF-8");
    expect(withUtf8Locale(env, "freebsd").LC_CTYPE).toBe("C.UTF-8");
  });

  it("treats an empty string as unset", () => {
    const env: NodeJS.ProcessEnv = { LANG: "", LC_CTYPE: "", LC_ALL: "", TERM: "xterm-256color" };
    expect(withUtf8Locale(env, "darwin")).toMatchObject({ LC_CTYPE: "UTF-8", TERM: "xterm-256color" });
    expect(withUtf8Locale(env, "linux").LC_CTYPE).toBe("C.UTF-8");
    expect(env).toEqual({ LANG: "", LC_CTYPE: "", LC_ALL: "", TERM: "xterm-256color" });
  });

  it("preserves an explicit LANG, LC_CTYPE, or LC_ALL", () => {
    expect(withUtf8Locale({ LANG: "zh_CN.UTF-8" }, "darwin")).toEqual({ LANG: "zh_CN.UTF-8" });
    expect(withUtf8Locale({ LANG: "C" }, "linux")).toEqual({ LANG: "C" });
    expect(withUtf8Locale({ LC_CTYPE: "en_US.UTF-8", PATH: "/bin" }, "linux")).toEqual({
      LC_CTYPE: "en_US.UTF-8",
      PATH: "/bin",
    });
    expect(withUtf8Locale({ LC_ALL: "zh_TW.UTF-8", LANG: "" }, "darwin")).toEqual({
      LC_ALL: "zh_TW.UTF-8",
      LANG: "",
    });
  });

  it("leaves win32 untouched", () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows", LANG: "", SystemRoot: "C:\\Windows" };
    expect(withUtf8Locale(env, "win32")).toEqual(env);
    expect(withUtf8Locale({}, "win32")).toEqual({});
    expect(withUtf8Locale({ LC_CTYPE: "zh-CN" }, "win32")).toEqual({ LC_CTYPE: "zh-CN" });
  });

  it("does not mutate the input env object", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", LANG: "" };
    const snapshot = { ...env };
    const out = withUtf8Locale(env, "darwin");
    expect(out).not.toBe(env);
    expect(env).toEqual(snapshot);
    out.LC_CTYPE = "mutated";
    out.PATH = "/changed";
    expect(env).toEqual(snapshot);
  });
});
