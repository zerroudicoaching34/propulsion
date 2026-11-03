#!/usr/bin/env bash
# Construit l'application macOS (.app et .dmg, non signés) dans src-tauri/target/release/bundle/.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
npm test
if [[ "$(uname -m)" == "arm64" ]]; then
  if ! npx tauri build --features metal; then
    echo "Échec de la compilation avec Metal : nouvelle tentative sur CPU (Accelerate)…"
    npx tauri build
  fi
else
  npx tauri build
fi
echo
echo "Application : src-tauri/target/release/bundle/macos/Smart & Strong Copilot.app"
echo "Image disque : src-tauri/target/release/bundle/dmg/"
echo "L'application n'est pas signée : au premier lancement, clic droit → Ouvrir (ou Réglages Système → Confidentialité et sécurité → Ouvrir quand même)."
