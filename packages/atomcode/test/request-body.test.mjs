import { test } from "node:test";
import assert from "node:assert/strict";

import {
  includeStreamUsage,
  normalizeRequestBody,
} from "../request-body.mjs";

test("normalizeRequestBody accepts replayable fetch bodies", async () => {
  const cases = [
    "hello",
    Buffer.from("buffer"),
    new TextEncoder().encode("view"),
    new TextEncoder().encode("array").buffer,
    new Blob(["blob"], { type: "application/json" }),
  ];
  for (const body of cases) {
    const normalized = await normalizeRequestBody(body);
    assert.ok(normalized.body !== undefined);
    assert.ok(normalized.signBody !== undefined);
  }
  const empty = await normalizeRequestBody(undefined, {
    request: new Request("https://example.test/"),
    fromRequest: true,
  });
  assert.equal(empty.signBody, "");
});

test("normalizeRequestBody rejects bodies that cannot be signed exactly", async () => {
  for (const body of [
    new URLSearchParams({ a: "1" }),
    new FormData(),
    new ReadableStream(),
  ]) {
    await assert.rejects(() => normalizeRequestBody(body), /unsupported request body/i);
  }
});

test("normalizeRequestBody caps Request bodies before buffering", async () => {
  const request = new Request("https://example.test/", {
    method: "POST",
    body: "too large",
  });
  await assert.rejects(
    () =>
      normalizeRequestBody(undefined, {
        request,
        fromRequest: true,
        maxBytes: 4,
      }),
    /exceeds 4 bytes/i,
  );
});

test("normalizeRequestBody enforces the cap for every replayable type", async () => {
  const bodies = [
    "too large",
    Buffer.from("too large"),
    new TextEncoder().encode("too large"),
    new TextEncoder().encode("too large").buffer,
    new Blob(["too large"]),
  ];
  for (const body of bodies) {
    await assert.rejects(
      () => normalizeRequestBody(body, { maxBytes: 4 }),
      /exceeds 4 bytes/i,
    );
  }
});

test("normalizeRequestBody reads each Request stream chunk shape", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a"));
      controller.enqueue(
        new TextEncoder().encode("b").buffer,
      );
      controller.enqueue(new DataView(new TextEncoder().encode("c").buffer));
      controller.close();
    },
  });
  const request = new Request("https://example.test/", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  const normalized = await normalizeRequestBody(undefined, {
    request,
    fromRequest: true,
  });
  assert.equal(new TextDecoder().decode(normalized.body), "abc");
});

test("includeStreamUsage only fills an absent Chat Completions option", () => {
  const absent = JSON.stringify({ model: "m", stream: true });
  const added = includeStreamUsage(absent, {
    pathname: "/v1/chat/completions",
    contentType: "application/json",
  });
  assert.equal(added.changed, true);
  assert.equal(JSON.parse(added.body).stream_options.include_usage, true);

  for (const body of [
    JSON.stringify({ model: "m", stream: false }),
    JSON.stringify({
      model: "m",
      stream: true,
      stream_options: { include_usage: false },
    }),
    absent,
  ]) {
    const result = includeStreamUsage(body, {
      pathname: body === absent ? "/v1/embeddings" : "/v1/chat/completions",
      contentType: "application/json",
    });
    assert.equal(result.changed, false);
    assert.equal(result.body, body);
  }

  const nonJson = includeStreamUsage(absent, {
    pathname: "/v1/chat/completions",
    contentType: "text/plain",
  });
  assert.equal(nonJson.changed, false);

  for (const body of [
    "not json",
    "null",
    JSON.stringify({ stream: true, stream_options: null }),
    JSON.stringify({ stream: true, stream_options: [] }),
  ]) {
    const result = includeStreamUsage(body, {
      pathname: "/v1/chat/completions",
      contentType: "application/json",
    });
    assert.equal(result.changed, false);
    assert.equal(result.body, body);
  }
});
