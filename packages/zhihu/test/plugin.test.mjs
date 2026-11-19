// 用本地模拟的知乎接口跑测试，不需要真实的 Access Secret。
//   node --test test/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZhihuTools } from "../index.mjs";
import { _internal } from "../src/internal.mjs";

delete process.env.ZHIHU_ACCESS_SECRET;

const ctx = () => ({ abort: new AbortController().signal });

const SEARCH_ITEM = {
  Title: "如何学习 Go 语言",
  Headline: "",
  ContentType: "answer",
  ContentID: "123",
  ContentText: "先说结论：<em>Go</em> 语言适合……",
  Url: "https://www.zhihu.com/question/1/answer/123",
  CommentCount: 7,
  VoteUpCount: 42,
  AuthorName: "张三",
  AuthorAvatar: "https://pic1.zhimg.com/avatar.jpg",
  AuthorBadge: "优秀回答者",
  AuthorBadgeText: "优秀回答者",
  EditTime: 1767225600,
  CreateTime: 1767139200,
  CommentInfoList: [{ Content: "很有帮助" }],
  AuthorityLevel: "high",
  RankingScore: 0.98,
};

function payloadFor(url) {
  const path = url.pathname;
  if (url.searchParams.get("Query") === "denied") {
    return { Code: 20001, Message: "Authorization failed", Data: null };
  }
  if (path === "/api/v1/content/zhihu_search") {
    return {
      Code: 0,
      Message: "success",
      Data: { HasMore: false, SearchHashId: "hash-1", Items: [SEARCH_ITEM] },
    };
  }
  if (path === "/api/v1/content/global_search") {
    return { Code: 0, Message: "success", Data: { HasMore: true, Items: [SEARCH_ITEM] } };
  }
  if (path === "/api/v1/content/hot_list") {
    return {
      Code: 0,
      Message: "success",
      Data: {
        Total: 1,
        Items: [{ Title: "热榜话题", Url: "https://www.zhihu.com/hot/1", ThumbnailUrl: "https://pic1.zhimg.com/t.jpg", Summary: "摘要" }],
      },
    };
  }
  if (path === "/api/v1/content/question_answers") {
    return {
      Code: 0,
      Message: "success",
      Data: {
        Items: [{ ContentType: "answer", ContentToken: "tok-1", Url: "https://www.zhihu.com/answer/1", Summary: "回答摘要" }],
        Paging: { IsEnd: false, NextOffset: 20, Totals: 100 },
      },
    };
  }
  if (path === "/api/v1/user/question_recommendations") {
    return { Code: 0, Message: "success", Data: { Items: [{ Title: "推荐问题", Url: "https://www.zhihu.com/question/2" }] } };
  }
  if (path === "/api/v1/quota") {
    return {
      Code: 0,
      Message: "success",
      Data: [{ APIID: "zhihu_search", APIName: "知乎搜索", TotalQuota: 300, TotalUsed: 12, RemainingQuota: 288 }],
    };
  }
  return { Code: 10001, Message: "unknown path", Data: null };
}

async function mock() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push({
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      headers: req.headers,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payloadFor(url)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const tempDir = () => mkdtemp(join(tmpdir(), "zhihu-agent-search-"));

async function plugin(server, options = {}) {
  const dir = options.directory ?? (await tempDir());
  // 显式传 secret: undefined 表示“不提供”，与不传该字段区分开。
  const secret = Object.hasOwn(options, "secret") ? options.secret : "test-secret";
  const pluginOptions = { baseUrl: server.baseUrl };
  if (secret !== undefined) pluginOptions.accessSecret = secret;
  return ZhihuTools({ directory: dir }, pluginOptions);
}

test("插件只导出插件函数与 _internal，并提供登录与工具", async () => {
  const hooks = await ZhihuTools({ directory: await tempDir() }, {});
  assert.deepEqual(hooks.auth.methods.map((m) => m.type), ["api"]);
  assert.equal(hooks.auth.provider, "zhihu");
  assert.equal(hooks.auth.single, true);
  assert.ok(hooks.search.zhihu);
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    "global_search",
    "hot_list",
    "question_answers",
    "question_recommendations",
    "quota",
    "search",
  ]);
  for (const entry of Object.values(hooks.tool)) {
    assert.equal(entry.args.type, "object");
    assert.equal(typeof entry.description, "string");
    assert.equal(typeof entry.execute, "function");
  }
  const config = {};
  await hooks.config(config);
  assert.deepEqual(config.provider.zhihu, { name: "知乎", models: {} });
  assert.equal(typeof _internal.sortBy, "function");
});

test("search：带上鉴权头、时间戳与 SortBy，并把结果整理成 camelCase", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.search.execute(
      { query: "  Go 语言 ", count: 5, sortField: "VoteUpCount", sortOrder: "desc", min: 10, max: 100 },
      ctx(),
    );
    const call = server.calls[0];
    assert.equal(call.path, "/api/v1/content/zhihu_search");
    assert.equal(call.params.Query, "Go 语言");
    assert.equal(call.params.Count, "5");
    assert.equal(call.params.SortBy, "VoteUpCount:desc:(10,100)");
    assert.equal(call.headers.authorization, "Bearer test-secret");
    assert.match(call.headers["user-agent"], /^tools-zhihu/);
    const skew = Math.abs(Number(call.headers["x-request-timestamp"]) - Math.floor(Date.now() / 1000));
    assert.ok(skew < 60, "时间戳应在 60 秒以内");

    assert.equal(out.hasMore, false);
    assert.equal(out.searchHashId, "hash-1");
    assert.equal(out.items.length, 1);
    const item = out.items[0];
    assert.equal(item.title, "如何学习 Go 语言");
    assert.equal(item.contentText, "先说结论：Go 语言适合……");
    assert.equal(item.contentId, "123");
    assert.equal(item.voteUpCount, 42);
    assert.equal(item.author.name, "张三");
    assert.equal(item.editTime, "2026-01-01T00:00:00.000Z");
    assert.equal(item.createTime, "2025-12-31T00:00:00.000Z");
    assert.deepEqual(item.commentInfo, ["很有帮助"]);
  } finally {
    await server.close();
  }
});

test("search：默认 Count 为 10，不设 SortBy 时省略该参数", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await hooks.tool.search.execute({ query: "知乎" }, ctx());
    assert.equal(server.calls[0].params.Count, "10");
    assert.equal(server.calls[0].params.SortBy, undefined);
  } finally {
    await server.close();
  }
});

test("global_search：透传 Filter 与 SearchDB", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.global_search.execute(
      { query: "固态电池", count: 20, filter: 'host=="example.com"', searchDB: "realtime" },
      ctx(),
    );
    const call = server.calls[0];
    assert.equal(call.path, "/api/v1/content/global_search");
    assert.equal(call.params.Count, "20");
    assert.equal(call.params.Filter, 'host=="example.com"');
    assert.equal(call.params.SearchDB, "realtime");
    assert.equal(out.hasMore, true);
    assert.equal(out.items[0].title, "如何学习 Go 语言");
  } finally {
    await server.close();
  }
});

test("hot_list：默认 Limit 为 30", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.hot_list.execute({}, ctx());
    assert.equal(server.calls[0].params.Limit, "30");
    assert.equal(out.total, 1);
    assert.equal(out.items[0].title, "热榜话题");
  } finally {
    await server.close();
  }
});

test("question_answers：透传 QuestionUrl / Offset / Limit 并整理分页", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const url = "https://www.zhihu.com/question/1";
    const out = await hooks.tool.question_answers.execute({ questionUrl: url, offset: 20, limit: 5 }, ctx());
    const call = server.calls[0];
    assert.equal(call.path, "/api/v1/content/question_answers");
    assert.equal(call.params.QuestionUrl, url);
    assert.equal(call.params.Offset, "20");
    assert.equal(call.params.Limit, "5");
    assert.deepEqual(out.paging, { isEnd: false, nextOffset: 20, totals: 100 });
    assert.equal(out.items[0].contentToken, "tok-1");
  } finally {
    await server.close();
  }
});

test("question_recommendations：不给 query 时不发送 Query", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.question_recommendations.execute({}, ctx());
    assert.equal(server.calls[0].params.Query, undefined);
    assert.equal(server.calls[0].params.Count, "5");
    assert.equal(out.items[0].title, "推荐问题");
  } finally {
    await server.close();
  }
});

test("quota：apiIds 合并为逗号分隔，不传时省略 APIIDs", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.tool.quota.execute({ apiIds: ["zhihu_search", "hot_list"] }, ctx());
    assert.equal(server.calls[0].params.APIIDs, "zhihu_search,hot_list");
    assert.deepEqual(out.items[0], {
      apiId: "zhihu_search",
      apiName: "知乎搜索",
      totalQuota: 300,
      totalUsed: 12,
      remainingQuota: 288,
    });
    await hooks.tool.quota.execute({}, ctx());
    assert.equal(server.calls[1].params.APIIDs, undefined);
  } finally {
    await server.close();
  }
});

test("知乎返回 Code 20001 时抛出 AuthenticationError（HTTP 仍是 200）", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await assert.rejects(
      () => hooks.tool.search.execute({ query: "denied" }, ctx()),
      (error) => {
        assert.equal(error.name, "AuthenticationError");
        assert.equal(error.code, 20001);
        assert.match(error.message, /Authorization failed/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("没有配置 Access Secret 时不发请求，直接给出可操作的提示", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server, { secret: undefined });
    await assert.rejects(
      () => hooks.tool.hot_list.execute({}, ctx()),
      /magpie plugin login zhihu/,
    );
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("登录信息可以从 magpie 的 plugin-auth.json 读取，并去掉 Bearer 前缀", async () => {
  const server = await mock();
  try {
    const directory = await tempDir();
    await writeFile(
      join(directory, "plugin-auth.json"),
      JSON.stringify({ zhihu: { type: "api", key: "Bearer file-secret" } }),
    );
    const hooks = await plugin(server, { secret: undefined, directory });
    await hooks.tool.hot_list.execute({}, ctx());
    assert.equal(server.calls[0].headers.authorization, "Bearer file-secret");
  } finally {
    await server.close();
  }
});

test("magpie 联网搜索：优先使用 ctx.getAuth 选定的账号，返回 {title,url,text,age}", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    const out = await hooks.search.zhihu.execute(
      { query: "远程办公", count: 3 },
      { ...ctx(), getAuth: async () => ({ type: "api", key: "ctx-secret" }) },
    );
    assert.equal(server.calls[0].headers.authorization, "Bearer ctx-secret");
    assert.equal(server.calls[0].params.Count, "3");
    assert.deepEqual(out[0], {
      title: "如何学习 Go 语言",
      url: "https://www.zhihu.com/question/1/answer/123",
      text: "先说结论：Go 语言适合……",
      age: "2025-12-31T00:00:00.000Z",
    });
  } finally {
    await server.close();
  }
});

test("参数校验：未知参数、越界数值、缺少必填项都会被拒绝", async () => {
  const server = await mock();
  try {
    const hooks = await plugin(server);
    await assert.rejects(() => hooks.tool.search.execute({ query: "x", count: 99 }, ctx()), /不能大于 10/);
    await assert.rejects(() => hooks.tool.search.execute({ query: "x", unknown: 1 }, ctx()), /未知参数/);
    await assert.rejects(() => hooks.tool.search.execute({}, ctx()), /缺少参数 query/);
    await assert.rejects(
      () => hooks.tool.question_answers.execute({ questionUrl: "not-a-url" }, ctx()),
      /必须是完整 URL/,
    );
    await assert.rejects(
      () => hooks.tool.global_search.execute({ query: "x", searchDB: "recent" }, ctx()),
      /必须是以下之一/,
    );
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("SortBy 语法：默认 desc、区间可留空、min 大于 max 时报错", () => {
  const { sortBy } = _internal;
  assert.equal(sortBy({ sortField: "VoteUpCount" }), "VoteUpCount:desc");
  assert.equal(sortBy({ sortField: "CommentCount", sortOrder: "none" }), "CommentCount:none");
  assert.equal(sortBy({ sortField: "CreateTime", sortOrder: "none", min: 1760000000, max: 1767225600 }), "CreateTime:none:(1760000000,1767225600)");
  assert.equal(sortBy({ sortField: "VoteUpCount", min: 10 }), "VoteUpCount:desc:(10,)");
  assert.equal(sortBy({ sortField: "VoteUpCount", max: 100 }), "VoteUpCount:desc:(,100)");
  assert.throws(() => sortBy({ min: 10 }), /sortField/);
  assert.throws(() => sortBy({ sortField: "VoteUpCount", min: 100, max: 10 }), /min 不能大于 max/);
});