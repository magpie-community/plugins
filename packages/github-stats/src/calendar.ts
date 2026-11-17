import type { Config, Day } from "./types.js";

// Date-only arithmetic in UTC avoids DST gaps; asOf is the local calendar date
// returned by the caller, not a UTC conversion of the current instant.
export function calendarRange(view: Config["heatmapView"], asOf: string) {
  const date = new Date(`${asOf}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== asOf
  )
    throw new Error("活跃图日期无效。");
  const start = new Date(date),
    end = new Date(date);
  if (view === "month") {
    start.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
  } else {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    end.setTime(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
  }
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    start: iso(start),
    end: iso(end),
    offset: (start.getUTCDay() + 6) % 7,
  };
}

export function calendarCells(
  view: Config["heatmapView"],
  asOf: string,
  days: Day[],
) {
  const range = calendarRange(view, asOf),
    byDate = new Map(days.map((d) => [d.date, d]));
  const cells = [];
  for (
    let date = new Date(`${range.start}T00:00:00Z`);
    date.toISOString().slice(0, 10) <= range.end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    const key = date.toISOString().slice(0, 10);
    cells.push({
      date: key,
      requests: key > asOf ? 0 : (byDate.get(key)?.requests ?? 0),
      future: key > asOf,
      index: cells.length + range.offset,
    });
  }
  return { ...range, cells };
}
