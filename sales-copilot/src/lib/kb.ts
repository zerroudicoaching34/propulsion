import { defaultOffers } from "../core/offers";
import { defaultQuestionnaire } from "../core/questionnaires";
import type { Offer, Questionnaire } from "../core/types";
import { api } from "./api";

// Knowledge base stored in the local database, seeded from the defaults on first launch.

export const DEFAULT_CONSENT_TEXT = `Avant de commencer, je vous informe que j'utilise un assistant installé sur mon ordinateur pour m'aider à prendre des notes pendant notre échange.

• Il transcrit notre conversation en texte, localement sur cet ordinateur ; l'audio n'est pas enregistré.
• Les notes servent uniquement à préparer votre accompagnement et le compte rendu de ce rendez-vous.
• Rien n'est envoyé sur Internet sans votre accord.
• Vous pouvez refuser, ou me demander d'arrêter à tout moment : je coupe immédiatement.
• Vous pouvez demander la suppression de ces notes.

Êtes-vous d'accord pour que je l'utilise pendant notre échange ?`;

export interface KnowledgeBase {
  offers: Offer[];
  questionnaires: { R1: Questionnaire; R2: Questionnaire };
  consentText: string;
}

async function getOrSeed<T>(key: string, fallback: () => T): Promise<T> {
  const raw = await api.kbGet(key);
  if (raw) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      /* corrupted entry: reseed below */
    }
  }
  const value = fallback();
  await api.kbSet(key, JSON.stringify(value));
  return value;
}

export async function loadKnowledgeBase(): Promise<KnowledgeBase> {
  const [offers, r1, r2, consent] = await Promise.all([
    getOrSeed("offers", defaultOffers),
    getOrSeed("questionnaire_R1", () => defaultQuestionnaire("R1")),
    getOrSeed("questionnaire_R2", () => defaultQuestionnaire("R2")),
    getOrSeed("consent_text", () => ({ text: DEFAULT_CONSENT_TEXT })),
  ]);
  return { offers, questionnaires: { R1: r1, R2: r2 }, consentText: consent.text };
}

export async function saveOffers(offers: Offer[]) {
  await api.kbSet("offers", JSON.stringify(offers));
}
export async function saveQuestionnaire(q: Questionnaire) {
  await api.kbSet(`questionnaire_${q.type}`, JSON.stringify(q));
}
export async function saveConsentText(text: string) {
  await api.kbSet("consent_text", JSON.stringify({ text }));
}
