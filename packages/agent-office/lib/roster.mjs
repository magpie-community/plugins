// Who is who: the roster maps each agent to a person — a name, a research
// direction, what they are good at (the user's 课题组, their own file). The
// office page, the notification cards and the outside bridge all read the
// same one, so a person is called the same everywhere. The file is the
// user's own data and is hot-read (mtime-cached): editing it shows within
// a tick, no restart. A missing or broken file is an empty roster, never
// an error — a name is a courtesy, not a duty. It is user-written display
// metadata: it does not depend on the text gate and never carries session
// content.
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const EMPTY = Object.freeze({ group: {}, people: {} })

function expand(p) {
  return p.startsWith("~/") ? join(process.env.HOME || homedir(), p.slice(2)) : p
}

// where the roster lives, unless options.rosterFile says otherwise
export function rosterPath(override = "") {
  if (override) return expand(override)
  if (process.env.MAGPIE_AGENT_OFFICE_ROSTER) return expand(process.env.MAGPIE_AGENT_OFFICE_ROSTER)
  const cfg = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config")
  return join(cfg, "magpie", "agent-office-roster.json")
}

// whatever the file held, trimmed to what is used: people keyed by agent id
function normalize(j) {
  if (!j || typeof j !== "object") return EMPTY
  const people = {}
  for (const p of Array.isArray(j.people) ? j.people : []) {
    if (!p || typeof p.agent !== "string" || !p.agent) continue
    if (typeof p.name !== "string" || !p.name.trim()) continue
    const str = (v) => (typeof v === "string" ? v.trim() : "")
    people[p.agent] = { name: p.name.trim(), direction: str(p.direction), skills: str(p.skills), note: str(p.note) }
  }
  return { group: j.group && typeof j.group === "object" && !Array.isArray(j.group) ? j.group : {}, people }
}

const cache = { path: "", key: "", roster: EMPTY }

// the roster as { group, people }, cached against the file's own stamp so a
// rewrite lands on the next snapshot and an unreadable path is tried again
export function loadRoster(path = rosterPath()) {
  let stamp
  try {
    const st = statSync(path)
    stamp = st.mtimeMs + ":" + st.size
  } catch {
    stamp = "missing"
  }
  if (cache.path === path && cache.key === stamp) return cache.roster
  let roster = EMPTY
  try {
    roster = normalize(JSON.parse(readFileSync(path, "utf8")))
  } catch {}
  cache.path = path
  cache.key = stamp
  cache.roster = roster
  return roster
}

// one agent's person, or null
export function personOf(roster, agent) {
  return roster?.people?.[agent] || null
}
