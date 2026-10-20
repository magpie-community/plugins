import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  INTENT,
  MATCH,
  decide,
  parseRules,
  render,
  sanitizeCategory,
  transcriptOf,
  trimTranscript,
} from "./classify.mjs";

const system = readFileSync(new URL("./fixtures/classifier-system.txt", import.meta.url), "utf8");
const rules = parseRules(system);

function answers(probs, authorized = 0, forbidden = 0) {
  return {
    rule: { type: "choice", probabilities: probs },
    authorized: { type: "noul", noul: authorized },
    forbidden: { type: "noul", noul: forbidden },
  };
}

const none = { none: 0.99 };

describe("parseRules", () => {
  test("reads the block and allow rules out of the classifier prompt", () => {
    expect(rules.filter((rule) => rule.kind === "hard").map((rule) => rule.name)).toEqual(["Data Exfiltration"]);
    expect(rules.filter((rule) => rule.kind === "soft").length).toBeGreaterThan(50);
    expect(rules.filter((rule) => rule.kind === "allow").length).toBeGreaterThan(10);
    const git = rules.find((rule) => rule.name === "Git Destructive");
    expect(git.kind).toBe("soft");
    expect(git.summary.startsWith("A force-push")).toBe(true);
  });

  test("gives up when the prompt has no rule sections", () => {
    expect(parseRules("you are a helpful assistant")).toBeNull();
  });
});

describe("sanitizeCategory", () => {
  test("keeps only letters, digits and spaces", () => {
    expect(sanitizeCategory("Logging/Audit Tampering")).toBe("Logging Audit Tampering");
    expect(sanitizeCategory("Irreversible Deletion (general)")).toBe("Irreversible Deletion general");
    expect(sanitizeCategory("DNS / Domain / Cert Changes")).toBe("DNS Domain Cert Changes");
  });
});

describe("transcriptOf", () => {
  test("stage 1 is the call that stops at </block>", () => {
    const found = transcriptOf({
      content: "<transcript>\n{\"Bash\":\"pwd\"}\n</transcript>\n\nStage 1 does NOT apply user intent.",
      stop_sequences: ["</block>"],
    });
    expect(found.stage).toBe(1);
    expect(found.transcript).toBe('{"Bash":"pwd"}');
  });

  test("a transcript without the stop sequence is stage 2", () => {
    const found = transcriptOf({ content: [{ type: "text", text: "<transcript>\nx\n</transcript>\n\nUse <thinking>." }] });
    expect(found.stage).toBe(2);
  });

  test("a plain chat message isn't a classifier request", () => {
    expect(transcriptOf({ content: "hello" })).toBeNull();
  });
});

describe("decide", () => {
  test("allows ordinary work", () => {
    expect(decide(rules, answers(none), 1).block).toBe(false);
    expect(decide(rules, answers(none), 2).block).toBe(false);
  });

  test("a hard rule blocks in both stages, even when the user asked for it", () => {
    const given = answers({ "block: Data Exfiltration": 0.7, none: 0.3 }, 0.95);
    expect(decide(rules, given, 1).block).toBe(true);
    const stage2 = decide(rules, given, 2);
    expect(stage2.block).toBe(true);
    expect(stage2.category.rule.name).toBe("Data Exfiltration");
  });

  test("a soft rule blocks in stage 1 and clears in stage 2 once the user named it", () => {
    const given = answers({ "block: Git Destructive": 1 }, 0);
    expect(decide(rules, given, 1).block).toBe(true);
    expect(decide(rules, given, 2).block).toBe(true);

    const authorized = answers({ "block: Git Destructive": 1 }, INTENT);
    expect(decide(rules, authorized, 1).block).toBe(true);
    expect(decide(rules, authorized, 2).block).toBe(false);
  });

  test("an allow exception that outranks the soft rule allows the action", () => {
    const given = answers({ "block: Irreversible Local Destruction": 0.2, "allow: Memory Directory": 0.7, none: 0.1 });
    expect(decide(rules, given, 2).block).toBe(false);
  });

  test("several soft rules that split the probability still block", () => {
    const given = answers({
      "block: Unverifiable Deletion Target": 0.45,
      "block: Irreversible Local Destruction": 0.4,
      none: 0.15,
    });
    const verdict = decide(rules, given, 2);
    expect(verdict.block).toBe(true);
    expect(verdict.category.rule.name).toBe("Unverifiable Deletion Target");
    expect(verdict.also.map((item) => item.rule.name)).toContain("Irreversible Local Destruction");
  });

  test("a thin probability names no rule", () => {
    const given = answers({ "block: Git Destructive": MATCH - 0.01, none: 0.86 });
    expect(decide(rules, given, 1).block).toBe(false);
  });

  test("an explicit user boundary blocks an action that touches a block rule", () => {
    const given = answers({ "block: Git Destructive": 0.3, none: 0.7 }, 0, INTENT);
    const verdict = decide(rules, given, 2);
    expect(verdict.block).toBe(true);
    expect(verdict.boundary).toBe(true);
  });

  test("a user boundary doesn't block work no rule covers", () => {
    const given = answers(none, 0, 1);
    expect(decide(rules, given, 2).block).toBe(false);
  });
});

describe("render", () => {
  test("stage 1 stops at the block tag", () => {
    const verdict = decide(rules, answers({ "block: Git Destructive": 1 }), 1);
    expect(render(verdict, 1)).toBe("<block>yes");
    expect(render(decide(rules, answers(none), 1), 1)).toBe("<block>no");
  });

  test("stage 2 names the rule exactly in the reason and sanitized in the category", () => {
    const verdict = decide(rules, answers({ "block: Irreversible Deletion (general)": 1 }), 2);
    const text = render(verdict, 2);
    expect(text.startsWith("<thinking>")).toBe(true);
    expect(text).toContain("<category>Irreversible Deletion general</category>");
    expect(text).toContain("<reason>[Irreversible Deletion (general)] ");
  });

  test("an allowed stage 2 action carries no category", () => {
    expect(render(decide(rules, answers(none), 2), 2)).toBe("<block>no</block>");
  });
});

describe("trimTranscript", () => {
  test("keeps the final action and the first user message when it has to cut", () => {
    const lines = ['{"user":"fix the lint errors in the parser"}'];
    for (let i = 0; i < 400; i++) lines.push(`{"Bash":"echo ${i}"}`);
    lines.push('{"Bash":"rm -rf ~/"}');
    const trimmed = trimTranscript(lines.join("\n"), 2000);
    expect(trimmed.length).toBeLessThan(2100);
    expect(trimmed.endsWith('{"Bash":"rm -rf ~/"}')).toBe(true);
    expect(trimmed).toContain('{"user":"fix the lint errors in the parser"}');
    expect(trimmed.startsWith("[")).toBe(true);
  });

  test("leaves a short transcript untouched", () => {
    expect(trimTranscript('{"Bash":"pwd"}')).toBe('{"Bash":"pwd"}');
  });
});
