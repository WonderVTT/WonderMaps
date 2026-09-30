#!/usr/bin/env bash
# Sync this working copy into the module folder Foundry actually loads.
# Run after every change:  ./install.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${FOUNDRY_MODULES:-$HOME/.local/share/FoundryVTT/Data/modules}/wondermaps"

mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'install.sh' \
  "$SRC"/ "$DEST"/

echo "WonderMaps installed to $DEST"
