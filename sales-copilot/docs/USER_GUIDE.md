# Guide d'utilisation

## 1. Premier lancement

1. Lancez l'application (`bash scripts/dev.sh`, ou ouvrez `Smart & Strong Copilot.app`).
2. **Réglages & administration → IA locale & transcription** : vérifiez le chemin du modèle Whisper (bouton *Vérifier*),
   choisissez le micro, testez Ollama (bouton *Tester*).
3. **Réglages → Confidentialité** : le mode **A — 100 % local** est actif par défaut. La conservation est désactivée par défaut.
4. **Réglages → Offres / Questionnaires R1/R2 / Texte de consentement** : adaptez le contenu à votre pratique.
   Laissez vide tout tarif ou garantie non défini : l'application ne complète jamais ces champs.

À la première écoute, macOS demande l'autorisation d'accès au micro (pour l'application, ou pour le Terminal en mode
développement). Acceptez ; sinon voir [Dépannage](TROUBLESHOOTING.md).

## 2. Préparer un rendez-vous

**Prospects → + Nouvelle fiche** : identité (coordonnées facultatives), objectif, situation, tentatives, obstacles,
contraintes, budget communiqué, autonomie, critères de décision, notes. *Enregistrer*.
Dans *Rendez-vous*, choisissez **R1** ou **R2** et la date, puis *Planifier*.

## 3. Pendant le rendez-vous

1. *Démarrer* sur le rendez-vous → écran **Consentement** : lisez le texte au prospect. Cochez la case seulement s'il est
   d'accord, puis *Enregistrer le consentement*. Sans consentement, l'écoute est impossible (contrôle côté backend).
2. **● Démarrer l'écoute**. Le badge rouge *Micro actif* en haut à droite indique que le micro est ouvert.
3. **Qui parle ?** — l'application ne reconnaît pas les voix : indiquez le locuteur avec les touches **C** (coach),
   **P** (prospect), **U** (à attribuer) ou les boutons. Chaque phrase transcrite prend le locuteur sélectionné.
   Pour corriger après coup, cliquez sur l'étiquette du segment (cycle *À attribuer → Prospect → Coach*).
   ✎ corrige le texte, ✕ supprime le segment. Toute correction met à jour l'analyse.
4. **Colonne gauche — Progression** : étape estimée, sujets traités / partiels / non traités, extrait justificatif et
   niveau de confiance. Cliquez sur un statut pour le valider manuellement (✓) ; *revenir à la détection automatique*
   annule la validation. Les informations données spontanément, dans n'importe quel ordre, sont reconnues.
5. **Colonne droite — Copilote** : au plus 3 suggestions (principale encadrée en or), avec la justification et l'extrait.
   *Ignorer* ou *Autre formulation*. Les objections et demandes de clarification détectées peuvent être marquées *Traitée*
   ou écartées (✕). La ligne du haut indique l'état de l'IA locale et sa latence ; sans Ollama, le copilote fonctionne
   avec les règles seules.
6. Sans micro (ou pour compléter), saisissez ce qui a été dit dans la barre en bas de la transcription.
7. **❚❚ Pause**, **▶ Reprendre**, **■ Arrêter** agissent immédiatement. **Retrait du consentement** arrête l'écoute et
   abandonne l'audio en attente.
8. *Conserver ce rendez-vous* : à cocher uniquement si vous souhaitez garder la transcription après fermeture de l'application.

## 4. Après le rendez-vous

**Terminer → débriefing** : résumé, objectif, difficultés, besoins, questions et objections, réponses apportées,
informations manquantes, offre éventuellement recommandée (avec ses raisons), décision réellement exprimée, prochaine action,
points d'amélioration du coach. Corrigez la décision et la prochaine action si besoin, puis *Enregistrer*.

- *Rédiger avec l'IA locale* propose un résumé (à relire).
- *Export Markdown / PDF / JSON* : fichier enregistré à l'endroit choisi.
- *Supprimer les données* : efface le rendez-vous (transcription, analyse, débriefing, résultats cloud). La fiche prospect reste ;
  pour tout supprimer, supprimez la fiche dans *Prospects*.

**Analyse conversationnelle** : préférences de communication observées (avec extraits), besoins identifiés, orientation
d'offre. La grille DISC, facultative (Réglages → Confidentialité), est un simple repère pédagogique.

## 5. Cloud (facultatif)

Réglages → Confidentialité → mode **B — Hybride** (extraits) ou **C — Analyse approfondie** (rendez-vous complet après la séance).
Réglages → Cloud : fournisseur, modèle, clé API (stockée dans le Trousseau). Chaque envoi ouvre une fenêtre qui affiche le
fournisseur, les implications, le texte exact (modifiable, noms et coordonnées masqués par défaut) ; rien n'est envoyé sans
la case de confirmation et le bouton *Envoyer*. Le journal (Réglages → Cloud) liste chaque transfert, sans son contenu.
En mode C, le débriefing affiche côte à côte l'analyse locale et l'analyse cloud.

## 6. Recette sur votre Mac (critères de réussite V1)

À dérouler une fois après installation ; cochez chaque point.

- [ ] L'application s'ouvre ; *Réglages → À propos* indique « Clé de chiffrement : Trousseau macOS ».
- [ ] Créer une fiche prospect fictive, planifier un R1.
- [ ] Consentement : le bouton reste inactif tant que la case n'est pas cochée.
- [ ] *Démarrer l'écoute* : macOS demande l'accès au micro ; le badge *Micro actif* apparaît ; l'icône orange de macOS
      apparaît dans la barre des menus.
- [ ] Parler en français : des segments apparaissent quelques secondes après chaque phrase, avec un pourcentage de confiance.
- [ ] Touches C / P : les segments suivants prennent le bon locuteur ; corriger un segment en cliquant sur son étiquette.
- [ ] Dire « j'ai déjà essayé trois régimes et la salle de sport » : *Tentatives précédentes* passe à *Traitée*.
- [ ] Les suggestions changent ; *Ignorer* et *Autre formulation* fonctionnent.
- [ ] *■ Arrêter* : le badge et l'icône orange de macOS disparaissent immédiatement.
- [ ] *Terminer → débriefing*, exports MD/PDF/JSON ouverts sans erreur.
- [ ] *Supprimer les données* : le rendez-vous disparaît de la fiche prospect.
- [ ] **Hors ligne** : couper le Wi-Fi, quitter et relancer l'application, refaire un court rendez-vous : tout fonctionne
      (transcription, suggestions, IA locale, débriefing).
- [ ] Fermer l'application avec un rendez-vous non conservé, relancer : son contenu est effacé, la décision reste
      dans le tableau de bord.
