// Imported first by every test here, and called before the file reads its
// environment: no test finds an installed Grok Build (plugins#325). The
// plugin looks for grok in GROK_BIN_DIR, GROK_HOME/bin, ~/.grok/bin, each
// folder on PATH and ~/.local/bin, and runs what it finds (`grok --version`,
// `grok models`), which can reach xAI. So PATH holds only /usr/bin and /bin
// (the fakes' scripts run cat, rm and sleep), and neither if it has a grok;
// on Windows it is empty. GROK_BIN_DIR is a folder that doesn't exist, and
// HOME (USERPROFILE on Windows) and GROK_HOME are empty folders of the
// test's own. A test that wants a CLI puts its fake
// in GROK_BIN_DIR, as before.
//
// bun test runs every file of the run in one process, so the file puts the
// environment back when it ends: every variable as it was before the file's
// first noRealGrok, and none it added. Left as it was, the next package's
// files ran with PATH=/usr/bin:/bin, and on a runner whose node is elsewhere
// (actions/setup-node's /opt/hostedtoolcache) gumloop's spawn("node") found
// none.
//
// Bun's os.homedir() keeps the HOME the process started with, so a HOME set
// here would leave ~/.grok/bin and ~/.local/bin where they were. homedir is
// made to read HOME (USERPROFILE) when called, as Node's does; this module
// is imported before index.mjs, so the plugin gets that one. Other packages'
// tests in the same run see Node's behaviour, the started HOME unless a test
// changed it.
import { afterAll, mock } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import { delimiter, join } from "node:path"

const started = os.homedir()
const homedir = () => (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || started
mock.module("node:os", () => ({ ...os, default: { ...os, homedir }, homedir }))

const system = process.platform === "win32" ? [] : ["/usr/bin", "/bin"].filter((d) => !existsSync(join(d, "grok")))
const root = mkdtempSync(join(os.tmpdir(), "grok-nocli-"))
process.on("exit", () => rmSync(root, { recursive: true, force: true }))

let outside // the environment before this file's first noRealGrok
function putBack() {
  if (!outside) return
  for (const key of Object.keys(process.env)) if (!(key in outside)) delete process.env[key]
  Object.assign(process.env, outside)
  outside = undefined
}

export function noRealGrok() {
  if (!outside) {
    outside = { ...process.env }
    afterAll(putBack)
  }
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, "grok-home"), { recursive: true })
  process.env.PATH = system.join(delimiter)
  process.env.GROK_BIN_DIR = join(root, "no-bin")
  process.env.GROK_HOME = join(root, "grok-home")
  process.env.HOME = home
  process.env.USERPROFILE = home
}

noRealGrok()
