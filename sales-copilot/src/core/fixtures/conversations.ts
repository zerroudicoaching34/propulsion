import type { Segment, Speaker } from "../types";

// Fictional conversations used by the automated tests. Any resemblance to a
// real person is coincidental.

type Line = [Speaker, string];

export function toSegments(meetingId: string, lines: Line[]): Segment[] {
  return lines.map(([speaker, text], i) => ({
    id: `${meetingId}_s${i + 1}`,
    meetingId,
    startMs: i * 8000,
    endMs: i * 8000 + 7000,
    speaker,
    text,
    confidence: 0.9,
    source: "manual",
    edited: false,
  }));
}

export const R1_CONVERSATION: Line[] = [
  ["coach", "Bonjour Camille, merci d'avoir pris ce temps. Pour commencer, pouvez-vous me décrire votre quotidien en ce moment ?"],
  ["prospect", "Je travaille dans une banque, souvent en télétravail, avec deux enfants, donc mon rythme est assez chargé."],
  ["coach", "D'accord. Et quel est votre objectif ?"],
  ["prospect", "J'aimerais perdre 8 kilos et me sentir mieux dans ma silhouette, surtout le ventre."],
  ["prospect", "En fait j'ai déjà essayé trois fois : Weight Watchers en 2019, puis la salle de sport avec un abonnement, puis un régime keto l'an dernier."],
  ["prospect", "Ça marchait au début mais j'ai lâché à chaque fois, effet yoyo."],
  ["coach", "Qu'est-ce qui vous bloque le plus aujourd'hui selon vous ?"],
  ["prospect", "Le soir je grignote, et seule je lâche vite, j'ai besoin d'un cadre."],
  ["coach", "Et niveau budget, quel budget envisagez-vous ?"],
  ["prospect", "Je dirais environ 800 euros par mois, je peux venir deux fois par semaine, la salle est à côté de chez moi."],
  ["prospect", "Par contre je veux être sûre que ça marche, j'ai déjà tout essayé. Et c'est quoi la différence entre vos formules ?"],
];

export const R2_CONVERSATION: Line[] = [
  ["coach", "Si je résume, votre objectif est de perdre 8 kilos et de retrouver de l'énergie. C'est bien ça ?"],
  ["prospect", "Oui c'est ça, exactement."],
  ["coach", "Notre méthode repose sur trois piliers : entraînement, nutrition, habitudes. Au vu de ce que vous m'avez dit, je vous recommande la formule Advanced parce que vous m'avez dit avoir besoin d'un cadre."],
  ["coach", "Concrètement ça comprend deux séances par semaine, la nutrition, des bilans et le suivi. L'investissement est de 720 euros par mois avec un engagement de six mois."],
  ["prospect", "C'est un peu cher quand même, et douze mois ça me paraît long."],
  ["coach", "Je comprends. Quel montant vous semble raisonnable ?"],
  ["prospect", "Je vais réfléchir et en parler à mon mari, je vous redis lundi."],
  ["coach", "Très bien, la prochaine étape : je vous envoie le récapitulatif et je vous rappelle lundi."],
];
