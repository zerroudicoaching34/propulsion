#!/usr/bin/env bash
# Installe les prérequis manquants, en demandant votre accord avant chaque installation.
# Usage : bash scripts/setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

confirm() { read -r -p "$1 [o/N] " r; [[ "$r" =~ ^[oOyY]$ ]]; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS requis."; exit 1; }

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Les Xcode Command Line Tools sont nécessaires (compilateur)."
  if confirm "Lancer leur installation (fenêtre Apple) ?"; then xcode-select --install || true; echo "Relancez ce script une fois l'installation terminée."; exit 0; fi
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew est absent. Installez-le depuis https://brew.sh puis relancez ce script."
  exit 1
fi

for pkg in node cmake; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    confirm "Installer $pkg avec Homebrew ?" && brew install "$pkg"
  fi
done

if ! command -v cargo >/dev/null 2>&1; then
  if confirm "Installer Rust (rustup, installation dans votre dossier personnel) ?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  else
    exit 1
  fi
fi

if ! command -v ollama >/dev/null 2>&1; then
  confirm "Installer Ollama (IA locale) avec Homebrew ?" && brew install ollama || echo "Ollama non installé : l'application fonctionnera en mode « règles seules »."
fi

echo "Installation des dépendances JavaScript (npm ci)…"
npm ci

echo
echo "Prérequis prêts. Étapes suivantes :"
echo "  1. bash scripts/download-models.sh   (modèle Whisper + modèle Ollama)"
echo "  2. bash scripts/dev.sh               (lancer l'application en mode développement)"
echo "     ou bash scripts/build-mac.sh      (construire l'application .app / .dmg)"
