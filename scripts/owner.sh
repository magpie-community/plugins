#!/bin/sh
# Everything only an owner of the magpie-community npm org can do, in one
# run (README, Publishing):
# - a package npm doesn't have yet: its first version is published from
#   here (trusted publishing can't create a package), then publish.yml is
#   made its Trusted Publisher with npm publish allowed;
# - a package whose version on main npm doesn't have: its Trusted Publisher
#   is made again with npm publish allowed (one made since 2026-09-03
#   allows stage publish only), and publish.yml is run to publish it.
# It works from a checkout of origin/main of its own, whatever the checkout
# it is run from holds, and does nothing for a package that is up to date,
# so running it again is safe. npm asks for 2FA in the browser; a sign-in
# there can skip it for the next 5 minutes.
#
#   sh scripts/owner.sh            do it
#   sh scripts/owner.sh --dry-run  only say what it would do
set -eu

dry=""
[ "${1:-}" = "--dry-run" ] && dry=1
repo=magpie-community/plugins
reg=https://registry.npmjs.org/
export npm_config_registry="$reg"
# npm trust needs npm 11.5 or later. Its 2FA waits for the browser only
# when it can ask on a terminal; without one it prints the link and fails
# with EOTP, so npm reads from the terminal even when this script is piped.
npm11() { npx -y npm@11 "$@" </dev/tty; }

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
git -C "$root" fetch -q https://github.com/$repo.git main
work=$(mktemp -d)
trap 'git -C "$root" worktree remove --force "$work/main" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git -C "$root" worktree add -q --detach "$work/main" FETCH_HEAD

# each package as "<dir> <name> <version> <state>", state new, behind or ok
node - "$work/main/packages" "$reg" > "$work/state" <<'EOF'
const fs = require("fs"), path = require("path")
const [dir, reg] = process.argv.slice(2)
;(async () => {
  for (const d of fs.readdirSync(dir).sort()) {
    let pj
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, d, "package.json"), "utf8")) } catch { continue }
    if (pj.private) continue
    const r = await fetch(reg + pj.name.replace("/", "%2f"), { headers: { accept: "application/vnd.npm.install-v1+json" } })
    let state
    if (r.status === 404) state = "new"
    else if (!r.ok) throw new Error(`${pj.name}: npm answered ${r.status}`)
    else state = (await r.json()).versions?.[pj.version] ? "ok" : "behind"
    console.log(d, pj.name, pj.version, state)
  }
})().catch(e => { console.error(e.message); process.exit(1) })
EOF

todo=$(grep -v ' ok$' "$work/state" || true)
if [ -z "$todo" ]; then
  echo "npm has every package's version on main: nothing to do."
  exit 0
fi
echo "To do:"
echo "$todo" | while read -r d name version state; do
  case $state in
    new) echo "  $name $version: first publish, then its Trusted Publisher" ;;
    behind) echo "  $name $version: its Trusted Publisher again, with npm publish allowed" ;;
  esac
done
[ -n "$dry" ] && exit 0
if ! (: </dev/tty) 2>/dev/null; then
  echo "npm's 2FA needs a terminal: run this in Terminal (not through a tool with no terminal, such as Claude Code's !)." >&2
  exit 1
fi

if ! npm11 whoami >/dev/null 2>&1; then
  echo "Signing in to npm (in the browser)..."
  npm11 login --auth-type=web
fi
echo "npm user: $(npm11 whoami)"

trust() {
  # a trust can't be changed, only revoked and made again
  ids=$(npm11 trust list "$1" --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      const ids = new Set(), walk = v => {
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === "object") { if (typeof v.id === "string") ids.add(v.id); Object.values(v).forEach(walk) }
      }
      try { walk(JSON.parse(s)) } catch {}
      console.log([...ids].join(" "))
    })') || ids=""
  for id in $ids; do
    npm11 trust revoke "$1" --id="$id" -y
  done
  npm11 trust github "$1" --file publish.yml --repo "$repo" --allow-publish -y
}

failed="" dispatch=""
while read -r d name version state; do
  echo
  echo "== $name $version"
  case $state in
    new)
      if (cd "$work/main/packages/$d" && npm11 publish --access public) && trust "$name"; then :; else failed="$failed $name"; fi
      ;;
    behind)
      if trust "$name"; then dispatch=1; else failed="$failed $name"; fi
      ;;
  esac
done <<EOF
$todo
EOF

if [ -n "$dispatch" ]; then
  echo
  gh workflow run publish.yml -R "$repo" && echo "publish.yml started: https://github.com/$repo/actions/workflows/publish.yml"
fi
echo
if [ -n "$failed" ]; then
  echo "Not done:$failed (see above); run this again to retry."
  exit 1
fi
echo "Done."
