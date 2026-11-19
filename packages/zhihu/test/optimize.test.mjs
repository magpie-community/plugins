// 优化项的测试：截断/清理、since-until、缓存、重试、日志、额度参数。
//   node --test test/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZhihuTools } from "../index.mjs";
import { _internal } from "../src/internal.mjs";

delete process.env.ZHIHU_ACCESS_SECRET;

const ctx = () => ({ abort: new AbortController().signal });
const tempDir = () => mkdtemp(join(tmpdir(), "zhihu-agent-search-opt-"));

const BASE_ITEM = {
  Title: "标题",
  ContentType: "answer",
  ContentID: "1",
  ContentText: "短正文",
  Url: "https://www.zhihu.com/question/1/answer/1",
  CommentCount: 1,
  VoteUpCount: 2,
  AuthorName: "作者",
  EditTime: 1767225600,
  CreateTime: 1767139200,
  CommentInfoList: [{ Content: "一" }, { Content: "二" }, { Content: "三" }],
};

const LONG = "很".repeat(600);
const EMOJI = "😀".repeat(600);

function itemFor(query) {
  if (query === "entities") {
    return {
      ...BASE_ITEM,
      ContentText: "<em>知乎</em> A &amp; B &lt;tag&gt;",
      Url: "https://www.zhihu.com/question/1/answer/1?utm_source=wechat&utm_medium=social&order=vote",
    };
  }
  if (query === "long") return { ...BASE_ITEM, ContentText: LONG };
  if (query === "emoji") return { ...BASE_ITEM, ContentText: EMOJI };
  return BASE_ITEM;
}

// 模拟知乎：flaky 第一次 500，risk 第一次 30003，busy 一直 30001，slow 延迟返回。
async function mock() {
  const calls = [];
  const state = { flaky: 0, risk: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const query = url.searchParams.get("Query");
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });

    const finish = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (query === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
    if (query === "flaky") {
      state.flaky += 1;
      if (state.flaky === 1) return finish(500, { Code: 90001, Message: "boom" });
    }
    if (query === "risk") {
      state.risk += 1;
      if (state.risk === 1) return finish(200, { Code: 30003, Message: "风控", Data: null });
    }
    if (query === "busy") return finish(200, { Code: 30001, Message: "额度超限", Data: null });

    if (url.pathname === "/api/v1/content/zhihu_search") {
      return finish(200, {
        Code: 0,
        Message: "success",
        Data: { HasMore: false, Items: [itemFor(query)] },
      });
    }
    if (url.pathname === "/api/v1/content/global_search") {
      return finish(200, {
        Code: 0,
        Message: "success",
        Data: { HasMore: false, Items: [itemFor(query)] },
      });
    }
    if (url.pathname === "/api/v1/content/hot_list") {
      return finish(200, {
        Code: 0,
        Message: "success",
        Data: { Total: 1, Items: [{ Title: "热", Url: "https://www.zhihu.com/hot/1" }] },
      });
    }
    if (url.pathname === "/api/v1/quota") {
      return finish(200, { Code: 0, Message: "success", Data: [] });
    }
    return finish(200, { Code: 10001, Message: "unknown path", Data: null });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function plugin(server, extra = {}) {
  return ZhihuTools(
    { directory: await tempDir(), ...(extra.input ?? {}) },
    { baseUrl: server.baseUrl, accessSecret: "test-secret", ...extra.options },
  );
}

test("正文默认截断到 500 字符，maxTextLength=0 取全文", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const short = await hooks.tool.search.execute({ query: "long" }, ctx());
    assert.equal(short.items[0].contentText, `${"很".repeat(500)}…`);

    const full = await hooks.tool.search.execute({ query: "long", maxTextLength: 0 }, ctx());
    assert.equal(full.items[0].contentText, LONG);

    const custom = await hooks.tool.global_search.execute(
      { query: "long", maxTextLength: 10 },
      ctx(),
    );
    assert.equal(custom.items[0].contentText, `${"很".repeat(10)}…`);
  } finally {
    await server.close();
  }
});

test("截断按码点计算，不会切坏 emoji", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.search.execute({ query: "emoji" }, ctx());
    assert.equal(out.items[0].contentText, `${"😀".repeat(500)}…`);
  } finally {
    await server.close();
  }
});

test("清理正文标签与实体、去掉 URL 的 utm_* 参数、评论最多保留两条", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.search.execute({ query: "entities" }, ctx());
    const item = out.items[0];
    assert.equal(item.contentText, "知乎 A & B <tag>");
    assert.equal(item.url, "https://www.zhihu.com/question/1/answer/1?order=vote");
    assert.deepEqual(item.commentInfo, ["一", "二"]);
  } finally {
    await server.close();
  }
});

test("全局搜索也应用同样的正文截断与清理", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.global_search.execute({ query: "entities" }, ctx());
    assert.equal(out.items[0].contentText, "知乎 A & B <tag>");
  } finally {
    await server.close();
  }
});

test("since/until 转成 Unix 秒，并校验与 sortField / min / max 的组合", async () => {
  const { sortBy } = _internal;
  assert.equal(
    sortBy({ sortField: "CreateTime", since: "2026-01-01", until: "2026-02-01" }),
    "CreateTime:desc:(1767225600,1769904000)",
  );
  assert.equal(
    sortBy({ sortField: "EditTime", sortOrder: "none", since: "2026-01-01T00:00:00Z" }),
    "EditTime:none:(1767225600,)",
  );
  assert.throws(() => sortBy({ sortField: "VoteUpCount", since: "2026-01-01" }), /EditTime 或 CreateTime/);
  assert.throws(() => sortBy({ since: "2026-01-01" }), /sortField/);
  assert.throws(() => sortBy({ sortField: "CreateTime", since: "2026-01-01", min: 1 }), /不能同时使用/);
  assert.throws(() => sortBy({ sortField: "CreateTime", since: "去年" }), /可解析的时间/);
  assert.throws(
    () => sortBy({ sortField: "CreateTime", since: "2026-02-01", until: "2026-01-01" }),
    /since 不能晚于 until/,
  );
});

test("search 工具把 since 写进 SortBy 参数", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await hooks.tool.search.execute(
      { query: "知乎", sortField: "CreateTime", since: "2026-01-01" },
      ctx(),
    );
    assert.equal(server.calls[0].params.SortBy, "CreateTime:desc:(1767225600,)");
  } finally {
    await server.close();
  }
});

test("缓存：相同请求只打一次上游，参数不同则分开缓存", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await hooks.tool.search.execute({ query: "知乎" }, ctx());
    await hooks.tool.search.execute({ query: "知乎" }, ctx());
    assert.equal(server.calls.length, 1);

    await hooks.tool.search.execute({ query: "知乎", count: 3 }, ctx());
    assert.equal(server.calls.length, 2);

    await hooks.tool.hot_list.execute({}, ctx());
    await hooks.tool.hot_list.execute({}, ctx());
    assert.equal(server.calls.length, 3);
  } finally {
    await server.close();
  }
});

test("缓存：cache=false 或 cacheTTL=0 时每次都请求", async () => {
  const server = await mock();
  try {
    const off = await plugin(server, { options: { cache: false } });
    await off.tool.hot_list.execute({}, ctx());
    await off.tool.hot_list.execute({}, ctx());
    assert.equal(server.calls.length, 2);

    const zero = await plugin(server, { options: { cacheTTL: 0 } });
    await zero.tool.hot_list.execute({}, ctx());
    await zero.tool.hot_list.execute({}, ctx());
    assert.equal(server.calls.length, 4);
  } finally {
    await server.close();
  }
});

test("缓存：并发的相同请求只打一次上游", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const [a, b] = await Promise.all([
      hooks.tool.search.execute({ query: "slow" }, ctx()),
      hooks.tool.search.execute({ query: "slow" }, ctx()),
    ]);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(a, b);
  } finally {
    await server.close();
  }
});

test("缓存键区分账号，不保存明文密钥", () => {
  const { cacheKey } = _internal;
  const one = cacheKey("secret-a", "/content/hot_list", { Limit: 30 });
  const two = cacheKey("secret-b", "/content/hot_list", { Limit: 30 });
  assert.notEqual(one, two);
  assert.equal(one, cacheKey("secret-a", "/content/hot_list", { Limit: 30 }));
  assert.ok(!one.includes("secret-a"));
  // 参数顺序不影响键。
  assert.equal(
    cacheKey("s", "/x", { A: 1, B: 2 }),
    cacheKey("s", "/x", { B: 2, A: 1 }),
  );
});

test("重试：网络/5xx/30003 会重试一次，额度类错误不重试", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server, { options: { cache: false } });

    const flaky = await hooks.tool.search.execute({ query: "flaky" }, ctx());
    assert.equal(flaky.items[0].title, "标题");
    assert.equal(server.calls.filter((c) => c.params.Query === "flaky").length, 2);

    const risk = await hooks.tool.search.execute({ query: "risk" }, ctx());
    assert.equal(risk.items[0].title, "标题");
    assert.equal(server.calls.filter((c) => c.params.Query === "risk").length, 2);

    await assert.rejects(
      () => hooks.tool.search.execute({ query: "busy" }, ctx()),
      (error) => {
        assert.equal(error.code, 30001);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(server.calls.filter((c) => c.params.Query === "busy").length, 1);
  } finally {
    await server.close();
  }
});

test("额度接口接受文档之外的 apiId，不再写死枚举", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await hooks.tool.quota.execute({ apiIds: ["zhihu_search", "brand_new_api"] }, ctx());
    assert.equal(server.calls[0].params.APIIDs, "zhihu_search,brand_new_api");
  } finally {
    await server.close();
  }
});

test("debug=true 时把耗时写进 magpie 日志，且不含密钥和搜索词", async () => {
  const server = await mock();
  try {
    const logs = [];
    const hooks = await plugin(server, {
      input: {
        client: {
          app: {
            log: async ({ body }) => {
              logs.push(body);
            },
          },
        },
      },
      options: { debug: true },
    });
    await hooks.tool.hot_list.execute({}, ctx());
    assert.ok(logs.length > 0);
    assert.equal(logs[0].service, "tools-zhihu");
    assert.match(logs[0].message, /hot_list/);
    for (const entry of logs) {
      assert.ok(!entry.message.includes("test-secret"));
    }
  } finally {
    await server.close();
  }
});

test("未知参数、非法选项都会被拒绝", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await assert.rejects(
      () => hooks.tool.search.execute({ query: "x", fullText: true }, ctx()),
      /未知参数/,
    );
    await assert.rejects(
      () => hooks.tool.search.execute({ query: "x", maxTextLength: -1 }, ctx()),
      /不能小于 0/,
    );
    const dir = await tempDir();
    await assert.rejects(
      () => ZhihuTools({ directory: dir }, { maxTextLength: -1 }),
      /0 到 20000/,
    );
    await assert.rejects(
      () => ZhihuTools({ directory: dir }, { cacheTTL: -1 }),
      /cacheTTL/,
    );
    await assert.rejects(
      () => ZhihuTools({ directory: dir }, { accessSecret: 1 }),
      /accessSecret/,
    );
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});