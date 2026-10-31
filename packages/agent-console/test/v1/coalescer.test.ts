import { describe, it, expect } from "vitest";
import { Coalescer } from "../../daemon/src/timeline/coalescer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coalescer", () => {
  it("first delta is sent immediately (leading)", async () => {
    const out: [string, string][] = [];
    const c = new Coalescer(60, (id, t) => out.push([id, t]));
    c.push("a", "he");
    expect(out).toEqual([["a", "he"]]);
    c.dispose();
  });

  it("deltas within 60ms are merged and sent once (trailing)", async () => {
    const out: [string, string][] = [];
    const c = new Coalescer(60, (id, t) => out.push([id, t]));
    c.push("a", "he");   // leading: sent immediately
    c.push("a", "llo");
    c.push("a", "!");
    expect(out).toEqual([["a", "he"]]);
    await sleep(90);
    expect(out).toEqual([["a", "he"], ["a", "llo!"]]);
    c.dispose();
  });

  it("leading resumes after the window ends", async () => {
    const out: [string, string][] = [];
    const c = new Coalescer(50, (id, t) => out.push([id, t]));
    c.push("a", "x");
    await sleep(80);
    c.push("a", "y"); // Window has passed → sent immediately
    expect(out).toEqual([["a", "x"], ["a", "y"]]);
    c.dispose();
  });

  it("pending deltas are flushed before the complete event", async () => {
    const out: [string, string][] = [];
    const c = new Coalescer(60, (id, t) => out.push([id, t]));
    c.push("a", "he");
    c.push("a", "llo");
    c.flushItem("a"); // Complete event arrives
    expect(out).toEqual([["a", "he"], ["a", "llo"]]);
    await sleep(80);
    expect(out.length).toBe(2); // Nothing more is sent after flush
  });

  it("different itemIds don't affect each other", async () => {
    const out: [string, string][] = [];
    const c = new Coalescer(60, (id, t) => out.push([id, t]));
    c.push("a", "1");
    c.push("b", "2");
    c.push("a", "3");
    expect(out).toEqual([["a", "1"], ["b", "2"]]);
    c.dispose(); // flush a:3
    expect(out).toEqual([["a", "1"], ["b", "2"], ["a", "3"]]);
  });
});
