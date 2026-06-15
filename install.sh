#!/usr/bin/env bash
# Build housekeeper into a standalone binary and install it on your PATH.
set -euo pipefail

cd "$(dirname "$0")"

PREFIX="${PREFIX:-$HOME/.local/bin}"

command -v bun >/dev/null 2>&1 || { echo "error: bun is not installed (https://bun.sh)"; exit 1; }

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
