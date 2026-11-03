import { excerpt, matchCues, normalize, uid } from "./text";
import type { DetectedObjection, ObjectionKind, Segment } from "./types";

// Detection of explicit objections and requests for clarification.
// Only what the prospect actually says is used — no inference from tone or voice.

export const OBJECTION_LABELS: Record<ObjectionKind, string> = {
  price: "Prix / budget",
  time: "Manque de temps",
  think: "Besoin de réfléchir",
  third_party: "Décision partagée",
  doubt: "Doute sur l'efficacité",
  commitment: "Durée d'engagement",
  distance: "Distance / déplacement",
  clarification: "Demande de clarification",
};

export const OBJECTION_CUES: Record<ObjectionKind, string[]> = {
  price: ["trop cher", "c'est cher", "ca fait cher", "un peu cher", "pas les moyens", "pas le budget", "au-dessus de mon budget", "au dessus de mon budget", "hors budget", "ca fait beaucoup", "c'est beaucoup d'argent", "pas dans mes moyens", "le prix me", "moins cher"],
  time: ["pas le temps", "pas assez de temps", "trop occupe", "trop occupee", "emploi du temps charge", "je n'ai pas le temps", "je manque de temps", "c'est compliqué niveau temps", "c'est complique niveau temps"],
  think: ["je vais reflechir", "je dois reflechir", "laissez-moi reflechir", "laisse-moi reflechir", "j'ai besoin de reflechir", "y reflechir", "je vais y penser", "je vous redis", "je reviens vers vous", "pas tout de suite"],
  third_party: ["en parler a mon", "en parler a ma", "en discuter avec", "voir avec mon", "voir avec ma", "demander a mon", "demander a ma", "mon mari", "ma femme", "mon conjoint", "ma conjointe"],
  doubt: ["est-ce que ca marche", "est-ce que ca va marcher", "ca va marcher", "pas sur que", "pas sure que", "j'ai deja tout essaye", "rien ne marche", "ca ne marche jamais", "j'y crois pas", "j'y crois plus", "sceptique", "et si ca ne marche pas"],
  commitment: ["engagement", "s'engager", "m'engager", "12 mois c'est long", "douze mois", "c'est long", "sans engagement", "resilier", "arreter en cours"],
  distance: ["c'est loin", "trop loin", "le trajet", "pas de voiture", "je ne peux pas me deplacer", "loin de chez moi"],
  clarification: ["je ne comprends pas", "je comprends pas", "c'est quoi la difference", "quelle difference", "ca veut dire quoi", "qu'est-ce que ca veut dire", "comment ca marche", "comment ca se passe", "vous pouvez repeter", "pouvez-vous expliquer", "c'est-a-dire", "c'est a dire"],
};

// "mon mari" alone is not an objection; only when a decision is mentioned nearby.
const THIRD_PARTY_CONTEXT = ["en parler", "discuter", "voir avec", "demander", "decider", "son avis", "d'accord"];

export function detectObjections(segment: Segment): DetectedObjection[] {
  const norm = normalize(segment.text);
  const found: DetectedObjection[] = [];
  for (const kind of Object.keys(OBJECTION_CUES) as ObjectionKind[]) {
    const hits = matchCues(norm, OBJECTION_CUES[kind]);
    if (!hits.length) continue;
    if (kind === "third_party" && !matchCues(norm, THIRD_PARTY_CONTEXT).length) continue;
    // "sans engagement" asked as a question is a clarification about commitment — still useful.
    found.push({
      id: uid("obj"),
      kind,
      label: OBJECTION_LABELS[kind],
      evidence: { segmentId: segment.id, excerpt: excerpt(segment.text) },
      resolved: false,
      dismissed: false,
    });
  }
  return found;
}

/**
 * Suggested responses. They aim at understanding and clarifying, never at
 * pressuring: reformulate, explore, give factual information, leave the choice free.
 */
export const OBJECTION_RESPONSES: Record<ObjectionKind, string[]> = {
  price: [
    "« Je comprends que le budget compte. Quel montant vous semble raisonnable pour cet objectif ? » — puis présenter honnêtement l'option la plus adaptée à ce budget.",
    "« Pour être sûr de bien comprendre : c'est le montant mensuel, ou la durée totale qui vous pose question ? »",
    "Reformuler le besoin, rappeler factuellement ce que l'offre inclut, et mentionner s'il existe une formule plus légère adaptée.",
  ],
  time: [
    "« Combien de temps par semaine pourriez-vous réellement y consacrer ? » — adapter la proposition à ce temps réel.",
    "« Qu'est-ce qui occupe le plus votre semaine aujourd'hui ? » — chercher un format compatible plutôt que convaincre.",
    "Préciser factuellement la durée d'une séance et le temps hors séance demandé par l'offre.",
  ],
  think: [
    "« Bien sûr. Pour que votre réflexion soit utile, quels points aimeriez-vous clarifier avant de décider ? »",
    "« Qu'est-ce qui vous ferait pencher dans un sens ou dans l'autre ? » — puis proposer une date de recontact convenue ensemble.",
    "Respecter le délai : résumer la proposition par écrit et convenir d'une prochaine étape claire.",
  ],
  third_party: [
    "« C'est légitime. Qu'est-ce qui sera important pour lui/elle, à votre avis ? »",
    "« Voulez-vous que je vous envoie un récapitulatif écrit pour en parler ensemble ? »",
    "Proposer, si la personne le souhaite, un échange à trois pour répondre aux questions.",
  ],
  doubt: [
    "« Qu'est-ce qui vous fait douter, concrètement ? » — écouter avant de répondre.",
    "« Dans vos tentatives précédentes, qu'est-ce qui a manqué selon vous ? » — puis expliquer ce qui serait différent, sans promettre de résultat.",
    "Expliquer la méthode et le suivi de façon factuelle ; ne jamais garantir un résultat.",
  ],
  commitment: [
    "Expliquer factuellement les durées d'engagement possibles et leurs conditions (telles que définies dans la base des offres).",
    "« Quelle durée vous semblerait confortable ? Qu'est-ce qui vous inquiète dans l'engagement ? »",
    "Rappeler pourquoi une durée minimale est proposée (temps nécessaire aux adaptations), sans pression.",
  ],
  distance: [
    "« Combien de temps de trajet seriez-vous prêt(e) à faire ? »",
    "Mentionner, si pertinent, la formule à distance (Online Pilotage) et ce qu'elle inclut réellement.",
    "« Quels jours et horaires seraient les plus simples pour venir ? »",
  ],
  clarification: [
    "Réexpliquer simplement, avec un exemple concret, puis vérifier : « Est-ce plus clair ainsi ? »",
    "« Qu'est-ce qui n'était pas clair ? Je reprends ce point. »",
    "Reformuler en une phrase, puis demander au prospect de redire avec ses mots ce qu'il a compris.",
  ],
};
