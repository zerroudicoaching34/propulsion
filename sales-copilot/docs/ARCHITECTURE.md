# Architecture

## Vue d'ensemble

```
┌──────────────────────────── Mac (tout est local par défaut) ─────────────────────────────┐
│                                                                                           │
│  Micro ─► cpal (thread dédié) ─► rééchantillonnage 16 kHz ─► VAD (découpage aux pauses)   │
│                                                    │                                      │
│                                                    ▼                                      │
│                                  whisper.cpp (français forcé, Metal sur Apple Silicon)    │
│                                                    │  segments + confiance                │
│                                                    ▼                                      │
│   SQLCipher (base chiffrée, clé dans le Trousseau) ◄── segment enregistré ──► événement   │
│                                                                                │          │
│  ┌──────────────────────────── Interface React (WebView) ◄─────────────────────┘          │
│  │  Moteur de règles incrémental (à chaque segment, < 1 ms)                               │
│  │    état structuré : 18 questions, objections, faits (budget, fréquence…)               │
│  │  Ordonnanceur IA (≤ 1 appel en cours, intervalle min., seulement si nouveaux segments)  │
│  │    ─► Ollama 127.0.0.1 (JSON contraint) ─► validation zod ─► ancrage des extraits      │
│  │  Suggestions (≤ 3), débriefing, exports MD/PDF/JSON                                    │
│  └────────────────────────────────────────────────────────────────────────────────────────│
│                                                                                           │
│  Cloud (modes B/C uniquement, sur action explicite) : prévisualisation ─► confirmation    │
│  ─► vérification Rust (mode, confirmation, empreinte SHA-256 identique) ─► journal ─► API │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## Choix techniques

| Besoin | Choix | Raison |
|---|---|---|
| Application de bureau | Tauri 2 (Rust + WebView système) | Léger (pas de Chromium embarqué), accès natif, permissions fines |
| Interface | React 19, TypeScript strict, Tailwind 4 | Maintenable, typé, thème sombre aux couleurs Smart & Strong |
| Transcription | whisper.cpp via `whisper-rs` (compilé dans l'application) | Hors ligne, bon français, Metal ; pas de Python à installer |
| Découpage audio | VAD par énergie avec seuil adaptatif | Segments courts (≤ 12 s) ⇒ latence bornée ; aucun modèle supplémentaire |
| IA locale | Ollama (HTTP local) + sortie JSON contrainte par schéma | Choix libre du modèle selon la RAM ; validation stricte |
| Données | SQLite + SQLCipher, migrations versionnées | Chiffrement au repos, fichier unique, sauvegarde simple |
| Secrets | Trousseau macOS (`keyring`) | Clé de base et clés API jamais en clair, jamais dans le code |
| PDF | jsPDF (dans l'application) | Export local, sans service externe |

Python n'est pas nécessaire : tout le traitement audio et IA passe par Rust/whisper.cpp et Ollama.

## Moteur d'analyse (`src/core`)

Le moteur est du TypeScript pur, testé indépendamment de l'interface.

- **`analyzer.ts`** — état structuré du rendez-vous. Chaque segment met à jour l'état sans recalculer la conversation :
  indices de réponse (prospect) et de question (coach), attribution d'une réponse à la question que le coach vient de poser,
  reconnaissance d'informations données spontanément et dans le désordre, extraction de faits (montants, fréquence, objectif
  de poids). Les statuts ne régressent jamais automatiquement et **une validation manuelle n'est jamais écrasée**.
  Après une correction de locuteur ou de texte, `reanalyze` reconstruit la partie automatique en conservant les validations.
- **`objections.ts`** — objections explicites (prix, temps, réflexion, décision partagée, doute, engagement, distance) et
  demandes de clarification, uniquement à partir des propos du prospect ; réponses suggérées orientées compréhension.
- **`suggestions.ts`** — au plus 3 suggestions : objection ouverte la plus récente, prochain sujet manquant (étape courante
  d'abord), sujet partiel à confirmer ; « Ignorer » et « Autre formulation ».
- **`llm.ts`** — couche IA locale : prompt compact (questionnaire + statuts + résumé incrémental + 6 segments de contexte +
  nouveaux segments), schéma JSON imposé à Ollama, validation zod, **rejet de tout extrait introuvable dans le segment cité**
  (anti-hallucination), fusion sans écraser le manuel, ordonnanceur (un appel à la fois, intervalle configurable, indicateur
  de latence).
- **`recommendation.ts`** — profil de besoins (autonomie, présentiel/distance, programmation, nutrition, fréquence,
  déplacement, budget) puis orientation expliquée ; « informations insuffisantes » si nécessaire ; égalité ⇒ pas de choix ;
  Elite seulement sur demande explicite ; jamais de préférence pour le prix le plus élevé.
- **`preferences.ts`** — préférences de communication observées, chacune avec ses extraits ; grille DISC facultative avec
  avertissement.
- **`debrief.ts` / `pdf.ts`** — débriefing (décision réellement exprimée, prochaine action, temps de parole, points
  d'amélioration) et exports.
- **`cloud.ts`** — préparation du contenu cloud : masquage noms/e-mails/téléphones, empreinte SHA-256.

## Backend Rust (`src-tauri/src`)

| Module | Rôle |
|---|---|
| `audio.rs` | Capture micro (cpal, flux créé et détruit sur un thread dédié), rééchantillonnage, VAD, files bornées, pause/reprise, arrêt immédiat (micro fermé), filtrage des hallucinations Whisper connues |
| `transcribe.rs` | Chargement du modèle Whisper avant l'ouverture du micro ; français forcé ; confiance = probabilité moyenne des jetons |
| `db.rs` | SQLCipher, migrations, CRUD, suppression en cascade, purge de contenu, politique de rétention |
| `settings.rs` | Réglages validés (URL Ollama locale uniquement, HTTPS pour le cloud) ; `config.json` au premier lancement |
| `secrets.rs` | Clé de base (Trousseau ; repli fichier 0600 hors macOS), clés API |
| `llm.rs` | Client Ollama (sans proxy, boucle locale uniquement), barrière cloud, envoi Anthropic / compatible OpenAI |
| `commands.rs` | Commandes exposées à l'interface ; le consentement et les règles de confidentialité y sont **appliqués côté backend** |

## Données

Schéma : `src-tauri/migrations/0001_init.sql` — `settings`, `kb` (offres, questionnaires, texte de consentement),
`prospects`, `meetings`, `segments`, `cloud_transfers` (métadonnées seulement), `cloud_results`.

La base est créée et initialisée automatiquement au premier lancement (schéma + offres + questionnaires + texte de
consentement par défaut) dans `~/Library/Application Support/fr.smartandstrong.salescopilot/copilot.db`.
Un fichier de base pré-rempli ne peut pas être fourni : il est chiffré avec une clé propre à votre Trousseau.

Rétention : au démarrage et à la fermeture, le contenu (segments, analyse, débriefing, résultats cloud) des rendez-vous
non conservés est effacé ; seuls le type, la date, le statut, la décision, la prochaine action et des compteurs restent
(statistiques réelles du tableau de bord). Les rendez-vous conservés sont purgés après la durée configurée.

## Sécurité de l'interface

CSP stricte (`tauri.conf.json`) : aucun script ni connexion externe depuis la WebView ; toutes les requêtes réseau
passent par Rust. Permissions Tauri minimales (`capabilities/default.json`).
