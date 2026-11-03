import { excerpt, matchCues, normalize } from "./text";
import type { CommunicationObservation, Segment } from "./types";

// Observed communication preferences, based only on the words the prospect uses.
// Every observation comes with the excerpts that justify it. This is NOT a
// personality assessment, and nothing is inferred from voice, tone or emotion.

const PREFERENCE_CUES: Record<CommunicationObservation["key"], { label: string; cues: string[] }> = {
  precision: {
    label: "Besoin de précision",
    cues: ["precisement", "exactement", "combien de", "en chiffres", "quel pourcentage", "quelle duree", "combien de temps", "les details", "au juste", "concretement combien"],
  },
  detail: {
    label: "Préférence pour des explications détaillées",
    cues: ["expliquez-moi", "pourquoi", "comment ca fonctionne", "comment ca marche", "en detail", "j'aimerais comprendre", "je veux comprendre", "le principe"],
  },
  simplicity: {
    label: "Recherche de simplicité",
    cues: ["simple", "en gros", "rapidement", "pas complique", "pas prise de tete", "facile", "sans me compliquer", "le plus simple"],
  },
  security: {
    label: "Importance de la sécurité et de la régularité",
    cues: ["securite", "rassur", "regulier", "regularite", "progressivement", "en douceur", "sans risque", "me blesser", "pas me blesser", "stable", "routine"],
  },
  results: {
    label: "Orientation vers les résultats",
    cues: ["resultat", "efficace", "objectif", "atteindre", "performance", "que ca marche", "des resultats", "rapidement"],
  },
  examples: {
    label: "Préférence pour des exemples concrets",
    cues: ["par exemple", "un exemple", "concretement", "cas concret", "d'autres clients", "temoignage", "ca donne quoi", "a quoi ressemble"],
  },
};

const MAX_EVIDENCE = 3;

export function observePreferences(segments: Segment[]): CommunicationObservation[] {
  const obs = new Map<CommunicationObservation["key"], CommunicationObservation>();
  for (const seg of segments) {
    if (seg.speaker !== "prospect") continue;
    const norm = normalize(seg.text);
    for (const [key, def] of Object.entries(PREFERENCE_CUES) as [CommunicationObservation["key"], { label: string; cues: string[] }][]) {
      const hits = matchCues(norm, def.cues);
      if (!hits.length) continue;
      const cur = obs.get(key) ?? { key, label: def.label, count: 0, evidence: [] };
      cur.count += hits.length;
      if (cur.evidence.length < MAX_EVIDENCE) cur.evidence.push({ segmentId: seg.id, excerpt: excerpt(seg.text) });
      obs.set(key, cur);
    }
  }
  return [...obs.values()].sort((a, b) => b.count - a.count);
}

/** Optional teaching grid. Displayed with an explicit disclaimer; never a diagnosis. */
export const DISC_TEACHING_GRID: Record<CommunicationObservation["key"], string> = {
  results: "Repère pédagogique « D » : aller à l'essentiel, parler objectifs et étapes.",
  examples: "Repère pédagogique « I » : illustrer par des exemples concrets.",
  security: "Repère pédagogique « S » : rassurer par la progressivité et la régularité.",
  precision: "Repère pédagogique « C » : donner des chiffres, des durées, des faits.",
  detail: "Repère pédagogique « C » : expliquer le pourquoi et le comment.",
  simplicity: "Repère pédagogique « D/I » : formuler simplement, une idée à la fois.",
};

export const DISC_DISCLAIMER =
  "Grille pédagogique facultative pour adapter sa façon d'expliquer. Elle ne constitue ni un diagnostic psychologique, ni une classification fiable de la personnalité. Elle repose uniquement sur les mots employés pendant ce rendez-vous.";
