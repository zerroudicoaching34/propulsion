# Smart & Strong — Studio d'anatomie

Transforme une photo en visuel anatomique pédagogique : **squelette** d'un côté, **muscles** de l'autre, puis
anime l'identification des muscles (surbrillance, flèche, nom, rôle, exercice associé).

Livrables générés dans `out/` :

| Fichier | Contenu |
|---|---|
| `anatomie-legendee.png` | Image haute résolution, tous les muscles visibles légendés |
| `anatomie-muscles.gif` | Boucle 8,6 s, 720 px, muscles présentés un par un |
| `anatomie-du-mouvement.mp4` | Reel 1080×1920, 30 fps, 34 s : photo → squelette / muscles, 3 muscles détaillés avec démonstration d'exercice, 7 muscles en présentation rapide, conclusion |

## Utilisation

```bash
pip install pillow numpy pyyaml          # + ffmpeg et la police Montserrat
python3 -m anatomy all                   # image légendée + GIF + MP4
python3 -m anatomy still | gif | mp4     # un seul livrable
```

## Bibliothèque (config/muscles.yaml)

- 11 muscles : nom, fonction, exercice associé.
- 11 exercices : nom et, si disponible, clip de démonstration (`assets/clips/…`).
- `video.featured` / `video.quick` : déroulé de la vidéo ; `gif.sequence` : ordre du GIF.
- `style` : palette (anthracite, ivoire, rouge de surbrillance, turquoise), signature, mention.

Les exercices sont des **exemples de sollicitation** : ils n'isolent jamais un muscle à 100 %. Aucune valeur
d'activation n'est affichée.

## Remplacer la photo

1. **Générer l'image anatomique** à partir de la nouvelle photo avec les prompts de `config/prompts.yaml`
   (Higgsfield, `gpt_image_2_6`, haute qualité 2K, photo en référence). Une version squelette, une version muscles.
2. **Assembler** : `python3 -m anatomy compose --skeleton squelette.png --muscles muscles.png [--mirror-muscles]`
3. **Tracer les zones musculaires** : copier `config/photo_zach.yaml`, générer une grille de repérage
   (`python3 -m anatomy grid --x0 … --y0 …`), relever les polygones de chaque muscle, puis vérifier avec
   `python3 -m anatomy check`.
4. **Rendre** : `python3 -m anatomy all --photo-config config/ma_photo.yaml`.

Les photos et images générées restent dans `assets/` (ignoré par Git) : elles ne sont pas publiées dans le dépôt.

## Démonstrations d'exercices

Clips générés avec le coach Smart & Strong (Kling 3.0, 5 s, environ 7,5 crédits Higgsfield par clip).
Disponibles : élévation latérale, développé couché, crunch. Pour en ajouter un : générer le clip, le placer
dans `assets/clips/` et renseigner `clip:` dans `config/muscles.yaml`.

## Limites

- Squelette et muscles sont **générés par IA** à partir d'une seule photo : une photo ne permet pas de
  reconstruire les structures internes réelles. Les formes sont des approximations à valider par un professionnel.
- Les zones de surbrillance sont tracées à la main sur l'image générée.
- Muscles non visibles dans la pose (ex. deltoïde postérieur de face) : pas de zone, seulement une fiche.
- Blender et Remotion n'ont pas été utilisés : aucun modèle anatomique 3D libre de droits n'était disponible
  dans cet environnement, et le rendu image par image en Python suffit pour ce format.
