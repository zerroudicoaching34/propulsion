# Fichier d'exercice (YAML)

Un exercice = un fichier dans `config/exercises/`. Sections :

## meta
`title`, `subtitle`, `signature`, `disclaimer` : textes affichés.

## tracking (facultatif)
`min_visibility` (0.3), `min_cutoff` (1.2) et `beta` (0.02) : lissage One-Euro. Plus `min_cutoff` est bas, plus c'est lisse
(mais plus de retard).

## analysis
- `sides` : `[left, right]` (côtés du **sportif**).
- `metrics` : parmi `shoulder_abduction`, `elbow_flexion`, `knee_flexion`, `hip_flexion`, `trunk_lean`.
- `driver` : métrique qui découpe les répétitions (vallée → pic → vallée). Pour un squat, `knee_flexion`.
- `min_rep_range` : amplitude minimale (°) d'une répétition.
- `lever` : `{joint, load}` pour le bras de levier externe (distance horizontale articulation → charge).

## overlays
`angle_metric`, `angle_label`, `trajectory_points` (ex. `[hand]`), `scapula_inset`, `scapulohumeral`.

## muscles
```yaml
- id: deltoide_moyen
  label: "DELTOÏDE MOYEN"
  role: "Moteur principal de l'élévation"
  color: [240, 104, 88]
  depth: surface        # surface | deep (pointillés, « profond ») | inset_only (seulement dans un encart)
  anchor: upper_arm     # repère de la forme
  hatch_angle: 0        # orientation des hachures (fibres) par rapport à l'axe du repère
  shape: [[x, y], ...]  # polygone lissé ; un point peut changer de repère : ["trunk", x, y]
  label_col: right      # colonne de l'étiquette
  label_y: 0.52         # hauteur de l'étiquette (fraction de l'image)
```

### Repères attachés au corps
| Repère | Origine | Axe x | Axe y |
|---|---|---|---|
| `upper_arm` | épaule | vers le coude (1 = longueur du bras) | perpendiculaire, côté supéro-externe |
| `trunk` | épaule | vers le milieu des épaules (1 = demi-largeur) | vers la hanche (1 = longueur du tronc) |

Pour ajouter un repère (cuisse, jambe, avant-bras…), étendre `Renderer.frame_basis` dans `biomech/render.py`.

## style
`dim`, `desaturate`, `vignette`, couleurs (`accent`, `concentric`, `eccentric`, `trajectory`, `angle`).

## scenes (storyboard)
```yaml
- id: deltoide
  rep: 3                 # répétition réelle utilisée (0 = première détectée ; boucle si trop grand)
  target: 5.0            # durée visée (s) : le moteur calcule le ralenti (×0.35 à ×1)
  show: [angle, phase, muscles, trajectory, lever, scapula_inset, summary, title]
  focus: [deltoide_moyen] # muscles mis en avant (les autres restent discrets)
  headline: "TITRE DE SCÈNE"
  body: "Texte court"
  notes:                 # textes synchronisés avec la phase en cours
    - {when: concentric, text: "…"}   # concentric | eccentric | top | bottom
  summary: ["…", "…"]   # scène de synthèse
```
