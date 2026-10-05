#!/bin/sh
# Stage the fork's latest nightly; add --install locally to replace a stopped app:
#   curl -fsSL https://raw.githubusercontent.com/nitya-ranjan/t3code/nitya/release/scripts/install-fork.sh | sh
#   sh scripts/install-fork.sh --stage --version 0.0.46-nightly.20261005.2
# macOS uses system tools; Linux needs curl, jq, tar and sha256sum (or shasum).
set -eu
umask 077

repo=nitya-ranjan/t3code
version=${T3CODE_VERSION:-}
stage_only=true
cleanup_old_apps=false
system_applications=/Applications
stage_root=${T3CODE_FORK_STAGE_DIR:-$HOME/.cache/t3code-fork}
target=
status_only=false
fail() { printf 't3 fork: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage) stage_only=true ;;
    --install) stage_only=false ;;
    --cleanup-old-apps) cleanup_old_apps=true ;;
    --status) status_only=true ;;
    --version|--stage-dir|--target)
      option=$1; shift
      [ "$#" -gt 0 ] || fail "$option needs a value"
      case "$option" in
        --version) version=$1 ;;
        --stage-dir) stage_root=$1 ;;
        --target) target=$1 ;;
      esac ;;
    --help)
      printf '%s\n' 'Usage: install-fork.sh [--stage|--install] [--version VERSION] [--stage-dir DIRECTORY] [--target MAC_APP_PATH] [--cleanup-old-apps] [--status]' 'Default: stage only. GitHub Actions always stages. --install requires the app/CLI to be stopped.' 'Local Mac --install --cleanup-old-apps moves old Alpha apps and the replaced app into your Trash; settings remain untouched.'
      exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done
case "$stage_root" in /*) ;; *) fail '--stage-dir must be an absolute path' ;; esac
if "$status_only"; then
  [ -f "$stage_root/status.json" ] || fail 'no previous install or staging receipt'
  cat "$stage_root/status.json"
  exit 0
fi
[ "${GITHUB_ACTIONS:-false}" != true ] || stage_only=true
if "$cleanup_old_apps" && "$stage_only"; then fail '--cleanup-old-apps requires local --install (never GitHub Actions)'; fi
command -v curl >/dev/null 2>&1 || fail 'curl is required'
case "$(uname -s)" in
  Darwin) platform=darwin; command -v plutil >/dev/null 2>&1 || fail 'plutil is required' ;;
  Linux) platform=linux; command -v jq >/dev/null 2>&1 || fail 'jq is required (install it with your Linux package manager)' ;;
  *) fail 'this installer supports macOS desktop and Linux CLI' ;;
esac
if "$cleanup_old_apps" && [ "$platform" != darwin ]; then fail '--cleanup-old-apps is only supported on macOS'; fi
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail 'unsupported architecture' ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  command -v shasum >/dev/null 2>&1 || fail 'sha256sum or shasum is required'
  checksum() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
fi
fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$1" -o "$2"; }
fetch_missing() { [ -f "$2" ] || fetch "$1" "$2"; }
json_field() {
  if [ "$platform" = darwin ]; then
    plutil -extract "$1" raw -o - "$2"
  else
    jq -er --arg field "$1" 'getpath($field | split(".") | map(tonumber? // .)) | if type == "boolean" then tostring elif type == "string" or type == "number" then . else error("expected scalar") end' "$2"
  fi
}
mkdir -p "$stage_root"
mkdir "$stage_root/.lock" 2>/dev/null || fail "another installer is running (or remove stale $stage_root/.lock after verifying it has stopped)"
stage=$(mktemp -d "$stage_root/download.XXXXXX")
replacement=
backup=
cleanup_status=not-requested
replacing=false
keep_stage=false
cleanup() {
  if "$replacing" && [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$target" ]; then
    mv "$backup" "$target" || printf 'Restore the previous app manually: %s -> %s\n' "$backup" "$target" >&2
  fi
  [ -z "$replacement" ] || rm -rf "$replacement"
  "$keep_stage" || rm -rf "$stage"
  rmdir "$stage_root/.lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$version" ]; then
  fetch "https://api.github.com/repos/$repo/releases?per_page=100" "$stage/releases.json"
  index=0
  while [ "$index" -lt 100 ]; do
    tag=$(json_field "$index.tag_name" "$stage/releases.json" 2>/dev/null) || break
    draft=$(json_field "$index.draft" "$stage/releases.json")
    candidate=${tag#v}
    if [ "$draft" = false ] && printf '%s\n' "$candidate" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$'; then
      version=$candidate; break
    fi
    index=$((index + 1))
  done
  [ -n "$version" ] || fail 'no published fork nightly found; specify --version'
fi
version=${version#v}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$' || fail 'invalid release version'
# Reuse a staged release locally, but verify its metadata, archive and app again.
cache="$stage_root/$version-$platform-$arch"
[ ! -L "$cache" ] || fail 'refusing a symlinked release cache'
if [ -d "$cache" ]; then
  rm -rf "$stage"
  stage=$cache
else
  mv "$stage" "$cache"
  stage=$cache
fi
base_url="https://github.com/$repo/releases/download/v$version"
fetch_missing "$base_url/SHA256SUMS" "$stage/SHA256SUMS"
verify() {
  expected=$(awk -v name="$1" '$2 == name || $2 == "*" name { print $1 }' "$stage/SHA256SUMS")
  printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || fail "$1 has no unique SHA256SUMS entry"
  actual=$(checksum "$stage/$1")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $1"
}
fetch_missing "$base_url/fork-release.json" "$stage/fork-release.json"
verify fork-release.json
[ "$(json_field repository "$stage/fork-release.json")" = "$repo" ] || fail 'release metadata repository does not match this fork'
[ "$(json_field version "$stage/fork-release.json")" = "$version" ] || fail 'release metadata version mismatch'
commit=$(json_field commit "$stage/fork-release.json")
printf '%s\n' "$commit" | grep -Eq '^[a-f0-9]{40}$' || fail 'release metadata has no valid source commit'

if [ "$platform" = darwin ]; then
  recognized_app() {
    [ -d "$1" ] && [ ! -L "$1" ] &&
      [ "$(plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null || true)" = com.t3tools.t3code ]
  }
  if [ -z "$target" ]; then
    if recognized_app "$system_applications/T3 Code (Nightly).app"; then
      target="$system_applications/T3 Code (Nightly).app"
    elif recognized_app "$HOME/Applications/T3 Code (Nightly).app"; then
      target="$HOME/Applications/T3 Code (Nightly).app"
    elif recognized_app "$system_applications/T3 Code (Alpha).app"; then
      target="$system_applications/T3 Code (Nightly).app"
    else
      target="$HOME/Applications/T3 Code (Nightly).app"
    fi
  fi
  case "$target" in /*.app) ;; *) fail '--target must be an absolute .app path' ;; esac
  asset="T3-Code-$version-$arch.zip"
else
  [ -z "$target" ] || fail '--target is for macOS; Linux uses T3CODE_HOME and T3CODE_INSTALL_BIN_DIR'
  target=${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}/t3
  asset="t3-$version-linux-$arch.tar.gz"
fi
fetch_missing "$base_url/$asset" "$stage/$asset"
verify "$asset"
asset_sha=$actual

if [ "$platform" = darwin ]; then
  # Reject traversal before extraction. Apple framework symlinks remain intact.
  unzip -Z1 "$stage/$asset" > "$stage/archive-paths.txt"
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$stage/archive-paths.txt"; then fail 'unsafe archive path'; fi
  rm -rf "$stage/unpacked"
  mkdir "$stage/unpacked"
  ditto -x -k "$stage/$asset" "$stage/unpacked"
  set -- "$stage/unpacked/"*.app
  [ "$#" -eq 1 ] && [ -d "$1" ] || fail 'release must contain exactly one app'
  staged_payload=$1
  info="$staged_payload/Contents/Info.plist"
  [ "$(plutil -extract CFBundleIdentifier raw -o - "$info")" = com.t3tools.t3code ] || fail 'unexpected application identity'
  [ "$(plutil -extract CFBundleShortVersionString raw -o - "$info")" = "$version" ] || fail 'application version mismatch'
  codesign --verify --deep --strict "$staged_payload" || fail 'application signature verification failed'
  check_mac_stopped() {
    # comm excludes arguments: never persist process arguments or credentials.
    processes=$(ps -axww -o comm=) || fail 'cannot inspect running apps; use --stage'
    if printf '%s\n' "$processes" | grep -F -e "$target/Contents/" -e '/T3 Code (Alpha).app/Contents/' -e '/T3 Code (Nightly).app/Contents/' >/dev/null; then
      keep_stage=true
      fail "T3 Code is running. Quit it yourself, then rerun with --install; verified files remain at $stage"
    fi
  }
  if ! "$stage_only"; then
    # Read processes only. Never quit the app or its bundled server for the user.
    check_mac_stopped
    [ ! -L "$target" ] || fail 'refusing to replace a symlinked app'
    mkdir -p "$(dirname "$target")" || fail "cannot create the app directory; choose a writable --target or ask its administrator to install this app"
    [ -w "$(dirname "$target")" ] || fail "cannot replace apps in $(dirname "$target"); use an account with permission there or choose an explicit writable --target"
    replacement=$(mktemp -d "$(dirname "$target")/.t3-install.XXXXXX")
    ditto "$staged_payload" "$replacement/application.app"
    codesign --verify --deep --strict "$replacement/application.app" || fail 'copied application signature verification failed'
    check_mac_stopped
    if [ -e "$target" ]; then
      [ -d "$target" ] || fail 'target exists and is not an app directory'
      [ "$(plutil -extract CFBundleIdentifier raw -o - "$target/Contents/Info.plist")" = com.t3tools.t3code ] || fail 'target is not a T3 Code app'
      backup="$target.previous.$(date -u +%Y%m%dT%H%M%SZ).$$"
      replacing=true
      mv "$target" "$backup"
    fi
    replacing=true
    mv "$replacement/application.app" "$target" || fail 'replacement failed; restoring previous app'
    replacing=false
    printf 'Installed %s. Open it yourself when ready.\n' "$target"
    [ -z "$backup" ] || printf 'Previous app retained at %s\n' "$backup"
    if "$cleanup_old_apps"; then
      check_mac_stopped
      cleanup_status=completed
      trash_sequence=0
      trash_app() {
        old_app=$1
        [ -d "$old_app" ] && [ "$old_app" != "$target" ] || return 0
        if [ -L "$old_app" ] || [ "$(plutil -extract CFBundleIdentifier raw -o - "$old_app/Contents/Info.plist" 2>/dev/null || true)" != com.t3tools.t3code ]; then
          cleanup_status=partial
          printf 'Left unrecognized app unchanged: %s\n' "$old_app" >&2
          return 0
        fi
        trash_sequence=$((trash_sequence + 1))
        trash_path="$HOME/.Trash/$(basename "$old_app").$(date -u +%Y%m%dT%H%M%SZ).$$.$trash_sequence"
        if mkdir -p "$HOME/.Trash" && mv "$old_app" "$trash_path"; then
          printf 'Moved previous app to Trash: %s\n' "$trash_path"
          [ "$old_app" != "$backup" ] || backup=$trash_path
        else
          cleanup_status=partial
          printf 'Could not move old app to Trash; remove it after checking permissions: %s\n' "$old_app" >&2
        fi
      }
      trash_app "$system_applications/T3 Code (Alpha).app"
      trash_app "$HOME/Applications/T3 Code (Alpha).app"
      [ -z "$backup" ] || trash_app "$backup"
    fi
  fi
else
  # Use the released installer's layout and validation, entirely inside staging.
  # Fetch the exact source commit recorded by the checksum-verified provenance.
  fetch_missing "https://raw.githubusercontent.com/$repo/$commit/scripts/install.sh" "$stage/install.sh"
  # Do not trust a cached .install-complete marker after files may have changed.
  rm -rf "$stage/cli-home" "$stage/bin"
  T3CODE_VERSION="$version" T3CODE_CHANNEL=nightly T3CODE_RELEASE_BASE_URL="https://github.com/$repo/releases/download" \
    T3CODE_HOME="$stage/cli-home" T3CODE_INSTALL_BIN_DIR="$stage/bin" sh "$stage/install.sh"
  staged_payload="$stage/cli-home/runtime/versions/$version"
  if ! "$stage_only"; then
    t3_home=${T3CODE_HOME:-$HOME/.t3}
    case "$t3_home" in /*) ;; *) fail 'T3CODE_HOME must be absolute' ;; esac
    case "$target" in /*) ;; *) fail 'T3CODE_INSTALL_BIN_DIR must be absolute' ;; esac
    [ -d /proc/self ] || fail 'cannot check for active Linux runtimes; use --stage'
    current=$(readlink -f "$target" 2>/dev/null || true)
    for executable in /proc/[0-9]*/exe; do
      running=$(readlink "$executable" 2>/dev/null || true)
      case "$running" in
        "$t3_home/runtime/"*|"$current")
          [ -n "$running" ] || continue
          keep_stage=true
          fail "the installed CLI is running; stop it yourself or use --stage. Verified files remain at $stage" ;;
      esac
    done
    destination="$t3_home/runtime/versions/$version"
    mkdir -p "$(dirname "$destination")" "$(dirname "$target")"
    if [ -e "$destination" ]; then
      [ ! -L "$destination" ] && [ -f "$destination/t3" ] || fail 'existing runtime path is not a regular version directory'
      [ "$(checksum "$destination/t3")" = "$(checksum "$staged_payload/t3")" ] || fail 'existing runtime differs from this release; leaving it unchanged'
    else
      replacement=$(mktemp -d "$(dirname "$destination")/.fork-install.XXXXXX")
      cp -R "$staged_payload/." "$replacement/"
      mv "$replacement" "$destination"
      replacement=
    fi
    # Rename the symlink atomically; never stop or restart a service.
    link_stage=$(mktemp -d "$(dirname "$target")/.t3-link.XXXXXX")
    ln -s "$destination/t3" "$link_stage/t3"
    mv -Tf "$link_stage/t3" "$target"
    rmdir "$link_stage"
    printf 'Installed %s. Start it yourself when ready.\n' "$target"
  fi
fi

status=installed
"$stage_only" && status=staged
installed_version=
installed_path=
if [ "$platform" = darwin ]; then
  for app_path in "$target" "$system_applications/T3 Code (Alpha).app" "$HOME/Applications/T3 Code (Alpha).app"; do
    if recognized_app "$app_path"; then
      installed_path=$app_path
      installed_version=$(plutil -extract CFBundleShortVersionString raw -o - "$app_path/Contents/Info.plist" 2>/dev/null || true)
      break
    fi
  done
else
  # Inspect the installed symlink/marker only; never execute a live CLI or
  # infer that a source-checkout service is using the staged runtime.
  installed_path=$(readlink -f "$target" 2>/dev/null || true)
  if [ -n "$installed_path" ] && [ -f "$installed_path" ]; then
    marker="$(dirname "$installed_path")/.install-complete"
    if [ -f "$marker" ]; then installed_version=$(cat "$marker"); fi
  else
    installed_path=
  fi
fi
if ! printf '%s\n' "$installed_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$'; then installed_version=; fi
# A nonempty JSON object keeps macOS plutil from detecting an OpenStep plist.
printf '{"schemaVersion":"1"}\n' > "$stage/receipt.json"
set -- repository "$repo" version "$version" commit "$commit" platform "$platform" arch "$arch" status "$status" \
  sha256 "$asset_sha" staged_path "$staged_payload" target "$target" installed_version "$installed_version" installed_path "$installed_path" \
  previous_app "$backup" cleanup_status "$cleanup_status" checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
while [ "$#" -gt 0 ]; do
  if [ "$platform" = darwin ]; then
    plutil -insert "$1" -string "$2" "$stage/receipt.json"
  else
    jq --arg key "$1" --arg value "$2" '. + {($key): $value}' "$stage/receipt.json" > "$stage/receipt.tmp"
    mv "$stage/receipt.tmp" "$stage/receipt.json"
  fi
  shift 2
done
cp "$stage/receipt.json" "$stage_root/.status.$$.json"
mv "$stage_root/.status.$$.json" "$stage_root/status.json"
keep_stage=true
printf 'Fork %s %s. Receipt: %s/status.json\n' "$version" "$status" "$stage_root"
printf 'Installed version: %s (running server version is not checked).\n' "${installed_version:-unknown}"
if "$stage_only"; then
  printf 'After closing the app or stopping the CLI yourself, run locally:\n'
  quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\"'\"'/g"; printf "'"; }
  printf '  curl -fsSL https://raw.githubusercontent.com/%s/nitya/release/scripts/install-fork.sh | ' "$repo"
  if [ "$platform" = linux ]; then
    printf 'T3CODE_HOME='; quote "${T3CODE_HOME:-$HOME/.t3}"
    printf ' T3CODE_INSTALL_BIN_DIR='; quote "${T3CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
    printf ' '
  fi
  printf 'sh -s -- --install --version %s --stage-dir ' "$version"
  quote "$stage_root"
  if [ "$platform" = darwin ]; then printf ' --cleanup-old-apps --target '; quote "$target"; fi
  printf '\n'
fi
