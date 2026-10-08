#!/bin/sh
# Fails, naming them, when a package here has never been published to npm.
# Trusted publishing can't create a package, so one merged before its first
# version is on npm leaves every publish run on main red until someone
# publishes it by hand (scripts/publish.sh <otp>) and sets publish.yml as
# its Trusted Publisher on npmjs.com. A pull request runs this, so that is
# done before the merge, not found after.
set -e
cd "$(dirname "$0")/.."
export npm_config_registry=https://registry.npmjs.org
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  if [ "$(npm view "$name" name 2>/dev/null)" != "$name" ]; then
    echo "::error file=${dir}package.json::$name is not on npm yet, and trusted publishing can't create it. Before this is merged, a magpie-community npm owner publishes its first version by hand (scripts/publish.sh <otp>) and sets .github/workflows/publish.yml as its Trusted Publisher on npmjs.com; then re-run this check."
    new="$new $name"
  fi
done
if [ -n "$new" ]; then
  echo "new to npm:$new"
  exit 1
fi
echo "every package is on npm"
