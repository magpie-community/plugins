import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarCells, calendarRange } from "../dist/calendar.js";
import {
  defaults,
  saveConfig,
  readConfig,
  validateConfig,
} from "../dist/config.js";
import { readUsage } from "../dist/usage.js";
import { renderCard } from "../dist/renderer.js";
import { processExists } from "../dist/proc.mjs";

test("calendar handles six-row months, leap February, Monday weeks and year boundaries", () => {
  const month = calendarCells("month", "2026-11-17", []);
  assert.equal(month.offset, 6);
  assert.equal(month.cells.length, 30);
  assert.equal(month.cells[0].index, 6);
  assert.equal(month.cells[29].index, 35);
  assert.equal(calendarCells("month", "2024-02-29", []).cells.length, 29);
  assert.deepEqual(calendarRange("week", "2027-01-01"), {
    start: "2026-12-28",
    end: "2027-01-03",
    offset: 0,
  });
  assert.equal(calendarRange("week", "2026-11-22").start, "2026-11-16");
  assert.throws(() => calendarRange("month", "2026-02-31"));
});
test("missing dates keep their real calendar positions; future dates remain distinct from zeros", () => {
  const { cells } = calendarCells("week", "2026-11-17", [
    { date: "2026-11-17", requests: 10, tokens: 1 },
    { date: "2026-11-20", requests: 99, tokens: 1 },
  ]);
  assert.equal(cells[0].requests, 0);
  assert.equal(cells[0].future, false);
  assert.equal(cells[1].requests, 10);
  assert.equal(cells[4].requests, 0);
  assert.equal(cells[4].future, true);
});
test("view preference migrates old configs, validates and persists both choices", async (t) => {
  assert.equal(validateConfig({}).heatmapView, "month");
  assert.throws(() => validateConfig({ heatmapView: "year" }));
  const dir = await mkdtemp(join(tmpdir(), "magpie-calendar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const heatmapView of ["month", "week"]) {
    await saveConfig({ ...defaults, heatmapView }, dir);
    assert.equal((await readConfig(dir)).heatmapView, heatmapView);
  }
});
const summary = (period) => ({
  period,
  since: "2026-11-01T00:00:00+08:00",
  bucket: "day",
  calls: 3,
  input: 10,
  output: 1,
  cost: 0,
  models: [],
  series: [],
});
test("month heatmap fetches its own bounded daily range without changing 7-day headline totals", async () => {
  const ranges = [];
  const stats = await readUsage(
    { ...defaults, period: "7d" },
    async (url) => {
      const period = new URL(url).searchParams.get("period");
      ranges.push(period);
      return Response.json({
        ...summary(period),
        series:
          period === "7d"
            ? []
            : [
                {
                  time: "2026-11-02T00:00:00+08:00",
                  calls: 42,
                  input: 20,
                  output: 2,
                },
              ],
      });
    },
    new Date(2026, 10, 17, 23),
  );
  assert.deepEqual(ranges, ["7d", "2026-11-01..2026-11-17"]);
  assert.equal(stats.requests, 3);
  assert.equal(stats.heatmap.days[0].requests, 42);
  assert.equal(stats.heatmap.asOf, "2026-11-17");
});
test("31-day months split daily API reads and disabled heatmaps make no extra request", async () => {
  const ranges = [];
  const fetcher = async (url) => {
    const p = new URL(url).searchParams.get("period");
    ranges.push(p);
    return Response.json(summary(p));
  };
  await readUsage(defaults, fetcher, new Date(2026, 9, 31, 23));
  assert.deepEqual(ranges, [
    "30d",
    "2026-10-01..2026-10-30",
    "2026-10-31..2026-10-31",
  ]);
  ranges.length = 0;
  await readUsage({ ...defaults, showHeatmap: false }, fetcher);
  assert.deepEqual(ranges, ["30d"]);
});
test("incompatible heatmap summary fails rather than publishing fabricated zero days", async () => {
  await assert.rejects(
    readUsage(
      defaults,
      async (url) => {
        const p = new URL(url).searchParams.get("period");
        return Response.json({
          ...summary(p),
          bucket: p === "30d" ? "day" : "week",
        });
      },
      new Date(2026, 10, 17),
    ),
    /每日汇总/,
  );
});
test("both calendar views stay within SVG bounds at every supported width and theme", () => {
  const stats = {
    period: "30d",
    since: "2026-11-01",
    requests: 0,
    tokens: 0,
    activeDays: 0,
    estimatedCost: 0,
    unpriced: 0,
    days: [],
    models: [],
    heatmap: { asOf: "2026-11-17", days: [] },
  };
  for (const heatmapView of ["month", "week"])
    for (const width of [320, 520, 640, 800])
      for (const theme of ["aurora", "minimal", "cyberpunk"])
        for (const mode of ["light", "dark"]) {
          const svg = renderCard(
            stats,
            { ...defaults, heatmapView, width, theme },
            mode,
            "2026-11-17",
          );
          assert.equal(
            [...svg.matchAll(/data-date=/g)].length,
            heatmapView === "month" ? 30 : 7,
          );
          assert.match(
            svg,
            heatmapView === "month"
              ? /MONTH · 2026-11/
              : /WEEK · 11-16 – 11-22/,
          );
          assert.doesNotMatch(svg, /NaN|Infinity/);
          const height = Number(svg.match(/height="([\d.]+)"/)[1]);
          for (const [, x, y, w, h] of svg.matchAll(
            /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
          )) {
            assert.ok(+x + +w <= width + 0.02);
            assert.ok(+y + +h <= height);
          }
        }
});
test("shared process probe reclaims Linux zombie locks but preserves uncertain owners", () => {
  const deps = {
    platform: "linux",
    kill: () => {},
    readFile: () => "123 (process (name)) Z 1 2 3",
  };
  assert.equal(processExists(123, deps), false);
  for (const code of ["EPERM", "EIO"])
    assert.equal(
      processExists(123, {
        platform: "darwin",
        kill: () => {
          throw Object.assign(new Error(), { code });
        },
      }),
      true,
    );
  assert.equal(
    processExists(123, {
      kill: () => {
        throw Object.assign(new Error(), { code: "ESRCH" });
      },
    }),
    false,
  );
});
