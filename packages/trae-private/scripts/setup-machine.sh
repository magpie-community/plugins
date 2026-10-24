#!/usr/bin/env bash
# 转给 setup-machine.mjs，macOS / Linux 用；Windows 直接跑 node 或 bun 那份。
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v bun >/dev/null 2>&1; then
  exec bun "$dir/setup-machine.mjs" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$dir/setup-machine.mjs" "$@"
fi
echo "需要 bun 或 node 才能跑自检" >&2
exit 1

