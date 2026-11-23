#!/usr/bin/env bash
# Télécharge les modèles MediaPipe Pose Landmarker (Google, licence Apache-2.0).
set -euo pipefail
cd "$(dirname "$0")/../models"
BASE=https://storage.googleapis.com/mediapipe-models/pose_landmarker
for v in heavy full; do
  f=pose_landmarker_${v}.task
  [[ -f $f ]] || curl -L --fail -o "$f" "$BASE/pose_landmarker_${v}/float16/latest/$f"
  echo "ok: models/$f ($(du -h "$f" | cut -f1))"
done
