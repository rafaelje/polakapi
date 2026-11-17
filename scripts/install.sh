#!/bin/sh
set -eu

OWNER=rafaelje/polakapi
LATEST_URL="https://github.com/$OWNER/releases/latest/download/release-version.txt"
DEFAULT_INSTALL_DIR=
SOURCE=
VERSION=
INSTALL_DIR=
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

fail() { printf 'polakapi installer: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: install.sh [--source URL] [--version VERSION] [--install-dir DIR] [--help]

Install polakapi for the current user from the latest stable release, or from a
versioned release directory. A source directory must contain manifest.tsv,
release-version.txt, and the package assets.

Options:
  --source URL       Use a complete HTTPS release directory (loopback HTTP is allowed for tests)
  --version VERSION  Install exactly VERSION; skips latest-version lookup
  --install-dir DIR  macOS app parent or Linux application directory
  --help             Show this help
USAGE
}

valid_version() { printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; }
valid_source() {
  case "$1" in *'@'*|*'?'*|*'#'*|*'\\'*) return 1;; esac
  printf '%s' "$1" | grep -q '[[:space:]]' && return 1
  case "$1" in
    https://*) remainder=${1#https://}; authority=${remainder%%/*}
      printf '%s\n' "$authority" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?$' || return 1
      case "$authority" in *:*) port=${authority##*:}; case "$port" in ''|*[!0-9]*) return 1;; esac; [ "$port" -le 65535 ] && [ "$port" -gt 0 ] || return 1;; esac ;;
    http://*) remainder=${1#http://}; authority=${remainder%%/*}
      case "$authority" in localhost|localhost:[0-9]*|127.0.0.1|127.0.0.1:[0-9]*|\[::1\]|\[::1\]:[0-9]*) ;;
        *) return 1;;
      esac
      case "$authority" in *:*) port=${authority##*:}; case "$port" in ''|*[!0-9]*) return 1;; esac; [ "$port" -le 65535 ] && [ "$port" -gt 0 ] || return 1;; esac ;;
    *) return 1 ;;
  esac
  return 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --source|--version|--install-dir)
      option=$1
      [ "$#" -ge 2 ] || fail "missing value for $option"
      [ -n "$2" ] || fail "missing value for $option"
      case "$option" in
        --source) SOURCE=$2 ;;
        --version) VERSION=$2 ;;
        --install-dir) INSTALL_DIR=$2 ;;
      esac
      shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

if [ -n "$VERSION" ]; then valid_version "$VERSION" || fail "invalid version: $VERSION"; fi
if [ -n "$SOURCE" ]; then valid_source "$SOURCE" || fail "source must be HTTPS or explicit loopback HTTP"; fi

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux*)
    [ -r /proc/version ] && grep -qi microsoft /proc/version && fail "WSL is not supported; use the native Windows installer from PowerShell."
    PLATFORM=linux
    ARCH=$(uname -m)
    case "$ARCH" in x86_64|amd64) ARCH=x64;; *) fail "unsupported Linux architecture: $ARCH";; esac
    DEFAULT_INSTALL_DIR=${HOME:?HOME must be set}/.local/opt/polakapi
    ;;
  Darwin*)
    PLATFORM=macos
    ARCH=$(uname -m)
    case "$ARCH" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) fail "unsupported macOS architecture: $ARCH";; esac
    DEFAULT_INSTALL_DIR=${HOME:?HOME must be set}/Applications
    ;;
  MINGW*|MSYS*|CYGWIN*)
    powershell=$(command -v powershell.exe 2>/dev/null || true)
    [ -n "$powershell" ] || fail "PowerShell is required in Git Bash."
    cygpath=$(command -v cygpath 2>/dev/null || true)
    [ -n "$cygpath" ] || fail "cygpath is required in Git Bash."
    PLATFORM=windows
    ARCH=any
    ;;
  *) fail "unsupported operating system: $(uname -s 2>/dev/null || echo unknown)" ;;
esac

[ "$PLATFORM" = windows ] || { [ -n "$INSTALL_DIR" ] || INSTALL_DIR=$DEFAULT_INSTALL_DIR; case "$INSTALL_DIR" in /*) ;; *) fail "install directory must be an absolute path";; esac; }

work=$(mktemp -d "${TMPDIR:-/tmp}/polakapi-install.XXXXXX") || fail "could not create temporary directory"
mount_dir=
stage_dir=
backup_path=
replacement_target=
aux_stage1=
aux_stage2=
cleanup() {
  if [ -n "$mount_dir" ]; then hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || :; fi
  if [ -n "$backup_path" ] && [ -e "$backup_path" ] && [ -n "$replacement_target" ]; then
    if [ ! -e "$replacement_target" ]; then mv "$backup_path" "$replacement_target" 2>/dev/null || :; fi
    if [ -e "$backup_path" ]; then
      printf 'Previous installation retained for recovery at %s\n' "$backup_path" >&2
      stage_dir=
    fi
  fi
  [ -z "$stage_dir" ] || rm -rf "$stage_dir"
  [ -z "$aux_stage1" ] || rm -rf "$aux_stage1"
  [ -z "$aux_stage2" ] || rm -rf "$aux_stage2"
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ -n "$SOURCE" ]; then
  RELEASE=$SOURCE
  if [ -z "$VERSION" ]; then
    curl --fail --silent --show-error --location --max-time 60 --connect-timeout 10 --max-redirs 5 --proto '=https,http' --proto-redir '=https' "$RELEASE/release-version.txt" -o "$work/latest-version"
    VERSION=$(cat "$work/latest-version")
  fi
else
  if [ -z "$VERSION" ]; then
    curl --fail --silent --show-error --location --max-time 60 --connect-timeout 10 --max-redirs 5 --proto '=https' --proto-redir '=https' "$LATEST_URL" -o "$work/latest-version"
    VERSION=$(cat "$work/latest-version")
  fi
  valid_version "$VERSION" || fail "release returned an invalid version"
  RELEASE="https://github.com/$OWNER/releases/download/v$VERSION"
fi
valid_version "$VERSION" || fail "invalid version in release-version.txt"
curl --fail --silent --show-error --location --max-time 60 --connect-timeout 10 --max-redirs 5 --proto '=https,http' --proto-redir '=https' "$RELEASE/manifest.tsv" -o "$work/manifest.tsv" || fail "could not download release manifest"

selected_file=
selected_hash=
selected_version=
if ! awk -F '\t' -v want_version="$VERSION" -v want_platform="$PLATFORM" -v want_arch="$ARCH" '
  NR == 1 { if ($0 != "version\tplatform\tarch\tfile\tsha256") exit 2; next }
  {
    if (NF != 5 || $1 !~ /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ ||
        $2 !~ /^(macos|linux|windows)$/ || $3 !~ /^(universal|arm64|x64|any)$/ ||
        $4 !~ /^[A-Za-z0-9._-]+$/ || $4 == "." || $4 == ".." || length($5) != 64 || $5 !~ /^[0-9a-f]+$/) exit 2
    if (NR == 2) manifest_version = $1
    if ($1 != manifest_version) exit 2
    key = $2 "/" $3
    if (seen[key]++) exit 2
    if ($2 == "windows" && !(($3 == "any" && $4 == "install.ps1") || ($3 == "x64" && $4 ~ /\.exe$/))) exit 2
    if ($2 != "windows" && $3 == "any") exit 2
    if ($2 == "linux" && $4 !~ /\.AppImage$/) exit 2
    if ($2 == "macos" && $4 !~ /\.dmg$/) exit 2
    if ($1 == want_version && $2 == want_platform && ($3 == want_arch || $3 == "universal")) {
      if (selected != "" && $3 == "universal") next
      if (selected == "" || $3 == want_arch) { selected = $4; digest = $5; chosen_version = $1 }
    }
  }
  END {
    if (NR < 2 || manifest_version != want_version || selected == "") exit 2
    printf "%s\t%s\t%s\n", selected, digest, chosen_version
  }
' "$work/manifest.tsv" > "$work/selection"; then
  fail "release manifest is invalid or has no package for $PLATFORM/$ARCH"
fi
IFS="$(printf '\t')" read -r selected_file selected_hash selected_version < "$work/selection"
case "$selected_file" in */*|*..*) fail "unsafe package filename in manifest";; esac
curl --fail --silent --show-error --location --max-time 60 --connect-timeout 10 --max-redirs 5 --proto '=https,http' --proto-redir '=https' "$RELEASE/$selected_file" -o "$work/$selected_file" || fail "could not download $selected_file"
if command -v shasum >/dev/null 2>&1; then actual_hash=$(shasum -a 256 "$work/$selected_file" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then actual_hash=$(sha256sum "$work/$selected_file" | awk '{print $1}')
else fail "shasum or sha256sum is required"; fi
[ "$actual_hash" = "$selected_hash" ] || fail "checksum verification failed for $selected_file"

if [ "$PLATFORM" = windows ]; then
  ps_script=$($cygpath -w "$work/$selected_file") || fail "could not translate the verified PowerShell installer path"
  set -- -NoProfile -File "$ps_script" -Source "$RELEASE" -Version "$VERSION"
  if [ -n "$INSTALL_DIR" ]; then
    win_install_dir=$($cygpath -w "$INSTALL_DIR") || fail "could not translate install directory"
    set -- "$@" -InstallDir "$win_install_dir"
  fi
  "$powershell" "$@" || exit $?
  exit 0
fi

if [ "$PLATFORM" = linux ]; then
  command -v pgrep >/dev/null 2>&1 && pgrep -x polakapi >/dev/null 2>&1 && fail "polakapi is running; close it before reinstalling."
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    fail "Linux AppImage requires FUSE 2 (libfuse.so.2); install your distribution's libfuse2 package, then retry."
  fi
  mkdir -p "$INSTALL_DIR"
  app_target="$INSTALL_DIR/polakapi.AppImage"
  if [ -d "$app_target" ]; then fail "refusing to replace a directory at $app_target"; fi
  bin_home=${XDG_BIN_HOME:-${HOME:?HOME must be set}/.local/bin}
  data_home=${XDG_DATA_HOME:-${HOME:?HOME must be set}/.local/share}
  [ ! -d "$bin_home/polakapi" ] || fail "launcher destination is a directory: $bin_home/polakapi"
  [ ! -d "$data_home/applications/polakapi.desktop" ] || fail "desktop entry destination is a directory"
  mkdir -p "$bin_home" "$data_home/applications"
  stage_dir=$(mktemp -d "$INSTALL_DIR/.polakapi-stage.XXXXXX") || fail "could not create same-filesystem staging directory"
  stage="$stage_dir/polakapi.AppImage"
  backup_path="$stage_dir/previous.AppImage"
  replacement_target=$app_target
  cp "$work/$selected_file" "$stage" || fail "could not stage AppImage"
  chmod 755 "$stage"
  had_previous=no
  if [ -e "$app_target" ] || [ -L "$app_target" ]; then mv "$app_target" "$backup_path"; had_previous=yes; fi
  if ! mv "$stage" "$app_target"; then
    if [ "$had_previous" = yes ]; then mv "$backup_path" "$app_target"; backup_path=; fi
    fail "could not activate staged installation"
  fi
  [ "$had_previous" = no ] || rm -f "$backup_path"
  backup_path=
  replacement_target=
  aux_stage1=$(mktemp -d "$bin_home/.polakapi-launcher.XXXXXX") || fail "could not stage launcher"
  ln -s "$app_target" "$aux_stage1/polakapi"
  mv -f "$aux_stage1/polakapi" "$bin_home/polakapi" || fail "could not activate launcher"
  rm -rf "$aux_stage1"
  aux_stage1=
  aux_stage2=$(mktemp -d "$data_home/applications/.polakapi-desktop.XXXXXX") || fail "could not stage desktop entry"
  desktop_exec=$(printf '%s' "$app_target" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g; s/%/%%/g')
  printf '[Desktop Entry]\nType=Application\nName=polakapi\nExec="%s"\nTerminal=false\nCategories=Development;\n' "$desktop_exec" > "$aux_stage2/polakapi.desktop"
  mv -f "$aux_stage2/polakapi.desktop" "$data_home/applications/polakapi.desktop" || fail "could not activate desktop entry"
  rm -rf "$aux_stage2"
  aux_stage2=
  rm -rf "$stage_dir"
  stage_dir=
elif [ "$PLATFORM" = macos ]; then
  executable="$INSTALL_DIR/polakapi.app/Contents/MacOS/polakapi"
  escaped_executable=$(printf '%s' "$executable" | sed 's/[][\\.^$*+?(){}|]/\\&/g')
  command -v pgrep >/dev/null 2>&1 && pgrep -f "$escaped_executable" >/dev/null 2>&1 && fail "polakapi is running from $INSTALL_DIR; close it before reinstalling."
  [ "${selected_file##*.}" = dmg ] || fail "macOS package must be a DMG"
  mount_dir="$work/mount"
  mkdir "$mount_dir"
  hdiutil attach "$work/$selected_file" -readonly -nobrowse -mountpoint "$mount_dir" >/dev/null || fail "could not mount application disk image"
  app=$(find "$mount_dir" -name polakapi.app -type d -print | head -n 1)
  [ -n "$app" ] || fail "disk image does not contain polakapi.app"
  codesign --verify --deep --strict "$app" >/dev/null || fail "application signature verification failed"
  mkdir -p "$INSTALL_DIR"
  [ ! -L "$INSTALL_DIR/polakapi.app" ] || fail "refusing to replace a symlink at $INSTALL_DIR/polakapi.app"
  if [ -e "$INSTALL_DIR/polakapi.app" ] && [ ! -d "$INSTALL_DIR/polakapi.app" ]; then
    fail "existing macOS application is not an app directory"
  fi
  stage_dir=$(mktemp -d "$INSTALL_DIR/.polakapi-stage.XXXXXX") || fail "could not create same-filesystem staging directory"
  stage="$stage_dir/polakapi.app"
  backup_path="$stage_dir/previous.app"
  replacement_target="$INSTALL_DIR/polakapi.app"
  ditto "$app" "$stage" || fail "could not stage application"
  had_previous=no
  if [ -e "$replacement_target" ] || [ -L "$replacement_target" ]; then mv "$replacement_target" "$backup_path"; had_previous=yes; fi
  if ! mv "$stage" "$replacement_target"; then
    if [ "$had_previous" = yes ]; then mv "$backup_path" "$replacement_target"; backup_path=; fi
    fail "could not activate staged application"
  fi
  [ "$had_previous" = no ] || rm -rf "$backup_path"
  backup_path=
  replacement_target=
  rm -rf "$stage_dir"
  stage_dir=
fi
printf 'Installed polakapi %s in %s\n' "$VERSION" "$INSTALL_DIR"
