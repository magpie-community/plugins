import { describe, expect, it } from "vitest";
import { normalizeHunks } from "./diffHunks";

describe("normalizeHunks", () => {
  it("maps the daemon's editDetail hunks ({t, s}, oldStart/newStart) to DiffView lines", () => {
    const hunks = normalizeHunks([
      { oldStart: 1, newStart: 1, lines: [{ t: " ", s: "const x = 1;" }, { t: "-", s: "return x;" }, { t: "+", s: "return x + 1;" }] },
    ]);
    expect(hunks).toEqual([
      {
        head: "@@ -1 +1 @@",
        lines: [
          { t: " ", text: "const x = 1;" },
          { t: "-", text: "return x;" },
          { t: "+", text: "return x + 1;" },
        ],
      },
    ]);
  });

  it("keeps hunks that are already in DiffView shape and tolerates junk", () => {
    expect(normalizeHunks([{ head: "@@ -3,2 +3,2 @@", lines: [{ t: "+", text: "a" }, null, { t: "?", s: 5 }] }, 7])).toEqual([
      { head: "@@ -3,2 +3,2 @@", lines: [{ t: "+", text: "a" }, { t: " ", text: "" }] },
    ]);
    expect(normalizeHunks(undefined)).toEqual([]);
  });
});
