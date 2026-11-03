#!/usr/bin/env bash
# Lance l'application en mode développement (rechargement à chaud de l'interface).
# En mode développement, macOS demande l'accès au micro pour l'application Terminal (ou iTerm).
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d node_modules ]] || npm ci
FEATURES=""
[[ "$(uname -m)" == "arm64" ]] && FEATURES="--features metal"
# shellcheck disable=SC2086
npx tauri dev $FEATURES
