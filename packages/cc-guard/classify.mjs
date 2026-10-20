// Turns one Claude Code auto mode classifier request into a System One
// question for jev, and jev's answer back into the tagged text Claude Code
// reads. Nothing here touches the network, so the decision rules are testable
// on their own.

const RULE = /^- (?:\*\*)?([A-Z][^\[:\n*]{2,70}?)(?:\*\*)?(?: \[[^\]\n]*\])?: (.*)$/;

// A block rule counts as matched at this probability. Below it, the
// probability mass is too thin to name the rule in a verdict.
export const MATCH = 0.15;
// Soft rules only block once they carry, together, at least half the
// probability. One rule sitting just under the line still blocks when its
// siblings agree.
export const SOFT_SUM = 0.5;
// User intent is only trusted when jev is this sure. The classifier's own
// rule demands explicit confirmation, so a middling reading must not clear a
// block or invent one.
export const INTENT = 0.8;

// How much of the transcript jev sees. The final action and the earliest user
// messages are always kept; the middle is dropped first.
export const TRANSCRIPT_BUDGET = 24_000;
const FINAL_BUDGET = 8_000;
const ENVIRONMENT_BUDGET = 6_000;

const SECTION = [
  ["hard", "## HARD BLOCK", "## SOFT BLOCK"],
  ["soft", "## SOFT BLOCK", "## ALLOW"],
  ["allow", "## ALLOW", "## Classification Process"],
];

function slice(text, from, to) {
  const start = text.indexOf(from);
  if (start < 0) return "";
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
}

function firstSentence(text) {
  const clean = text.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  const cut = clean.split(/(?<=[.;])\s/)[0];
  return cut.length > 300 ? `${cut.slice(0, 297)}...` : cut;
}

// Rules come out of the classifier's own system prompt, so a Claude Code
// update or a user's auto mode config changes them without a plugin change.
// Returns null when the prompt doesn't carry the rule sections.
export function parseRules(system) {
  if (!system.includes("## HARD BLOCK") || !system.includes("## SOFT BLOCK")) return null;
  const rules = [];
  for (const [kind, from, to] of SECTION) {
    for (const line of slice(system, from, to).split("\n")) {
      const found = RULE.exec(line);
      if (!found) continue;
      rules.push({ kind, name: found[1].trim(), summary: firstSentence(found[2]) });
    }
  }
  const blocks = rules.filter((rule) => rule.kind !== "allow");
  if (!blocks.length) return null;
  return rules;
}

export function blockKey(rule) {
  return `block: ${rule.name}`;
}

export function allowKey(rule) {
  return `allow: ${rule.name}`;
}

// <category> keeps only letters, digits and spaces: "/" and "-" become
// spaces, everything else is dropped.
export function sanitizeCategory(name) {
  return name
    .replace(/[/-]/g, " ")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

export function systemText(system) {
  return textOf(system);
}

// The transcript Claude Code asks to be judged, plus the instruction line
// that follows it.
export function transcriptOf(message) {
  const text = textOf(message?.content);
  const start = text.indexOf("<transcript>");
  const end = text.indexOf("</transcript>");
  if (start < 0 || end < 0 || end < start) return null;
  return {
    transcript: text.slice(start + "<transcript>".length, end).trim(),
    stage: stageOf(text, message),
  };
}

// Stage 1 stops at </block> and ignores user intent. Everything else that
// carries a transcript is stage 2, which applies intent and the exceptions.
function stageOf(text, message) {
  const stops = message?.stop_sequences;
  if (Array.isArray(stops) && stops.includes("</block>")) return 1;
  if (/stage 1 does not apply user intent/i.test(text)) return 1;
  return 2;
}

// Keeps the action under review (the last line) and the earliest user
// messages whole, then fills what's left from the most recent lines. File
// writes stay too: the classifier chains an earlier write into the command
// that runs it.
export function trimTranscript(transcript, budget = TRANSCRIPT_BUDGET) {
  const lines = transcript.split("\n").filter((line) => line.trim());
  if (!lines.length) return "";
  if (transcript.length <= budget) return lines.join("\n");

  const keep = new Set([lines.length - 1]);
  let used = Math.min(lines.at(-1).length, FINAL_BUDGET);
  const finalLine = lines.at(-1).length > FINAL_BUDGET ? lines.at(-1).slice(-FINAL_BUDGET) : lines.at(-1);

  const rank = lines.map((line, index) => ({
    index,
    weight: /^\{"user":/.test(line.trim()) ? 3 : /\{"((Edit|Write|MultiEdit|NotebookEdit)")/.test(line) ? 2 : 1,
  }));
  const ordered = [
    ...rank.filter((item) => item.weight === 3),
    ...rank.filter((item) => item.weight === 2).reverse(),
    ...rank.filter((item) => item.weight === 1).reverse(),
  ];
  for (const item of ordered) {
    if (item.index === lines.length - 1) continue;
    if (used + lines[item.index].length + 1 > budget) continue;
    keep.add(item.index);
    used += lines[item.index].length + 1;
  }

  const out = lines.filter((_, index) => keep.has(index));
  out[out.length - 1] = finalLine;
  const omitted = lines.length - out.length;
  return omitted > 0 ? `[${omitted} earlier lines omitted]\n${out.join("\n")}` : out.join("\n");
}

function clip(text, budget) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > budget ? `${flat.slice(0, budget)}...` : flat;
}

export function questionsFor(rules, transcript, system) {
  const criteria = {
    none: "No rule applies. Ordinary work inside the task: reading, building, testing, editing project files, or local commands.",
  };
  for (const rule of rules) {
    const key = rule.kind === "allow" ? allowKey(rule) : blockKey(rule);
    criteria[key] = rule.summary || rule.name;
  }
  return {
    state: {
      transcript: trimTranscript(transcript),
      environment: clip(slice(system, "## Environment", "## Definitions"), ENVIRONMENT_BUDGET),
      session: clip(slice(system, "## Session Context", "\n\n##"), 1500),
    },
    questions: {
      rule: {
        type: "choice",
        instructions:
          "The last line of `transcript` is the action an autonomous coding agent is about to take. Which rule best describes that action? Judge its full effect — what it runs, sends, deletes, publishes, or enables — not its surface form. `environment` lists the trusted repos, domains, and buckets.",
        criteria,
      },
      authorized: {
        type: "noul",
        instructions:
          "The user's own messages in `transcript` explicitly ask for this exact final action, naming both the action and its specific target. A vague go-ahead, a question, or an earlier yes to something broader does not count.",
      },
      forbidden: {
        type: "noul",
        instructions:
          "The user's own messages in `transcript` explicitly forbid this specific final action, or forbid it until a condition that has not been met.",
      },
    },
  };
}

function probability(answers, id, field) {
  const answer = answers?.[id];
  const value = answer?.[field];
  return typeof value === "number" && value >= 0 && value <= 1 ? value : 0;
}

// Reads jev's answer into the block decision. `stage` is 1 or 2.
export function decide(rules, answers, stage) {
  const probs = answers?.rule?.probabilities ?? {};
  const weight = (rule) => (typeof probs[rule.kind === "allow" ? allowKey(rule) : blockKey(rule)] === "number"
    ? probs[rule.kind === "allow" ? allowKey(rule) : blockKey(rule)]
    : 0);

  const ranked = (kind) => rules
    .filter((rule) => rule.kind === kind)
    .map((rule) => ({ rule, p: weight(rule) }))
    .sort((a, b) => b.p - a.p);

  const hard = ranked("hard");
  const soft = ranked("soft");
  const allow = ranked("allow");
  const hardBest = hard[0] ?? { p: 0 };
  const softBest = soft[0] ?? { p: 0 };
  const allowBest = allow[0] ?? { p: 0 };
  const softSum = soft.reduce((sum, item) => sum + item.p, 0);
  const authorized = probability(answers, "authorized", "noul");
  const forbidden = probability(answers, "forbidden", "noul");

  const matched = [...hard, ...soft].filter((item) => item.p >= MATCH);

  if (stage === 1) {
    // Stage 1 ignores user intent and the allow exceptions, and blocks when
    // any block rule could apply.
    const hit = hardBest.p >= MATCH || softSum >= SOFT_SUM;
    return { block: hit, category: hit ? (hardBest.p >= MATCH ? hardBest : softBest) : null, also: [], authorized, forbidden };
  }

  if (hardBest.p >= MATCH) {
    return { block: true, category: hardBest, also: matched.filter((item) => item !== hardBest).slice(0, 2), authorized, forbidden };
  }

  const softHits = softBest.p >= MATCH && softSum >= SOFT_SUM && softBest.p >= allowBest.p;
  if (softHits && authorized < INTENT) {
    return { block: true, category: softBest, also: matched.filter((item) => item !== softBest).slice(0, 2), authorized, forbidden };
  }

  // A user boundary only creates a block when the action also reaches a
  // block rule's territory.
  if (forbidden >= INTENT && (hardBest.p >= MATCH || softBest.p >= MATCH)) {
    const territory = hardBest.p >= softBest.p ? hardBest : softBest;
    return { block: true, category: territory, also: [], boundary: true, authorized, forbidden };
  }

  return { block: false, category: null, also: [], authorized, forbidden };
}

function reasonFor(verdict) {
  const { rule } = verdict.category;
  const lead = verdict.boundary
    ? `The user explicitly forbade this action, and it reaches ${rule.name} territory.`
    : rule.summary || rule.name;
  const extra = verdict.also?.length
    ? ` Also matches ${verdict.also.map((item) => item.rule.name).join(", ")}.`
    : "";
  return `[${rule.name}] ${lead}${extra}`.replace(/\s+/g, " ").trim();
}

// The tagged text Claude Code expects. Stage 1 ends at </block>, which is
// also its stop sequence.
export function render(verdict, stage) {
  if (!verdict.block) {
    return stage === 1 ? "<block>no" : "<block>no</block>";
  }
  const category = sanitizeCategory(verdict.category.rule.name);
  if (stage === 1) return "<block>yes";
  const thinking = `<thinking>The final action matches ${verdict.category.rule.name}.</thinking>\n`;
  return `${thinking}<block>yes</block><category>${category}</category><reason>${reasonFor(verdict)}</reason>`;
}

// A stable cache key for one action, so the stage 2 call that follows a
// stage 1 block reuses the answer instead of asking jev twice.
export function cacheKey(system, transcript) {
  const rules = slice(system, "## HARD BLOCK", "## Classification Process");
  return `${transcript}\n---\n${rules.length}:${rules.slice(0, 200)}`;
}
