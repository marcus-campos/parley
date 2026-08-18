#!/bin/sh
# parley installer — https://github.com/marcus-campos/parley
#
#   curl -fsSL https://raw.githubusercontent.com/marcus-campos/parley/main/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/marcus-campos/parley/main/install.sh | sh
#
# Environment overrides:
#   PARLEY_VERSION      tag to install (default: latest)
#   PARLEY_INSTALL_DIR  where to put the binary (default: first writable of
#                       /usr/local/bin, $HOME/.local/bin)
#
# POSIX sh on purpose: this has to run on a minimal container, a fresh mac and
# Git Bash on Windows without assuming bash, curl-vs-wget, or GNU coreutils.

set -eu

REPO="marcus-campos/parley"
BIN="parley"
VERSION="${PARLEY_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
err() { printf 'parley installer: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- platform ---
os_raw="$(uname -s)"
case "$os_raw" in
  Linux)                  OS="linux"   ;;
  Darwin)                 OS="darwin"  ;;
  MINGW*|MSYS*|CYGWIN*)   OS="windows" ;;
  *) err "unsupported operating system: $os_raw
   Build from source instead: https://github.com/$REPO#build-from-source" ;;
esac

arch_raw="$(uname -m)"
case "$arch_raw" in
  x86_64|amd64)           ARCH="x64"   ;;
  arm64|aarch64)          ARCH="arm64" ;;
  *) err "unsupported architecture: $arch_raw
   Build from source instead: https://github.com/$REPO#build-from-source" ;;
esac

if [ "$OS" = "windows" ] && [ "$ARCH" = "arm64" ]; then
  err "Windows on arm64 has no prebuilt binary, because Bun cannot cross-compile
   to it yet. Build from source, or run the x64 binary under emulation."
fi

ASSET="${BIN}-${OS}-${ARCH}"
[ "$OS" = "windows" ] && ASSET="${ASSET}.exe"

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi

# ---------------------------------------------------------------- download ---
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  err "neither curl nor wget is available"
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t parley)"
# shellcheck disable=SC2064
trap "rm -rf '$TMP'" EXIT INT TERM

say "parley: downloading ${ASSET} (${VERSION})"
fetch "${BASE}/${ASSET}" "${TMP}/${ASSET}" \
  || err "download failed: ${BASE}/${ASSET}
   Check that the release exists: https://github.com/${REPO}/releases"

# ------------------------------------------------------------------ verify ---
# A checksum that is fetched over the same channel as the binary is not a
# security boundary; it catches a truncated or corrupted download, which is the
# failure this actually prevents.
if fetch "${BASE}/${ASSET}.sha256" "${TMP}/${ASSET}.sha256" 2>/dev/null; then
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$TMP" && sha256sum -c "${ASSET}.sha256" >/dev/null 2>&1 ) \
      && say "parley: checksum ok" \
      || err "checksum mismatch — refusing to install a corrupted binary"
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$TMP" && shasum -a 256 -c "${ASSET}.sha256" >/dev/null 2>&1 ) \
      && say "parley: checksum ok" \
      || err "checksum mismatch — refusing to install a corrupted binary"
  else
    say "parley: no sha256 tool found, skipping checksum verification"
  fi
else
  say "parley: no published checksum for this asset, skipping verification"
fi

chmod +x "${TMP}/${ASSET}"

# ----------------------------------------------------------------- install ---
TARGET_NAME="$BIN"
[ "$OS" = "windows" ] && TARGET_NAME="${BIN}.exe"

if [ -n "${PARLEY_INSTALL_DIR:-}" ]; then
  DIR="$PARLEY_INSTALL_DIR"
  mkdir -p "$DIR" || err "cannot create $DIR"
  [ -w "$DIR" ] || err "$DIR is not writable"
else
  DIR=""
  for candidate in /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then DIR="$candidate"; break; fi
  done
  if [ -z "$DIR" ]; then
    DIR="$HOME/.local/bin"
    mkdir -p "$DIR" || err "cannot create $DIR"
  fi
fi

mv "${TMP}/${ASSET}" "${DIR}/${TARGET_NAME}" \
  || err "could not write to ${DIR}
   Try:  PARLEY_INSTALL_DIR=\"\$HOME/.local/bin\" sh install.sh
   Or:   sudo mv ${TMP}/${ASSET} /usr/local/bin/${TARGET_NAME}"

say "parley: installed to ${DIR}/${TARGET_NAME}"

# ------------------------------------------------------------------- check ---
case ":${PATH}:" in
  *":${DIR}:"*) ;;
  *)
    say ""
    say "parley: ${DIR} is not on your PATH. Add it:"
    say ""
    say "  echo 'export PATH=\"${DIR}:\$PATH\"' >> ~/.profile"
    say "  # zsh users: ~/.zshrc   fish users: fish_add_path ${DIR}"
    say ""
    ;;
esac

"${DIR}/${TARGET_NAME}" --help >/dev/null 2>&1 \
  && say "parley: ready. Run 'parley doctor' inside a git repository to verify." \
  || say "parley: installed, but the binary did not run. Report this at https://github.com/${REPO}/issues"
