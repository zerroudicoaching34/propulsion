# Licences

L'application est publiée sous licence **MIT** (voir `LICENSE`). Licences relevées dans les métadonnées des paquets installés
(`node_modules/*/package.json`, `cargo metadata`) — à revérifier lors des mises à jour.

## Dépendances principales

| Composant | Rôle | Licence |
|---|---|---|
| Tauri 2, tauri-plugin-dialog, @tauri-apps/api | Application de bureau | MIT OR Apache-2.0 |
| React, react-dom | Interface | MIT |
| Tailwind CSS | Styles | MIT |
| zod | Validation des sorties IA | MIT |
| jsPDF (+ html2canvas MIT, fflate MIT, DOMPurify MPL-2.0 OR Apache-2.0) | Export PDF | MIT |
| Vite, Vitest | Build, tests | MIT |
| TypeScript | Langage | Apache-2.0 |
| whisper-rs / whisper-rs-sys | Liaison Rust de whisper.cpp | Unlicense |
| whisper.cpp / ggml (inclus) | Transcription | MIT |
| rusqlite / libsqlite3-sys | SQLite | MIT |
| SQLCipher (inclus via libsqlite3-sys) | Chiffrement de la base | BSD-3-Clause |
| OpenSSL 3 (inclus via openssl-src) | Cryptographie de SQLCipher | Apache-2.0 |
| cpal | Capture audio | Apache-2.0 |
| keyring | Trousseau macOS | MIT OR Apache-2.0 |
| reqwest (rustls) | HTTP (Ollama, cloud) | MIT OR Apache-2.0 |

Sur l'ensemble des ~500 crates Rust résolus (toutes plateformes) : licences permissives (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, Unlicense) et
quelques MPL-2.0 (copyleft au niveau du fichier, compatible avec une distribution MIT). Aucune licence GPL/AGPL.

## Modèles (téléchargés séparément, non inclus dans le dépôt)

| Modèle | Licence | Remarque |
|---|---|---|
| Whisper (ggml : base, small, medium, large-v3-turbo) | MIT (OpenAI) | Usage commercial autorisé |
| Ollama (logiciel) | MIT | |
| qwen2.5:7b, qwen2.5:14b, qwen2.5:1.5b | Apache-2.0 | Recommandé |
| qwen2.5:3b | Qwen Research License | **Usage non commercial** : à éviter pour Smart & Strong |
| llama3.2:3b | Llama 3.2 Community License | Commercial autorisé sous conditions (mention, politique d'usage) |
| mistral (7B) | Apache-2.0 | Alternative |

Vérifiez la licence affichée par `ollama show <modèle> --license` avant tout usage professionnel.
