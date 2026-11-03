# Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| « Aucun modèle Whisper configuré » au démarrage de l'écoute | Chemin vide | `bash scripts/download-models.sh` puis Réglages → IA locale & transcription → chemin du `.bin` → *Vérifier* |
| « Micro inaccessible » / aucun segment | Autorisation micro refusée | Réglages Système → Confidentialité et sécurité → Microphone : autoriser *Smart & Strong Copilot* (ou *Terminal* en mode développement), puis relancer l'application |
| L'autorisation micro n'est jamais demandée (app construite) | Application non signée déplacée/modifiée | `tccutil reset Microphone fr.smartandstrong.salescopilot`, relancer |
| « Impossible d'ouvrir » l'app au premier lancement | Application non signée (Gatekeeper) | Clic droit → *Ouvrir*, ou Réglages Système → Confidentialité et sécurité → *Ouvrir quand même* |
| Transcription lente (plusieurs secondes de retard qui s'accumulent) | Modèle trop lourd pour la machine | Utiliser `small` ou `base` (`scripts/download-models.sh base`), augmenter les threads, fermer Ollama ou allonger l'intervalle IA |
| Phrases inventées (« Sous-titres réalisés par… ») | Hallucination Whisper sur un silence | Les cas connus sont filtrés ; supprimer le segment (✕) sinon ; vérifier le niveau du micro |
| Le niveau du micro reste à zéro | Mauvais périphérique | Réglages → Micro : choisir l'entrée correcte |
| « IA locale indisponible — règles seules » | Ollama arrêté ou modèle absent | Ouvrir l'application Ollama ou `ollama serve` ; `ollama pull qwen2.5:7b` ; Réglages → *Tester* |
| « Réponse de l'IA locale invalide (ignorée) » | Petit modèle qui respecte mal le format | Utiliser un modèle plus grand (qwen2.5:7b), ou désactiver l'IA locale (les règles restent actives) |
| Échec de compilation de whisper.cpp | CMake ou Xcode CLT absents | `xcode-select --install`, `brew install cmake` |
| Échec de compilation avec Metal | Outils Metal indisponibles | `scripts/build-mac.sh` réessaie sans Metal ; ou `npx tauri dev` sans `--features metal` |
| « file is not a database » au lancement | Clé du Trousseau perdue/différente | Restaurer l'entrée Trousseau `fr.smartandstrong.salescopilot` / `database-key` ; sinon déplacer `copilot.db` pour repartir d'une base vide (données précédentes illisibles) |
| Le contenu d'un rendez-vous a disparu après redémarrage | Conservation désactivée (comportement par défaut) | Cocher *Conserver ce rendez-vous* pendant le rendez-vous, ou exporter le débriefing avant de quitter |
| Envoi cloud refusé | Mode local, case non cochée, contenu modifié après confirmation, ou clé absente | Le message précise la cause ; Réglages → Confidentialité / Cloud |

Fichiers de l'application : `~/Library/Application Support/fr.smartandstrong.salescopilot/` (`copilot.db`, `models/`, `config.json`).
Pour tout réinitialiser : quitter l'application, supprimer ce dossier et l'entrée du Trousseau.
