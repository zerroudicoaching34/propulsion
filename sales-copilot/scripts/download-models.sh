#!/usr/bin/env bash
# Télécharge le modèle Whisper (whisper.cpp, licence MIT) et, si Ollama est présent, le modèle d'IA locale.
# Usage : bash scripts/download-models.sh [small|turbo|medium|base] [modele-ollama]
# Après ce téléchargement, l'application fonctionne hors ligne.
set -euo pipefail

ARCH=$(uname -m)
RAM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
CHOICE=${1:-}
if [[ -z "$CHOICE" ]]; then
  if [[ "$ARCH" == "arm64" && $RAM_GB -ge 16 ]]; then CHOICE=turbo; else CHOICE=small; fi
fi
case "$CHOICE" in
  base)   FILE=ggml-base.bin ;;
  small)  FILE=ggml-small.bin ;;
  medium) FILE=ggml-medium.bin ;;
  turbo)  FILE=ggml-large-v3-turbo-q5_0.bin ;;
  *) echo "Modèle inconnu : $CHOICE (base|small|medium|turbo)"; exit 1 ;;
esac

APP_DIR="$HOME/Library/Application Support/fr.smartandstrong.salescopilot"
DIR="$APP_DIR/models"
mkdir -p "$DIR"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$FILE"
if [[ -f "$DIR/$FILE" ]]; then
  echo "Déjà présent : $DIR/$FILE"
else
  echo "Téléchargement de $FILE depuis $URL …"
  curl -L --fail --progress-bar -o "$DIR/$FILE.part" "$URL"
  mv "$DIR/$FILE.part" "$DIR/$FILE"
fi
SIZE=$(stat -f%z "$DIR/$FILE")
if (( SIZE < 50000000 )); then echo "Fichier anormalement petit ($SIZE octets) : téléchargement incomplet ?"; exit 1; fi
echo "Empreinte SHA-256 (à comparer avec la page du modèle sur huggingface.co/ggerganov/whisper.cpp) :"
shasum -a 256 "$DIR/$FILE"

# First launch: pre-fill the model path through config.json (ignored once settings exist).
if [[ ! -f "$APP_DIR/copilot.db" && ! -f "$APP_DIR/config.json" ]]; then
  sed "s#\"whisperModelPath\": \"\"#\"whisperModelPath\": \"$DIR/$FILE\"#" "$(dirname "$0")/../config.example.json" > "$APP_DIR/config.json"
  echo "config.json créé : le chemin du modèle sera pris en compte au premier lancement."
else
  echo "Dans l'application : Réglages → IA locale & transcription → Fichier du modèle Whisper :"
  echo "  $DIR/$FILE"
fi

OLLAMA_MODEL=${2:-}
if [[ -z "$OLLAMA_MODEL" ]]; then
  if (( RAM_GB >= 16 )); then OLLAMA_MODEL="qwen2.5:7b"; else OLLAMA_MODEL="llama3.2:3b"; fi
fi
if command -v ollama >/dev/null 2>&1; then
  echo "Téléchargement du modèle Ollama $OLLAMA_MODEL (vérifiez sa licence : voir docs/LICENSES.md)…"
  ollama pull "$OLLAMA_MODEL"
  echo "Si différent du modèle par défaut, indiquez « $OLLAMA_MODEL » dans Réglages → IA locale."
else
  echo "Ollama absent : étape IA locale ignorée (l'application fonctionnera en mode « règles seules »)."
fi
