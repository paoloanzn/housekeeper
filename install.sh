#!/usr/bin/env bash
# Build housekeeper into a standalone binary and install it on your PATH.
#
#   local:  ./install.sh
#   remote: curl -fsSL https://raw.githubusercontent.com/paoloanzn/housekeeper/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/paoloanzn/housekeeper.git"
PREFIX="${PREFIX:-$HOME/.local/bin}"

command -v bun >/dev/null 2>&1 || { echo "error: bun is not installed (https://bun.sh)"; exit 1; }

# Build from a local checkout if present, otherwise clone a temp copy (curl | bash).
if [ -f "$(dirname "$0")/index.ts" ]; then
  cd "$(dirname "$0")"
else
  command -v git >/dev/null 2>&1 || { echo "error: git is required for remote install"; exit 1; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Cloning $REPO..."
  git clone --depth 1 "$REPO" "$tmp" >/dev/null 2>&1
  cd "$tmp"
fi

echo "Building..."
bun build --compile index.ts --outfile dist/housekeeper

mkdir -p "$PREFIX"
install -m 0755 dist/housekeeper "$PREFIX/housekeeper"
ln -sf "$PREFIX/housekeeper" "$PREFIX/hsk"

echo "Installed: $PREFIX/housekeeper (and 'hsk')"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "Note: add $PREFIX to your PATH, e.g. echo 'export PATH=\"$PREFIX:\$PATH\"' >> ~/.zshrc" ;;
esac
