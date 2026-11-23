# Architecture

```
vidéo réelle ──► pose.py ──────────► analysis.py ─────────► render.py ──────────► FFmpeg ─► MP4
                 MediaPipe Pose       angles 2D, répétitions,  vidéo assombrie,
                 (33 repères)         phases, bras de levier   calques attachés au corps,
                 lissage One-Euro                              textes, encarts
                 corrections.yaml          ▲                        ▲
                                           └──── config/exercises/<exercice>.yaml ────┘
```

| Module | Rôle |
|---|---|
| `biomech/pose.py` | Détection MediaPipe Pose Landmarker (mode vidéo, modèle *heavy*), lissage One-Euro aller-retour (sans retard), interpolation des trous, corrections manuelles, points dérivés (main/haltère, cou, bassin) |
| `biomech/analysis.py` | Métriques angulaires 2D, découpage des répétitions (extrema avec hystérésis), phases par vitesse angulaire, bras de levier externe normalisé |
| `biomech/render.py` | Timeline (scènes ↔ répétitions, ralenti calculé), arrière-plan (assombri, désaturé, vignette, fondu entre images pour le ralenti), muscles dans des repères corporels (polygones lissés, hachures orientées selon les fibres), cartouches et lignes de rappel, arcs d'angle, trajectoires, encart scapulaire, jauge du bras de levier, synthèse |
| `biomech/cli.py` | Commandes `analyse`, `preview`, `render`, `run` |

## Choix techniques évalués

| Option | Verdict | Raison |
|---|---|---|
| **Python + OpenCV + MediaPipe + FFmpeg** | ✅ retenu | Une seule chaîne de A à Z, pilotée par les données de suivi ; tourne en local, sans licence |
| **Pillow** pour le dessin | ✅ retenu | Rendu image par image exact sur les repères ; aucune dépendance graphique lourde |
| Remotion (React) | ➖ possible plus tard | Très bon pour l'habillage animé, mais demande Node + Chromium et un pont JSON entre Python et React ; utile si un graphiste veut éditer les animations en code web |
| After Effects | ❌ écarté | Payant, non scriptable de façon automatisée sous Linux, suivi à refaire à la main à chaque vidéo |

## Fiabilité
- Détection : 100 % des images sur la vidéo test (385 images, 12,8 s).
- Angles : projection 2D ; un test sur squelette synthétique vérifie l'écart (< 6°).
- Le moteur n'affiche jamais de pourcentage d'activation ; les schémas sont signalés comme tels à l'écran.
