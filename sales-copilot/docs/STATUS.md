# État d'avancement

Légende : ✅ vérifié par un test automatisé · 🖥️ vérifié sur l'application compilée (Linux, test de bout en bout) ·
🍎 à vérifier sur Mac (code écrit et compilé, non exécutable dans l'environnement de développement) · ⏳ restant à faire.

L'environnement de développement était un conteneur Linux sans Mac, sans micro et sans accès aux serveurs de modèles
(Hugging Face, Ollama) : la transcription Whisper réelle, le micro macOS, Metal, le Trousseau et le `.dmg` n'ont pas pu
être exécutés. La [recette du guide d'utilisation](USER_GUIDE.md#6-recette-sur-votre-mac-critères-de-réussite-v1) couvre ces points.

## Phase 1 — MVP

| Fonctionnalité | État |
|---|---|
| Application de bureau lançable (Tauri 2) | 🖥️ Linux · 🍎 macOS (`scripts/dev.sh`, `scripts/build-mac.sh`) |
| Fiche prospect : création, édition, suppression (en cascade) | ✅ 🖥️ |
| Rendez-vous R1 / R2 : planification, ouverture, suppression | ✅ 🖥️ |
| Consentement obligatoire avant écoute (contrôlé par le backend), retrait = arrêt | ✅ 🖥️ |
| Pipeline audio : démarrage, pause, reprise, arrêt immédiat, file bornée, aucune écriture disque | ✅ (source audio simulée) · 🍎 micro réel |
| Refus propre de l'écoute sans modèle Whisper (micro jamais ouvert) | ✅ 🖥️ |
| Transcription Whisper locale en français, confiance par segment | 🍎 (test réel prêt : `cargo test -- --ignored`) |
| Découpage aux pauses (VAD), latence bornée (≤ 12 s par segment) | ✅ |
| Attribution Coach / Prospect (sélection C/P/U) et correction manuelle | ✅ 🖥️ |
| Saisie manuelle de répliques (sans micro) | 🖥️ |
| Questionnaires R1 et R2 de 18 questions, ordre libre, informations spontanées, validation manuelle | ✅ 🖥️ |
| Suggestions en direct (≤ 3), Ignorer, Autre formulation | ✅ 🖥️ |
| Détection des objections et demandes de clarification | ✅ 🖥️ |
| IA locale Ollama : prompt incrémental, JSON contraint, validation, anti-hallucination, limitation, latence | ✅ (contrat HTTP simulé) · 🍎 modèle réel |
| Sauvegarde locale chiffrée (SQLCipher), migrations versionnées | ✅ 🖥️ · 🍎 clé dans le Trousseau |
| Débriefing complet, décision réellement exprimée, exports Markdown / PDF / JSON | ✅ 🖥️ (écran) · ✅ (fichiers générés) · 🍎 boîte d'enregistrement macOS |
| Suppression des données d'un rendez-vous | ✅ |
| Conservation désactivée par défaut, purge au démarrage et à la fermeture, durée configurable | ✅ |
| Fonctionnement hors ligne après installation | ✅ par conception (aucun appel réseau hors Ollama local et cloud explicite) · 🍎 à confirmer Wi-Fi coupé |

## Phase 2 — Intelligence commerciale

| Fonctionnalité | État |
|---|---|
| Extraction structurée (montants, fréquence, objectif de poids, réponses par question) | ✅ |
| Préférences de communication avec extraits ; DISC facultatif avec avertissement | ✅ 🖥️ |
| Recommandation d'offre expliquée, informations insuffisantes, jamais la plus chère par défaut | ✅ 🖥️ |
| Historique des prospects, statistiques réelles (pas de prédiction) | 🖥️ |
| Base de connaissances modifiable (offres, questionnaires, consentement) | 🖥️ (écrans) · ✅ (stockage) |

## Phase 3 — Cloud hybride

| Fonctionnalité | État |
|---|---|
| Configuration du fournisseur (Anthropic, compatible OpenAI), clé dans le Trousseau | 🖥️ (écran) · 🍎 Trousseau |
| Prévisualisation éditable, masquage, confirmation, barrière Rust (mode, confirmation, empreinte) | ✅ |
| Journal des transferts (métadonnées seulement) | ✅ |
| Envoi réel au fournisseur et comparaison locale / cloud | ⚠️ code écrit, non testé contre l'API réelle (aucune clé disponible) |

## Phase 4 — Distribution

| Fonctionnalité | État |
|---|---|
| Scripts : audit, installation, modèles, lancement, build | ✅ syntaxe · 🍎 exécution |
| Packaging `.app` / `.dmg` (non signé) | 🍎 |
| Documentation, licence MIT, dépannage, mise à jour | ✅ |

## Restant à faire / limites connues

- ⏳ **Diarisation automatique** : non incluse. Aucune solution locale fiable en français suffisamment légère n'a été intégrée ;
  l'attribution repose sur la sélection du locuteur (raccourcis C/P) et la correction manuelle. Piste : deux micros (un par
  personne) ou un modèle de segmentation de locuteurs local en option.
- ⏳ Signature et notarisation Apple (nécessite un compte Apple Developer) pour éviter l'avertissement Gatekeeper.
- ⏳ Vérification de l'empreinte SHA-256 des modèles Whisper par le script (actuellement affichée pour comparaison manuelle).
- ⏳ Fiches prospects non purgées automatiquement (seul le contenu des rendez-vous l'est) : règle de conservation à définir.
- ⏳ Les règles de détection (indices) sont une première version : à affiner avec vos vrais rendez-vous (écran Questionnaires).
- ⏳ Enregistrement audio optionnel : volontairement absent (aucun enregistrement permanent).
- ⏳ Recherche d'un modèle Ollama par défaut optimal : à mesurer sur votre Mac (latence affichée dans l'écran en direct).
