#!/usr/bin/env bash
set -euo pipefail
# Use a disposable writable checkout, never Eta's read-only .repos reference.
source_root="$(cd "${1:?usage: run-host-tests.sh /path/to/writable/magpie}" && pwd)"
case "$source_root" in
  */.repos/*) echo "Use a writable checkout outside .repos" >&2; exit 1 ;;
esac
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
test_file="$source_root/internal/agent/eta_plugin_external_test.go"
if [[ -e "$test_file" ]]; then
  echo "Refusing to overwrite $test_file" >&2
  exit 1
fi
cp "$plugin_root/tests/eta_plugin_test.go" "$test_file"
trap 'rm -f "$test_file"' EXIT
cd "$source_root"
ETA_MAGPIE_PLUGIN="$plugin_root" CGO_ENABLED=0 "${GO_BINARY:-go}" test -tags nogui ./internal/agent -run '^TestEtaPlugin' -count=1
