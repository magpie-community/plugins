#!/bin/bash
set -euo pipefail

fail() {
  printf 'Comate installer: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.command [--magpie PATH] [--login] [--dry-run]

The ZIP must be fully extracted into a persistent folder before running this
installer. The payload directory stays there; Magpie loads the plugin from it.
--login is explicit opt-in. Without it, no sign-in is started.
--dry-run verifies files and prints the command without writing or invoking Magpie.
EOF
}

magpie_input=''
login=0
dry_run=0
while (($#)); do
  case "$1" in
    --magpie)
      (($# >= 2)) || fail '--magpie needs an executable path'
      magpie_input=$2
      shift 2
      ;;
    --login)
      login=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

script_dir_input=${BASH_SOURCE[0]%/*}
if [[ "$script_dir_input" == "${BASH_SOURCE[0]}" ]]; then
  script_dir_input=.
fi
script_dir=$(cd -P -- "$script_dir_input" 2>/dev/null && pwd) || fail 'cannot resolve the extracted folder'
payload_dir="$script_dir/payload"
manifest="$script_dir/SHA256SUMS.txt"

[[ -d "$payload_dir" && ! -L "$payload_dir" ]] || fail 'payload must be a real folder beside this installer'
[[ -f "$manifest" && ! -L "$manifest" ]] || fail 'SHA256SUMS.txt is missing or is a link'
command -v shasum >/dev/null 2>&1 || fail 'shasum is required (it is included with macOS)'

expected_paths=(
  INSTALL.md
  install.command
  payload/LICENSE
  payload/README.md
  payload/discovery.mjs
  payload/index.mjs
  payload/package.json
  payload/protocol.mjs
)
seen_paths=$'\n'
entries=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^([[:xdigit:]]{64})\ \ ([A-Za-z0-9._/-]+)$ ]] || fail 'checksum manifest has an invalid row'
  digest=${BASH_REMATCH[1]}
  name=${BASH_REMATCH[2]}
  case "$name" in
    INSTALL.md|install.command|payload/LICENSE|payload/README.md|payload/discovery.mjs|payload/index.mjs|payload/package.json|payload/protocol.mjs) ;;
    *) fail 'checksum manifest contains an unexpected path' ;;
  esac
  case "$seen_paths" in *$'\n'"$name"$'\n'*) fail 'checksum manifest has a duplicate path' ;; esac
  seen_paths="${seen_paths}${name}"$'\n'
  file="$script_dir/$name"
  [[ -f "$file" && ! -L "$file" ]] || fail "package file is missing or is a link: $name"
  actual_line=$(shasum -a 256 "$file") || fail "cannot hash package file: $name"
  actual=${actual_line%% *}
  [[ "$actual" == "$digest" ]] || fail "checksum mismatch: $name"
  entries=$((entries + 1))
done < "$manifest"

[[ "$entries" -eq "${#expected_paths[@]}" ]] || fail 'checksum manifest has the wrong number of files'
for name in "${expected_paths[@]}"; do
  case "$seen_paths" in *$'\n'"$name"$'\n'*) ;; *) fail "checksum manifest is missing: $name" ;; esac
done

if [[ -n "$magpie_input" ]]; then
  magpie=$magpie_input
else
  magpie=$(command -v magpie 2>/dev/null || true)
  if [[ -z "$magpie" ]]; then
    printf 'Path to Magpie executable (blank to cancel): '
    IFS= read -r magpie || true
  fi
fi
[[ -n "$magpie" ]] || fail 'Magpie executable path is required'
case "$magpie" in
  */*)
    magpie_dir=${magpie%/*}
    [[ -n "$magpie_dir" ]] || magpie_dir=/
    magpie_name=${magpie##*/}
    [[ -f "$magpie" && -x "$magpie" ]] || fail 'Magpie path is not an executable file'
    magpie_dir=$(cd -P -- "$magpie_dir" 2>/dev/null && pwd) || fail 'cannot resolve Magpie executable folder'
    magpie="$magpie_dir/$magpie_name"
    ;;
  *)
    magpie=$(command -v "$magpie" 2>/dev/null || true)
    [[ -n "$magpie" && -f "$magpie" && -x "$magpie" ]] || fail 'Magpie executable was not found'
    ;;
esac
payload_dir=$(cd -P -- "$payload_dir" 2>/dev/null && pwd) || fail 'cannot resolve the payload folder'

if [[ "$dry_run" -eq 1 ]]; then
  printf 'Dry run: no files will be created and Magpie will not be invoked.\n'
  printf 'Would run: %q plugin add %q\n' "$magpie" "$payload_dir"
  if [[ "$login" -eq 1 ]]; then
    printf 'Would run after a successful add: %q plugin login comate\n' "$magpie"
  else
    printf 'Sign-in is skipped. To start it later: %q plugin login comate\n' "$magpie"
  fi
  exit 0
fi

printf 'Using the extracted payload at: %s\n' "$payload_dir"
printf 'The payload folder will remain here; keep it in place while Magpie uses the plugin.\n'
if "$magpie" plugin add "$payload_dir"; then
  :
else
  add_status=$?
  fail "magpie plugin add failed with exit code $add_status"
fi

if [[ "$login" -eq 1 ]]; then
  if "$magpie" plugin login comate; then
    :
  else
    login_status=$?
    fail "plugin was added, but magpie plugin login comate failed with exit code $login_status"
  fi
  printf 'Comate plugin added and sign-in completed.\n'
else
  printf 'Comate plugin added. No sign-in was started.\n'
  printf 'Start sign-in when ready with: %q plugin login comate\n' "$magpie"
fi
