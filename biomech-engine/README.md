# Smart & Strong — Moteur de vidéos biomécaniques

Transforme une vidéo réelle de musculation en Reel pédagogique 9:16 (1080 × 1920, 30 fps) : vidéo conservée et assombrie,
articulations suivies automatiquement, angles, trajectoires, phases concentrique / excentrique, muscles colorés attachés
au corps, encarts anatomiques stylisés, cartouches et textes synchronisés.

Premier exercice réalisé : **élévations latérales** (`config/exercises/elevations_laterales.yaml`).

## Installation

```bash
cd biomech-engine
pip install -r requirements.txt          # MediaPipe, OpenCV, NumPy, Pillow, PyYAML
bash scripts/download_models.sh          # modèles MediaPipe Pose (≈ 40 Mo)
# FFmpeg et la police Montserrat doivent être installés (macOS : brew install ffmpeg ; police : fonts.google.com/specimen/Montserrat)
```

## Utilisation

```bash
# 1. Analyse : suivi des articulations + répétitions + phases
python3 -m biomech analyse --video ma_video.mov --exercise elevations_laterales --project projects/mon-reel

# 2. Aperçus (images PNG) pour vérifier avant le rendu
python3 -m biomech preview --project projects/mon-reel --times 1,5,9,14,20

# 3. Rendu MP4
python3 -m biomech render --project projects/mon-reel                 # sans son
python3 -m biomech render --project projects/mon-reel --audio voix.wav # avec voix off / musique

# Tout en une commande
python3 -m biomech run --video ma_video.mov --exercise elevations_laterales --project projects/mon-reel
```

Chaque projet contient : `project.yaml` (vidéo + exercice), `tracking.json` (repères lissés), `analysis.json`
(répétitions et angles), `corrections.yaml` (corrections manuelles), `previews/`, `output.mp4`.

## Corrections manuelles

Si un repère dévie (bras masqué, haltère devant le poignet…), ouvrez `projects/<nom>/corrections.yaml` :

```yaml
- {landmark: left_wrist, time: 3.40, x: 512, y: 380}   # position correcte en pixels de la vidéo source
- {landmark: left_wrist, time: 3.70, x: 530, y: 360}   # deux points proches : la correction est interpolée entre eux
```

Relancez `preview` puis `render` : les corrections sont appliquées sans refaire l'analyse.

## Créer un nouvel exercice

Copiez `config/exercises/_modele.yaml`, puis renseignez :

- **les métriques** (abduction de l'épaule, flexion du genou, de la hanche, du coude, inclinaison du tronc) et le signal
  qui découpe les répétitions ;
- **les muscles** : couleur, rôle, superficiel / profond, forme dans un repère attaché au corps ;
- **le storyboard** : scènes, répétition utilisée, durée cible, calques visibles, textes et notes synchronisées.

Voir [docs/CONFIG.md](docs/CONFIG.md) pour le détail et [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour le fonctionnement.

## Bonnes pratiques de tournage

Caméra fixe, plan du mouvement parallèle à la caméra (de face pour les élévations latérales, de profil pour squat,
développé couché, rowing, soulevé de terre, fentes), corps entier dans le cadre, 4 à 8 répétitions lentes, articulations
visibles, lumière correcte.

## Limites (à connaître)

- Les angles sont des **estimations 2D** : fiables quand le mouvement est parallèle au plan de la caméra.
- Les muscles dessinés sont des **schémas anatomiques** placés sur le corps ; ils ne mesurent aucune activation
  (pas d'EMG, aucun pourcentage). Les muscles profonds sont tracés en pointillés et signalés « (profond) ».
- Le repère « haltère » est estimé à partir de la main (pas de détection d'objet dédiée).
- Le rythme scapulo-huméral de l'encart est une valeur théorique (≈ 2:1), pas une mesure de la scapula filmée.

## Tests

```bash
python3 tests/test_engine.py
```
