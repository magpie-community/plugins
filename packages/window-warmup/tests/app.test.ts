// 页面纯函数的测试：不碰 DOM、不发请求。
// statusOf / trigText / 下拉选项构造 / 执行记录文案等由 web/app.ts 导出，界面渲染直接复用。
import { expect, test } from "bun:test";
import {
  accountHasWindows,
  accountModelView,
  accountOptions,
  contentOf,
  deleteArmed,
  DELETE_CONFIRM_MS,
  effortLabel,
  forceWindowAccount,
  modelDisplay,
  modelHint,
  modelOptions,
  nextLabel,
  nextPointsAfter,
  rowSub,
  runOutcome,
  runReason,
  runTimeLabel,
  shortModel,
  statusOf,
  shouldCloseOnScroll,
  sumView,
  syncDraftOnPoll,
  trigText,
  validateDraft,
  windowOptions,
} from "../web/app";
import type { CatalogAccount, CatalogProvider, Run, Task, Trigger } from "../src/types";

const T0 = new Date("2026-10-31T12:00:00+08:00"); // 周六 12:00，本地（nextLabel 看本地时间）

/** 假想的 key 指纹（10 位小写 hex），页面的 key 账号 id 都长这样 */
const FP1 = "1a2b3c4d5e";
const FP2 = "f0e1d2c3b4";

const p2 = (n: number): string => String(n).padStart(2, "0");

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    name: "早报",
    enabled: true,
    provider: "openai",
    account: "",
    model: "",
    message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
    createdAt: "2026-10-30T08:00:00+08:00",
    updatedAt: "2026-10-30T08:00:00+08:00",
    ...over,
  };
}

function mkRun(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    taskId: "t1",
    source: "schedule",
    due: null,
    startedAt: "2026-10-31T06:00:00+08:00",
    endedAt: "2026-10-31T06:00:01+08:00",
    outcome: "ok",
    reason: "",
    effort: null,
    model: null,
    ms: 900,
    resetKey: null,
    ...over,
  };
}

function mkProvider(over: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: "remote-magpie",
    accounts: [],
    models: [],
    autoAccountModels: null,
    autoModel: null,
    ...over,
  };
}

function mkAccount(over: Partial<CatalogAccount> = {}): CatalogAccount {
  return {
    id: "a1",
    label: "a1",
    kind: "login",
    windows: [],
    models: null,
    perAccount: false,
    autoModel: null,
    ...over,
  };
}

test("statusOf：正常不显示文字 / 上次失败 / 上次结果未知 / 发送中 / 已停用", () => {
  expect(statusOf(mkTask(), [])).toEqual({ tone: "", text: "" });
  expect(statusOf(mkTask(), [mkRun({ outcome: "ok" })])).toEqual({ tone: "", text: "" });
  expect(statusOf(mkTask(), [mkRun({ outcome: "failed", reason: "HTTP 429" })])).toEqual({
    tone: "bad",
    text: "上次失败",
  });
  expect(statusOf(mkTask(), [mkRun({ outcome: "unknown", reason: "30 秒内没有结果" })])).toEqual({
    tone: "unk",
    text: "上次结果未知",
  });
  expect(statusOf(mkTask(), [mkRun({ outcome: "running", endedAt: null })])).toEqual({
    tone: "ok",
    text: "发送中",
  });
  expect(statusOf(mkTask({ enabled: false }), [mkRun()])).toEqual({ tone: "", text: "已停用" });
  // 只看该任务自己的记录
  expect(statusOf(mkTask(), [mkRun({ taskId: "other", outcome: "failed" })])).toEqual({
    tone: "",
    text: "",
  });
  // 记录按时间取最新：旧失败被新成功盖过
  expect(
    statusOf(mkTask(), [
      mkRun({ id: "r0", startedAt: "2026-10-31T05:00:00+08:00", outcome: "failed" }),
      mkRun({ outcome: "ok", startedAt: "2026-10-31T06:00:00+08:00" }),
    ]),
  ).toEqual({ tone: "", text: "" });
});

test("失败不暂停：状态是上次失败，下次时间仍在", () => {
  const task = mkTask();
  const status = statusOf(task, [mkRun({ outcome: "failed", reason: "连不上 Magpie" })]);
  expect(status).toEqual({ tone: "bad", text: "上次失败" });
  expect(nextLabel("2026-11-01T06:00:00+08:00", T0)).not.toBe("—");
  expect(nextLabel(null, T0)).toBe("—");
});

test("trigText：窗口 / 每天 / 固定间隔", () => {
  expect(trigText({ kind: "window", window: "5h" })).toBe("窗口 5h 重置后");
  expect(trigText({ kind: "daily", time: "06:00", timeZone: "UTC" })).toBe("每天 06:00");
  expect(trigText({ kind: "every", hours: 6, anchor: "2026-10-30T00:00:00Z" })).toBe("每 6 小时");
});

test("shortModel / modelDisplay：取末段、剥供应商前缀", () => {
  expect(shortModel("remote-magpie/group/glm-5.3-flash")).toBe("glm-5.3-flash");
  expect(shortModel("gpt-5.2")).toBe("gpt-5.2");
  expect(modelDisplay("openai/gpt-5.2", "openai")).toBe("gpt-5.2");
  expect(modelDisplay("deepseek/deepseek-v4", "openai")).toBe("deepseek/deepseek-v4");
  expect(modelDisplay("gpt-5.2", "openai")).toBe("gpt-5.2");
});

test("rowSub：账号显示目录里的 label，找不到（旧值/目录暂缺）用原值", () => {
  const providers = [
    mkProvider({ id: "openai", accounts: [mkAccount({ id: FP1, label: "主 Key", kind: "key" })] }),
  ];
  expect(rowSub(mkTask({ provider: "openai", account: FP1, model: "openai/gpt-5.2-chat" }), providers)).toBe(
    "每天 06:00 · 主 Key · gpt-5.2-chat",
  );
  // 旧任务存的 key 名不在目录：原样显示，不改写
  expect(rowSub(mkTask({ provider: "openai", account: "sk-legacy" }), providers)).toBe(
    "每天 06:00 · sk-legacy · 自动选模型",
  );
  expect(rowSub(mkTask({ provider: "openai", account: "" }), providers)).toBe(
    "每天 06:00 · 自动选账号 · 自动选模型",
  );
  expect(rowSub(mkTask({ trigger: { kind: "window", window: "week" } }), providers)).toBe(
    "窗口 week 重置后 · 自动选账号 · 自动选模型",
  );
  // 目录整体暂缺：退回原值
  expect(rowSub(mkTask({ account: FP1 }), [])).toBe(`每天 06:00 · ${FP1} · 自动选模型`);
});

test("runOutcome：成功灰、失败红、未知琥珀、发送中灰", () => {
  expect(runOutcome("ok")).toEqual({ text: "成功", tone: "" });
  expect(runOutcome("failed")).toEqual({ text: "失败", tone: "bad" });
  expect(runOutcome("unknown")).toEqual({ text: "未知", tone: "unk" });
  expect(runOutcome("running")).toEqual({ text: "发送中", tone: "" });
});

test("runReason：成功拼模型/思考/耗时/来源，失败直接用原因", () => {
  expect(
    runReason(
      mkRun({
        outcome: "ok",
        model: "remote-magpie/group/glm-5.3-flash",
        effort: "low",
        ms: 1200,
        source: "schedule",
      }),
    ),
  ).toBe("已发送 · glm-5.3-flash · 思考 low · 1.2 秒 · 按计划");
  // 旧记录没有 model/effort/ms 时不留空段
  expect(runReason(mkRun({ outcome: "ok", source: "manual", ms: null }))).toBe("已发送 · 手动");
  expect(runReason(mkRun({ outcome: "ok", source: "catchup", ms: null, effort: null, model: null }))).toBe(
    "已发送 · 补发",
  );
  expect(runReason(mkRun({ outcome: "failed", reason: "HTTP 429：额度已用完" }))).toBe(
    "HTTP 429：额度已用完",
  );
  expect(runReason(mkRun({ outcome: "unknown", reason: "30 秒内没有结果" }))).toBe(
    "30 秒内没有结果",
  );
});

test("runTimeLabel：今天 / 昨天 / 更早给 M/D", () => {
  const today = new Date("2026-10-31T13:36:00Z");
  expect(runTimeLabel("2026-10-31T13:36:00Z", T0)).toMatch(/^今天 \d{2}:\d{2}$/);
  expect(runTimeLabel("2026-10-30T13:36:00Z", T0)).toMatch(/^昨天 \d{2}:\d{2}$/);
  const older = new Date("2026-10-28T13:36:00Z");
  expect(runTimeLabel("2026-10-28T13:36:00Z", T0)).toBe(
    `${older.getMonth() + 1}/${older.getDate()} ${p2(older.getHours())}:${p2(older.getMinutes())}`,
  );
  expect(runTimeLabel("不是时间", T0)).toBe("—");
});

test("nextLabel：今天 HH:MM / 明天 / M/D（取 UTC 与 +08 同日期的时刻，断言与测试机时区无关）", () => {
  expect(nextLabel("2026-10-31T06:00:00Z", T0)).toMatch(/^\d{2}:\d{2}$/);
  expect(nextLabel("2026-11-01T06:00:00Z", T0)).toMatch(/^明天 \d{2}:\d{2}$/);
  expect(nextLabel("2026-11-05T06:00:00Z", T0)).toMatch(/^11\/5 \d{2}:\d{2}$/);
});

test("accountOptions：账号必选（无自动项）；key 账号 label + 指纹附注；旧账号保留并标注", () => {
  const providers = [
    mkProvider({
      id: "remote-magpie",
      accounts: [
        mkAccount({ id: "acct-team", label: "acct-team" }),
        mkAccount({ id: FP1, label: "主 Key", kind: "key" }),
        mkAccount({ id: FP2, label: FP2, kind: "key" }), // 没起名的 key：label 就是指纹
      ],
    }),
  ];
  const opts = accountOptions("remote-magpie", "", providers);
  // 账号必选：空账号只给「请选择账号」占位，不再有自动项
  expect(opts[0]).toEqual({ value: "", text: "请选择账号" });
  expect(opts[1]).toEqual({ value: "acct-team", text: "acct-team" });
  expect(opts[2]).toEqual({ value: FP1, text: "主 Key", aux: FP1 });
  expect(opts[3]).toEqual({ value: FP2, text: FP2 });
  expect(opts.some((o) => o.text.includes("自动"))).toBe(false);

  // 旧任务里的账号（key 名或已删除的账号）不在目录：保留原值不自动改写，标注「不在当前账号列表」
  const stale = accountOptions("remote-magpie", "sk-legacy", providers);
  expect(stale[0]).toEqual({ value: "sk-legacy", text: "sk-legacy（不在当前账号列表）" });
});

test("accountModelView：指定账号用其列表；自动与目录暂缺的账号退回供应商全集", () => {
  const provider = mkProvider({
    id: "p",
    accounts: [
      mkAccount({ id: FP1, label: "主 Key", kind: "key", models: ["p/a"], autoModel: "p/a", perAccount: true }),
      mkAccount({ id: "acct-z", label: "acct-z", models: null, perAccount: false, autoModel: null }),
    ],
    autoAccountModels: ["p/a", "p/b"],
    autoModel: "p/b",
  });
  expect(accountModelView(provider, FP1)).toEqual({ models: ["p/a"], autoModel: "p/a", perAccount: true });
  expect(accountModelView(provider, "acct-z")).toEqual({ models: null, autoModel: null, perAccount: false });
  expect(accountModelView(provider, "")).toEqual({ models: ["p/a", "p/b"], autoModel: "p/b", perAccount: null });
  // 目录暂缺的账号（旧任务存的名字）：退回全集不禁用，此时无从判断是否按账号区分
  expect(accountModelView(provider, "sk-legacy")).toEqual({ models: ["p/a", "p/b"], autoModel: "p/b", perAccount: null });
  expect(accountModelView(undefined, "")).toEqual({ models: null, autoModel: null, perAccount: null });
});

test("modelOptions：首项自动附注当前账号的自动模型；列表来自所选账号；旧值保留", () => {
  const providers = [
    mkProvider({
      id: "remote-magpie",
      accounts: [
        mkAccount({
          id: FP1,
          label: "主 Key",
          kind: "key",
          models: ["remote-magpie/glm-4.7"],
          autoModel: "remote-magpie/glm-4.7",
          perAccount: true,
        }),
        mkAccount({ id: "acct-z", label: "acct-z", models: null, perAccount: false, autoModel: null }),
      ],
      autoAccountModels: [
        "remote-magpie/glm-4.7",
        "remote-magpie/glm-5.3",
        "remote-magpie/glm-5.3-flash",
      ],
      autoModel: "remote-magpie/glm-5.3-flash",
    }),
  ];
  const byAccount = modelOptions("remote-magpie", FP1, "", providers);
  expect(byAccount[0]).toEqual({ value: "", text: "自动", aux: "glm-4.7" });
  expect(byAccount.slice(1).map((o) => o.text)).toEqual(["glm-4.7"]);

  // 自动账号用供应商全集，附注是供应商级的自动模型
  const autoAcct = modelOptions("remote-magpie", "", "", providers);
  expect(autoAcct[0].aux).toBe("glm-5.3-flash");
  expect(autoAcct.slice(1).map((o) => o.value)).toEqual([
    "remote-magpie/glm-4.7",
    "remote-magpie/glm-5.3",
    "remote-magpie/glm-5.3-flash",
  ]);

  // 已存模型不在当前账号列表：保留原值不自动改写（打开旧任务不重置，重置只发生在主动切换时）
  const stale = modelOptions("remote-magpie", FP1, "remote-magpie/gone", providers);
  expect(stale[1]).toEqual({ value: "remote-magpie/gone", text: "remote-magpie/gone" });

  // 列表为 null：只有自动 + 旧值，渲染层据此禁用下拉并显示提示 B
  const none = modelOptions("remote-magpie", "acct-z", "remote-magpie/gone", providers);
  expect(none).toEqual([
    { value: "", text: "自动" },
    { value: "remote-magpie/gone", text: "remote-magpie/gone" },
  ]);
});

test("windowOptions：账号的窗口带已用与重置附注；无账号 / 无窗口给占位", () => {
  const resetAt = new Date("2026-10-31T18:36:00+08:00");
  const providers = [
    mkProvider({
      id: "p",
      accounts: [
        mkAccount({
          id: "a1",
          label: "",
          windows: [
            { name: "5h", used: 62, resetsAt: "2026-10-31T18:36:00+08:00" },
            { name: "week", used: 30, resetsAt: null },
            { name: "long", used: null, resetsAt: null },
          ],
        }),
      ],
    }),
  ];
  const opts = windowOptions("p", "a1", "5h", providers);
  expect(opts[0]).toEqual({
    value: "5h",
    text: "5h",
    aux: `已用 62% · ${p2(resetAt.getHours())}:${p2(resetAt.getMinutes())} 重置`,
  });
  expect(opts[1].aux).toBe("已用 30% · 空闲");
  expect(opts[2].aux).toBe("空闲");
  expect(windowOptions("p", "", "", providers)).toEqual([{ value: "", text: "先选定账号" }]);
  expect(windowOptions("p", "a2", "", providers)).toEqual([{ value: "", text: "该账号没有窗口信息" }]);
});

test("forceWindowAccount：窗口触发缺账号时取该供应商第一个账号", () => {
  const providers = [
    mkProvider({ id: "p1", accounts: [mkAccount({ id: "a1", label: "" })] }),
    mkProvider({ id: "p2", accounts: [] }),
  ];
  expect(forceWindowAccount("p1", providers)).toBe("a1");
  expect(forceWindowAccount("p2", providers)).toBe("");
  expect(forceWindowAccount("nope", providers)).toBe("");
});

test("modelHint：固定模型只给思考；自动按所选账号给自动选中；没有可用模型给提示", () => {
  const provider = mkProvider({
    id: "p",
    accounts: [
      mkAccount({ id: "acct-a", label: "acct-a", models: ["p/small"], autoModel: "p/small" }),
    ],
    autoModel: "p/glm-5.3-flash",
    models: [
      { id: "p/glm-5.3-flash", effort: { send: null, label: "不适用" } },
      { id: "p/big", effort: { send: "low", label: "low（模型必须思考，已用最低档）" } },
    ],
  });
  const fixed = modelHint("p/big", provider, "acct-a");
  expect(fixed.main).toBe("思考：low（模型必须思考，已用最低档）");
  expect(fixed.sub).toBe("思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。");

  const auto = modelHint("", provider, "");
  expect(auto.main).toBe("自动选中 glm-5.3-flash · 思考：不适用");
  expect(auto.sub).toBe(
    "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。",
  );
  // 指定账号的自动模型与供应商级不同，按账号的来
  const byAccount = modelHint("", provider, "acct-a");
  expect(byAccount.main).toBe("自动选中 small · 思考：目录里暂时没有这个模型");

  const none = modelHint("", mkProvider({ id: "p2", autoModel: null }), "");
  expect(none.main).toBe("该供应商没有可用模型");
  // 指定了账号却选不出模型：归因到账号，不能写成整个供应商没有
  const emptyAccount = modelHint(
    "",
    mkProvider({
      id: "p3",
      accounts: [mkAccount({ id: "acct-b", label: "acct-b", models: [], autoModel: null })],
      autoModel: "p3/any",
    }),
    "acct-b",
  );
  expect(emptyAccount.main).toBe("这个账号没有可用模型");
  const missing = modelHint("p/gone", provider, "");
  expect(missing.main).toBe("思考：目录里暂时没有这个模型");
});

test("effortLabel：三种结论 + 出错提示", () => {
  expect(effortLabel({ send: null, label: "不适用" })).toBe("思考：不适用");
  expect(effortLabel({ send: "none", label: "关闭（模型支持关闭）" })).toBe(
    "思考：关闭（模型支持关闭）",
  );
  expect(effortLabel({ error: "模型的思考档位数据无法识别" })).toContain("无法识别");
});

test("sumView：启用数与最近一次执行点", () => {
  const tasks = [
    mkTask({ id: "a" }),
    mkTask({ id: "b", enabled: false }),
    mkTask({ id: "c", trigger: { kind: "daily", time: "23:00", timeZone: "UTC" } }),
  ];
  const next = { a: "2026-11-01T06:00:00+08:00", b: "2026-10-31T13:00:00+08:00", c: "2026-10-31T12:30:00+08:00" };
  const view = sumView(tasks, next);
  expect(view.enabled).toBe(2);
  expect(view.next).toEqual({ at: "2026-10-31T12:30:00+08:00", name: "早报" });
  expect(sumView([], {}).next).toBeNull();
  expect(sumView([mkTask({ enabled: false })], {}).next).toBeNull();
});

test("nextPointsAfter：daily 沿时区推算；every 沿锚点；窗口不外推", () => {
  const daily: Trigger = { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" };
  expect(nextPointsAfter(daily, T0, 3).map((d) => d.toISOString())).toEqual([
    "2026-10-31T22:00:00.000Z",
    "2026-11-01T22:00:00.000Z",
    "2026-11-02T22:00:00.000Z",
  ]);
  const every: Trigger = { kind: "every", hours: 5, anchor: "2026-10-30T08:00:00Z" };
  expect(nextPointsAfter(every, T0, 2).map((d) => d.toISOString())).toEqual([
    "2026-10-31T09:00:00.000Z",
    "2026-10-31T14:00:00.000Z",
  ]);
  expect(nextPointsAfter({ kind: "window", window: "5h" }, T0, 3)).toEqual([]);
});

test("deleteArmed：3 秒内处于确认态，未进入确认（0）永远不算", () => {
  expect(deleteArmed(1000, 2000)).toBe(true);
  expect(deleteArmed(1000, 1000 + DELETE_CONFIRM_MS)).toBe(true);
  expect(deleteArmed(1000, 1000 + DELETE_CONFIRM_MS + 1)).toBe(false);
  expect(deleteArmed(0, 1000)).toBe(false);
});

test("shouldCloseOnScroll：菜单内滚动不关（长列表可滚），菜单外滚动关，无菜单不关", () => {
  const pop = { contains: (x: unknown) => x === "menu-inner" };
  expect(shouldCloseOnScroll("menu-inner", pop)).toBe(false);
  expect(shouldCloseOnScroll(pop, pop)).toBe(false); // 菜单本体就是滚动元素
  expect(shouldCloseOnScroll("page-body", pop)).toBe(true);
  expect(shouldCloseOnScroll(null, pop)).toBe(true); // 读不到目标（如 window 滚动）按外关
  expect(shouldCloseOnScroll("page-body", null)).toBe(false); // 没开菜单就无所谓
});

test("syncDraftOnPoll：未保存编辑优先；外部更新提示；任务删除收起", () => {
  const saved = mkTask({ updatedAt: "2026-10-31T08:00:00+08:00" });
  expect(syncDraftOnPoll(null, "x", true)).toBe("gone");
  expect(syncDraftOnPoll(saved, "2026-10-31T08:00:00+08:00", false)).toBe("adopt");
  expect(syncDraftOnPoll(saved, "2026-10-31T08:00:00+08:00", true)).toBe("keep");
  expect(syncDraftOnPoll(saved, "2026-10-30T08:00:00+08:00", true)).toBe("stale");
});

test("contentOf：保存内容只含六个字段，不再带 message（探活消息固定 hi，由服务端填）", () => {
  const keys = Object.keys(contentOf(mkTask({ message: "hi" }))).sort();
  expect(keys).toEqual(["account", "enabled", "model", "name", "provider", "trigger"]);
});

test("validateDraft：名称 / 供应商 / 窗口账号与窗口名必填", () => {
  expect(validateDraft(mkTask({ name: "  " }))).toEqual({ error: "给任务起个名字", field: "name" });
  expect(validateDraft(mkTask({ provider: " " }))).toEqual({
    error: "必须选择供应商",
    field: "provider",
  });
  // 账号必选，不分触发方式
  expect(validateDraft(mkTask({ account: "" }))).toEqual({ error: "必须选择账号", field: "account" });
  expect(
    validateDraft(mkTask({ trigger: { kind: "window", window: "5h" }, account: "" })),
  ).toEqual({ error: "必须选择账号", field: "account" });
  expect(
    validateDraft(mkTask({ trigger: { kind: "window", window: "" }, account: "a" })),
  ).toEqual({ error: "必须填写额度窗口名", field: "window" });
  expect(
    validateDraft(mkTask({ account: "a", trigger: { kind: "daily", time: "", timeZone: "UTC" } })),
  ).toEqual({
    error: "时间需为 24 小时制的 HH:MM",
    field: "time",
  });
  expect(validateDraft(mkTask({ account: "a" }))).toBeNull();
});

test("accountHasWindows：没账号、不在目录、没有窗口都算没有——此时不提供「窗口重置后」", () => {
  const provider = mkProvider({
    id: "p",
    accounts: [
      mkAccount({ id: "with-win", windows: [{ name: "5h", used: 10, resetsAt: T0.toISOString() }] }),
      mkAccount({ id: "no-win", windows: [] }),
    ],
  });
  expect(accountHasWindows("p", "with-win", [provider])).toBe(true);
  expect(accountHasWindows("p", "no-win", [provider])).toBe(false);
  // 空账号（自动）永远不能跟窗口
  expect(accountHasWindows("p", "", [provider])).toBe(false);
  // 旧任务里存着、目录里已经没有的账号
  expect(accountHasWindows("p", "gone", [provider])).toBe(false);
  expect(accountHasWindows("nope", "with-win", [provider])).toBe(false);
});
