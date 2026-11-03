import type { Facts } from "./analyzer";
import { matchCues, normalize } from "./text";
import type { Offer, Prospect, Recommendation, Segment } from "./types";

// Offer orientation. Identifies the real need first, explains its reasoning,
// says when information is insufficient, and never favours the most expensive offer.

export type Tri = "yes" | "no" | "unknown";

export interface NeedProfile {
  hasObjective: boolean;
  autonomous: Tri;
  wantsInPerson: Tri;
  wantsRemote: Tri;
  wantsPersonalProgram: Tri;
  wantsNutrition: Tri;
  wantsToLearnMethod: Tri;
  wantsSimpleWeekly: Tri;
  wantsIntensive: Tri;
  canTravel: Tri;
  wantsPremiumService: Tri;
  budgetMonthly: number | null;
  evidence: Record<string, string>;
}

const CUES = {
  autonomousYes: ["je suis autonome", "en autonomie", "m'entrainer seul", "m'entrainer seule", "je sais m'entrainer", "je connais les exercices", "tout seul", "toute seule", "je m'entraine seul", "je m'entraine seule"],
  autonomousNo: ["besoin qu'on me", "besoin d'etre encadre", "besoin d'etre encadree", "seul je lache", "seule je lache", "je lache vite", "j'ai besoin d'un cadre", "pas autonome", "besoin d'etre pousse", "besoin d'etre poussee", "besoin d'etre suivi", "besoin d'etre suivie"],
  inPerson: ["en presentiel", "en vrai", "coach a cote", "quelqu'un a cote", "sur place", "en salle avec", "qu'on me corrige", "etre encadre", "etre encadree", "encadrement"],
  remote: ["a distance", "en ligne", "en visio", "depuis chez moi", "a la maison", "pas me deplacer"],
  personalProgram: ["programme personnalise", "programmation", "un programme adapte", "programme sur mesure", "plan d'entrainement", "programme individualise"],
  nutrition: ["nutrition", "alimentation", "mon assiette", "quoi manger", "plan alimentaire", "je mange mal"],
  learn: ["apprendre", "comprendre la methode", "une formation", "me former", "comprendre comment", "a mon rythme", "devenir autonome"],
  simpleWeekly: ["une fois par semaine", "1 fois par semaine", "une seance par semaine", "regularite", "quelque chose de simple", "juste garder la forme", "entretenir"],
  intensive: ["deux fois par semaine", "2 fois par semaine", "trois fois par semaine", "3 fois par semaine", "transformation", "a fond", "intensif", "resultats rapides", "vraiment changer"],
  canTravel: ["je peux venir", "je peux me deplacer", "pas loin", "a cote de chez moi", "juste a cote", "sur mon trajet", "c'est pratique pour moi"],
  cannotTravel: ["trop loin", "c'est loin", "je ne peux pas me deplacer", "pas de voiture", "j'habite loin", "j'habite a l'etranger"],
  premium: ["conciergerie", "service premium", "priorite", "flexibilite totale", "sur mesure complet", "planning tres charge et"],
};

function tri(text: string, yes: string[], no: string[] = []): { value: Tri; cue?: string } {
  const y = matchCues(text, yes);
  const n = matchCues(text, no);
  if (y.length && !n.length) return { value: "yes", cue: y[0] };
  if (n.length && !y.length) return { value: "no", cue: n[0] };
  return { value: "unknown" };
}

export function buildNeedProfile(prospect: Partial<Prospect> | null, segments: Segment[], facts: Facts): NeedProfile {
  const fromProspect = segments.filter((s) => s.speaker === "prospect").map((s) => s.text);
  const formText = prospect
    ? [prospect.objective, prospect.currentSituation, prospect.constraints, prospect.autonomy, prospect.decisionCriteria, prospect.obstacles].filter(Boolean).join(" . ")
    : "";
  const text = normalize([...fromProspect, formText].join(" . "));
  const evidence: Record<string, string> = {};
  const record = (key: string, r: { value: Tri; cue?: string }) => {
    if (r.cue) evidence[key] = r.cue;
    return r.value;
  };

  const sessions = facts.sessionsPerWeek;
  const budgetFromForm = prospect?.budget ? /(\d[\d\s]*)/.exec(prospect.budget.replace(/\s/g, ""))?.[1] : undefined;
  const budgetMonthly = facts.budgetAmounts.length
    ? Math.max(...facts.budgetAmounts)
    : budgetFromForm
      ? Number(budgetFromForm)
      : null;

  let wantsSimpleWeekly = record("simpleWeekly", tri(text, CUES.simpleWeekly));
  let wantsIntensive = record("intensive", tri(text, CUES.intensive));
  if (sessions !== null) {
    if (sessions <= 1) wantsSimpleWeekly = "yes";
    if (sessions >= 2) wantsIntensive = "yes";
  }

  return {
    hasObjective: Boolean(prospect?.objective?.trim()) || /\b(perdre|muscl|tonifi|maigrir|prendre du muscle|objectif|silhouette|forme)/.test(text),
    autonomous: record("autonomous", tri(text, CUES.autonomousYes, CUES.autonomousNo)),
    wantsInPerson: record("inPerson", tri(text, CUES.inPerson)),
    wantsRemote: record("remote", tri(text, CUES.remote)),
    wantsPersonalProgram: record("personalProgram", tri(text, CUES.personalProgram)),
    wantsNutrition: record("nutrition", tri(text, CUES.nutrition)),
    wantsToLearnMethod: record("learn", tri(text, CUES.learn)),
    wantsSimpleWeekly,
    wantsIntensive,
    canTravel: record("canTravel", tri(text, CUES.canTravel, CUES.cannotTravel)),
    wantsPremiumService: record("premium", tri(text, CUES.premium)),
    budgetMonthly: budgetMonthly && Number.isFinite(budgetMonthly) ? budgetMonthly : null,
    evidence,
  };
}

interface Scored {
  offer: Offer;
  score: number;
  reasons: string[];
  blockers: string[];
}

function fitsBudget(offer: Offer, budget: number | null): boolean | null {
  if (budget === null) return null;
  if (offer.monthlyPriceMin !== null) return budget >= offer.monthlyPriceMin;
  return null;
}

export function recommendOffer(profile: NeedProfile, offers: Offer[]): Recommendation {
  const missing: string[] = [];
  if (!profile.hasObjective) missing.push("Objectif physique");
  if (profile.autonomous === "unknown") missing.push("Niveau d'autonomie");
  if (profile.wantsInPerson === "unknown" && profile.wantsRemote === "unknown") missing.push("Préférence présentiel / distance");
  if (profile.canTravel === "unknown" && profile.wantsRemote !== "yes") missing.push("Possibilité de se déplacer");
  if (profile.budgetMonthly === null) missing.push("Budget communiqué");

  const active = offers.filter((o) => o.active);
  const scored: Scored[] = active.map((offer) => {
    const reasons: string[] = [];
    const blockers: string[] = [];
    let score = 0;
    switch (offer.id) {
      case "online":
        if (profile.wantsRemote === "yes") { score += 2; reasons.push("souhaite un accompagnement à distance"); }
        if (profile.autonomous === "yes") { score += 1; reasons.push("se dit capable de s'entraîner seul(e)"); }
        if (profile.wantsPersonalProgram === "yes") { score += 2; reasons.push("demande une programmation personnalisée"); }
        if (profile.canTravel === "no") { score += 1; reasons.push("ne peut pas se déplacer facilement"); }
        if (profile.wantsInPerson === "yes") blockers.push("demande un encadrement en présentiel");
        break;
      case "basic":
        if (profile.wantsSimpleWeekly === "yes") { score += 3; reasons.push("recherche une pratique hebdomadaire simple"); }
        if (profile.wantsInPerson === "yes") { score += 1; reasons.push("souhaite une pratique encadrée"); }
        if (profile.canTravel === "yes") score += 0.5;
        if (profile.wantsNutrition === "yes") blockers.push("demande un accompagnement nutritionnel (non inclus)");
        if (profile.wantsIntensive === "yes") blockers.push("demande un encadrement plus fréquent qu'une séance par semaine");
        if (profile.canTravel === "no") blockers.push("ne peut pas se déplacer");
        break;
      case "advanced":
        if (profile.wantsIntensive === "yes") { score += 2; reasons.push("demande un encadrement intensif / une transformation"); }
        if (profile.wantsInPerson === "yes") { score += 1; reasons.push("souhaite être encadré(e) physiquement"); }
        if (profile.autonomous === "no") { score += 1; reasons.push("indique avoir besoin d'un cadre"); }
        if (profile.wantsNutrition === "yes") { score += 1; reasons.push("demande un accompagnement nutritionnel"); }
        if (profile.canTravel === "yes") { score += 0.5; reasons.push("peut se déplacer"); }
        if (profile.canTravel === "no") blockers.push("ne peut pas se déplacer");
        if (profile.wantsRemote === "yes") blockers.push("préfère la distance");
        break;
      case "elite":
        // Only on explicit demand for a premium service, never by default.
        if (profile.wantsPremiumService === "yes") { score += 2; reasons.push("demande explicitement un service premium / prioritaire"); }
        else blockers.push("aucune demande explicite de service premium");
        if (profile.wantsIntensive === "yes") score += 1;
        if (profile.canTravel === "no") blockers.push("ne peut pas se déplacer");
        break;
      case "evergreen":
        if (profile.wantsToLearnMethod === "yes") { score += 2; reasons.push("veut apprendre une méthode"); }
        if (profile.autonomous === "yes") { score += 2; reasons.push("se dit autonome"); }
        if (profile.autonomous === "no") blockers.push("indique avoir besoin d'un suivi (non inclus)");
        if (profile.wantsInPerson === "yes") blockers.push("demande un encadrement en présentiel");
        break;
      default:
        break;
    }
    const budgetFit = fitsBudget(offer, profile.budgetMonthly);
    if (budgetFit === false) blockers.push(`budget communiqué (${profile.budgetMonthly} €/mois) inférieur au tarif`);
    if (budgetFit === true) reasons.push("compatible avec le budget communiqué");
    return { offer, score, reasons, blockers };
  });

  const viable = scored.filter((s) => s.blockers.length === 0 && s.score >= 2).sort((a, b) => b.score - a.score);
  const best = viable[0];
  const tie = best && viable[1] && viable[1].score === best.score;

  const alternatives = scored
    .filter((s) => s !== best && s.score >= 1)
    // Elite is only ever mentioned when a premium service was explicitly requested.
    .filter((s) => s.offer.id !== "elite" || profile.wantsPremiumService === "yes")
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((s) => ({
      offerId: s.offer.id,
      offerName: s.offer.name,
      reason: s.blockers.length ? `Freins : ${s.blockers.join(", ")}` : s.reasons.join(", ") || "Partiellement adapté",
    }));

  const sufficient = missing.length <= 2 && Boolean(best) && !tie;
  if (!best || tie) {
    return {
      offerId: null,
      offerName: null,
      reasons: tie
        ? [`Plusieurs offres correspondent autant (${viable.filter((v) => v.score === best.score).map((v) => v.offer.name).join(", ")}) : clarifier les besoins avant de recommander.`]
        : ["Informations insuffisantes pour orienter vers une offre."],
      missing,
      alternatives,
      sufficient: false,
    };
  }
  return {
    offerId: best.offer.id,
    offerName: best.offer.name,
    reasons: best.reasons,
    missing,
    alternatives,
    sufficient,
  };
}
