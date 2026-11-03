#!/usr/bin/env bash
# Audit technique du Mac : lecture seule, n'installe rien, ne modifie rien.
# Usage : bash scripts/audit-mac.sh
set -u

ok()   { printf "  \033[32m✔\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
ko()   { printf "  \033[31m✘\033[0m %s\n" "$1"; }

echo "=== Smart & Strong Sales Copilot — audit technique ==="
if [[ "$(uname -s)" != "Darwin" ]]; then
  ko "Ce script est prévu pour macOS (système détecté : $(uname -s))."
  exit 1
fi

OSV=$(sw_vers -productVersion)
ARCH=$(uname -m)
RAM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
CPU=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "?")
NCPU=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu)
DISK_FREE=$(df -g "$HOME" | awk 'NR==2 {print $4}')

echo
echo "Machine"
echo "  macOS $OSV · $ARCH · $CPU · ${RAM_GB} Go de RAM · ${NCPU} cœurs performance · ${DISK_FREE} Go libres"
MAJOR=${OSV%%.*}
if (( MAJOR >= 12 )); then ok "macOS ≥ 12 (requis par l'application)"; else ko "macOS 12 ou plus récent requis"; fi
if [[ "$ARCH" == "arm64" ]]; then ok "Apple Silicon : accélération Metal disponible pour Whisper"; else warn "Mac Intel : Whisper fonctionnera sur CPU (plus lent) — privilégier un petit modèle"; fi
if (( DISK_FREE < 10 )); then warn "Moins de 10 Go libres : prévoir ~2 Go (outils) + 0,5–1,5 Go (Whisper) + 2–9 Go (modèle Ollama)"; else ok "Espace disque suffisant"; fi

echo
echo "Outils"
check() { # name, command, hint
  if command -v "$2" >/dev/null 2>&1; then ok "$1 : $($2 --version 2>/dev/null | head -1)"; else ko "$1 absent — $3"; fi
}
if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools : $(xcode-select -p)"; else ko "Xcode Command Line Tools absents — xcode-select --install"; fi
check "Homebrew" brew "voir https://brew.sh (installation à faire par vous)"
check "Node.js" node "brew install node (version 20 ou plus)"
check "npm" npm "fourni avec Node.js"
check "Rust (cargo)" cargo "curl https://sh.rustup.rs -sSf | sh"
check "CMake" cmake "brew install cmake (nécessaire pour compiler whisper.cpp)"
check "Python 3 (facultatif)" python3 "non requis par l'application"
if command -v ollama >/dev/null 2>&1; then
  ok "Ollama : $(ollama --version 2>/dev/null | head -1)"
  if curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null; then
    ok "Serveur Ollama actif. Modèles installés :"
    ollama list 2>/dev/null | sed 's/^/      /'
  else
    warn "Ollama installé mais non démarré (ouvrez l'application Ollama ou lancez « ollama serve »)"
  fi
else
  ko "Ollama absent — brew install ollama (ou https://ollama.com/download)"
fi

MODELS_DIR="$HOME/Library/Application Support/fr.smartandstrong.salescopilot/models"
echo
echo "Modèles Whisper ($MODELS_DIR)"
if ls "$MODELS_DIR"/ggml-*.bin >/dev/null 2>&1; then ls -lh "$MODELS_DIR"/ggml-*.bin | awk '{print "  ✔ " $9 " (" $5 ")"}'; else warn "Aucun modèle — lancez scripts/download-models.sh"; fi

echo
echo "Recommandations pour ce Mac"
if [[ "$ARCH" == "arm64" && $RAM_GB -ge 16 ]]; then
  echo "  • Whisper : ggml-large-v3-turbo-q5_0.bin (meilleur français, rapide avec Metal)"
elif [[ "$ARCH" == "arm64" ]]; then
  echo "  • Whisper : ggml-small.bin (bon compromis pour ${RAM_GB} Go)"
else
  echo "  • Whisper : ggml-small.bin (CPU Intel) — ggml-base.bin si la latence est trop forte"
fi
if (( RAM_GB >= 32 )); then
  echo "  • Ollama : qwen2.5:14b (Apache-2.0) — ou qwen2.5:7b pour plus de réactivité"
elif (( RAM_GB >= 16 )); then
  echo "  • Ollama : qwen2.5:7b (Apache-2.0, ~4,7 Go)"
else
  echo "  • Ollama : llama3.2:3b (licence Llama 3.2 Community) ou qwen2.5:1.5b (Apache-2.0, plus faible)"
  echo "    Avec ${RAM_GB} Go, l'IA locale peut ralentir la transcription : le mode « règles seules » reste disponible."
fi
echo
echo "Audit terminé. Rien n'a été installé ni modifié."
