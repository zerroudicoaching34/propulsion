# Confidentialité, RGPD et points à faire vérifier

> Ce document décrit les mesures techniques de l'application et liste les questions à faire valider par un juriste ou
> un délégué à la protection des données. Ce n'est pas un avis juridique.

## Mesures intégrées

| Exigence | Mise en œuvre | Où |
|---|---|---|
| Consentement avant captation | Texte d'information personnalisable ; case + enregistrement horodaté ; **l'écoute est refusée par le backend sans consentement** | `commands.rs::ensure_consent`, `LiveMeeting.tsx` |
| Retrait du consentement | Arrêt immédiat de l'écoute, audio en attente abandonné | `meeting_set_consent` |
| Indicateur micro | Badge permanent « Micro actif » + indicateur macOS | `App.tsx` |
| Pause / arrêt immédiats | Pause effective avant même la réponse du thread audio ; arrêt = flux micro détruit | `audio.rs` |
| Pas d'audio permanent | Audio en mémoire uniquement, libéré après transcription ; aucune écriture disque | `audio.rs` |
| Conservation désactivée par défaut | Contenu purgé au démarrage et à la fermeture ; conservation par rendez-vous sur choix explicite ; durée configurable | `db.rs::apply_retention` |
| Suppression | Rendez-vous (transcription, analyse, débriefing, résultats cloud) ; prospect (tout, en cascade) ; `secure_delete` SQLite | `db.rs` |
| Chiffrement | Base SQLCipher (AES-256), clé aléatoire de 256 bits dans le Trousseau | `db.rs`, `secrets.rs` |
| Clés API | Trousseau macOS ; jamais renvoyées à l'interface ; jamais dans le code | `secrets.rs` |
| Pas de transfert automatique | IA locale verrouillée sur la boucle locale ; cloud seulement en modes B/C, après prévisualisation, édition, masquage et confirmation ; contrôle d'empreinte côté Rust ; aucun repli automatique vers le cloud | `llm.rs::check_cloud_gate` |
| Journal des transferts | Date, fournisseur, modèle, objet, taille, empreinte SHA-256, statut — jamais le contenu | `cloud_transfers` |
| Télémétrie | Aucune (aucun code de télémétrie) | — |
| Minimisation | Coordonnées facultatives ; masquage noms/e-mails/téléphones avant envoi cloud | `cloud.ts` |
| Pas d'inférence sensible | Aucune émotion, trouble, vulnérabilité ou donnée de santé déduits de la voix ; préférences de communication fondées sur les mots, avec extraits ; DISC présenté comme repère pédagogique | `preferences.ts`, prompt système `llm.ts` |

## Points à faire vérifier

1. **Base légale et information (art. 6, 7, 13 RGPD)** — le consentement oral est enregistré par le coach (case cochée,
   horodatage). Faut-il une trace plus forte (écrite, e-mail) ? Le texte d'information est-il complet (finalités,
   durée, droits, contact) ?
2. **Données de santé (art. 9 RGPD)** — en coaching physique, le prospect peut évoquer poids, blessures, douleurs,
   troubles alimentaires… Ce sont des données de santé : un **consentement explicite** spécifique est en principe requis.
   Le sujet « Contraintes physiques déclarées » est marqué sensible ⚕ et n'est noté que si la personne l'évoque.
   À valider : formulation du consentement, nécessité de ces données, durée de conservation.
3. **Enregistrement de conversations (art. 226-1 du Code pénal)** — capter les paroles d'une personne sans son
   consentement est pénalement sanctionné. L'application transcrit (sans conserver l'audio) et exige le consentement ;
   à confirmer pour vos usages (visio, téléphone, présence de tiers).
4. **Analyse d'impact (AIPD/DPIA, art. 35)** — traitement innovant + données potentiellement sensibles : vérifier si une AIPD
   est nécessaire (liste CNIL).
5. **Registre des traitements (art. 30)** — y inscrire ce traitement (finalité : préparation et suivi commercial ;
   catégories de données ; durées ; destinataires).
6. **Durées de conservation** — fixer une durée justifiée pour les rendez-vous conservés (par défaut 30 jours) et pour les
   fiches prospects (non purgées automatiquement : à supprimer manuellement, ou prévoir une règle).
7. **Droits des personnes** — accès (export JSON/Markdown du débriefing, fiche prospect), rectification (édition),
   effacement (suppression). Prévoir la procédure de réponse.
8. **Cloud (modes B/C)** — contrat de sous-traitance (DPA) avec le fournisseur, localisation des serveurs, transferts hors UE
   (art. 44 et s.), durée de conservation chez le fournisseur, usage éventuel pour l'entraînement de modèles. Ne pas activer
   ces modes avant cette vérification.
9. **Sécurité du poste** — FileVault activé, session protégée par mot de passe, sauvegardes chiffrées (la base est chiffrée,
   mais les exports PDF/MD/JSON ne le sont pas).
10. **Rédaction des suggestions** — les formulations proposées visent la compréhension et une décision libre ; les relire
    au regard du Code de la consommation (pratiques commerciales agressives ou trompeuses) et ne jamais promettre de résultat.
