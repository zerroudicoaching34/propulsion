import { coverage, type MeetingState } from "./analyzer";
import { buildNeedProfile, recommendOffer } from "./recommendation";
import { matchCues, normalize, wordCount } from "./text";
import type { Debrief, Meeting, Offer, Prospect, Segment } from "./types";

// End-of-meeting debrief, built from what was actually said and validated.
// Nothing here is invented: unknown items are reported as "Non exprimé(e)".

const DECISION_CUES = {
  yes: ["je prends", "on y va", "je m'engage", "je signe", "c'est bon pour moi", "je commence", "allons-y", "je valide", "on part la-dessus", "on part sur"],
  think: ["je vais reflechir", "je dois reflechir", "laissez-moi reflechir", "j'ai besoin de reflechir", "je reviens vers vous", "je vous redis"],
  no: ["pas pour moi", "non merci", "je ne vais pas", "ca ne me convient pas", "je prefere pas", "je prefere ne pas"],
};

const NEXT_ACTION_CUES = ["prochaine etape", "je vous envoie", "je vous rappelle", "on se revoit", "on se recontacte", "premiere seance", "rendez-vous", "la semaine prochaine", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

export function detectDecision(segments: Segment[]): { label: string; excerpt: string | null } {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const s = segments[i];
    if (s.speaker !== "prospect") continue;
    const norm = normalize(s.text);
    if (matchCues(norm, DECISION_CUES.no).length) return { label: "Refus exprimé", excerpt: s.text };
    if (matchCues(norm, DECISION_CUES.yes).length) return { label: "Accord exprimé", excerpt: s.text };
    if (matchCues(norm, DECISION_CUES.think).length) return { label: "Souhaite réfléchir", excerpt: s.text };
  }
  return { label: "Non exprimée", excerpt: null };
}

export function detectNextAction(segments: Segment[]): string | null {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (matchCues(normalize(segments[i].text), NEXT_ACTION_CUES).length) return segments[i].text;
  }
  return null;
}

export function talkRatio(segments: Segment[]): { coach: number; prospect: number } {
  let coach = 0;
  let prospect = 0;
  for (const s of segments) {
    if (s.speaker === "coach") coach += wordCount(s.text);
    if (s.speaker === "prospect") prospect += wordCount(s.text);
  }
  const total = coach + prospect;
  if (!total) return { coach: 0, prospect: 0 };
  return { coach: Math.round((coach / total) * 100), prospect: Math.round((prospect / total) * 100) };
}

function unique(items: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const t = i?.trim();
    if (t && !seen.has(normalize(t))) {
      seen.add(normalize(t));
      out.push(t);
    }
  }
  return out;
}

function answerOf(state: MeetingState, id: string): string | null {
  const q = state.questions[id];
  return q && q.status !== "not_covered" ? q.answer : null;
}

export interface DebriefInput {
  state: MeetingState;
  segments: Segment[];
  prospect: Prospect | null;
  meeting: Pick<Meeting, "type" | "decision" | "nextAction">;
  offers: Offer[];
  /** Optional free-text summary written by the local LLM or by the coach. */
  summaryOverride?: string;
}

export function buildDebrief(input: DebriefInput): Debrief {
  const { state, segments, prospect, meeting, offers } = input;
  const cov = coverage(state);
  const ratio = talkRatio(segments);
  const qn = state.questionnaire;

  const objective =
    prospect?.objective?.trim() || answerOf(state, "r1_objective") || answerOf(state, "r2_reformulate_goal") || "Non exprimé";

  const difficulties = unique([prospect?.obstacles, answerOf(state, "r1_obstacles"), answerOf(state, "r1_what_worked")]);

  const needs = unique([answerOf(state, "r1_support"), answerOf(state, "r1_autonomy"), answerOf(state, "r1_availability"), answerOf(state, "r1_criteria")]);

  const questionsAndObjections = state.objections
    .filter((o) => !o.dismissed)
    .map((o) => `${o.label}${o.resolved ? " (traité)" : " (non traité)"} — « ${o.evidence.excerpt} »`);

  const answersGiven = qn.questions
    .filter((q) => q.coachDelivers && state.questions[q.id]?.status !== "not_covered")
    .map((q) => `${q.label} : ${state.questions[q.id].answer ?? "abordé"}`);

  const missingInformation = qn.questions.filter((q) => state.questions[q.id]?.status === "not_covered").map((q) => q.label);

  const profile = buildNeedProfile(prospect, segments, state.facts);
  const reco = recommendOffer(profile, offers);
  const recommendedOffer = reco.offerName
    ? `${reco.offerName} — ${reco.reasons.join(", ")}${reco.missing.length ? ` (à confirmer : ${reco.missing.join(", ")})` : ""}`
    : `Aucune recommandation : ${reco.reasons.join(" ")}${reco.missing.length ? ` Manque : ${reco.missing.join(", ")}.` : ""}`;

  const detected = detectDecision(segments);
  const decision = meeting.decision?.trim() || (detected.excerpt ? `${detected.label} — « ${detected.excerpt} »` : detected.label);
  const nextAction = meeting.nextAction?.trim() || detectNextAction(segments) || "Non convenue";

  const improvements: string[] = [];
  if (ratio.coach > 60) improvements.push(`Temps de parole du coach élevé (${ratio.coach} %) : laisser davantage de place au prospect.`);
  const openObjections = state.objections.filter((o) => !o.resolved && !o.dismissed);
  if (openObjections.length) improvements.push(`Objection(s) restée(s) ouverte(s) : ${openObjections.map((o) => o.label).join(", ")}.`);
  if (missingInformation.length) improvements.push(`Sujets non abordés (${missingInformation.length}) : ${missingInformation.slice(0, 5).join(", ")}${missingInformation.length > 5 ? "…" : ""}.`);
  if (meeting.type === "R2" && state.questions["r2_understanding"]?.status === "not_covered") improvements.push("Vérifier la compréhension du prospect avant la décision.");
  if (!improvements.length) improvements.push("Aucun point d'amélioration détecté automatiquement.");

  const prospectName = prospect ? `${prospect.firstName} ${prospect.lastName}`.trim() || "Prospect" : "Prospect";
  const summary =
    input.summaryOverride?.trim() ||
    [
      `Rendez-vous ${meeting.type} avec ${prospectName}.`,
      `${cov.covered} sujet(s) traité(s) et ${cov.partial} partiellement sur ${cov.total}.`,
      objective !== "Non exprimé" ? `Objectif exprimé : ${objective}.` : "Objectif non exprimé.",
      state.objections.length ? `${state.objections.length} objection(s) ou demande(s) de clarification relevée(s).` : "Aucune objection relevée.",
      `Décision : ${decision.split(" — ")[0]}.`,
    ].join(" ");

  return {
    generatedAt: new Date().toISOString(),
    meetingType: meeting.type,
    prospectName,
    summary,
    objective,
    difficulties,
    needs,
    questionsAndObjections,
    answersGiven,
    missingInformation,
    recommendedOffer,
    decision,
    nextAction,
    coachImprovements: improvements,
    coverage: { covered: cov.covered, partial: cov.partial, total: cov.total },
    talkRatio: ratio,
  };
}

function list(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "- Non renseigné";
}

export function debriefToMarkdown(d: Debrief): string {
  return [
    `# Débriefing ${d.meetingType} — ${d.prospectName}`,
    ``,
    `_Généré le ${new Date(d.generatedAt).toLocaleString("fr-FR")} — Smart & Strong Sales Copilot_`,
    ``,
    `## Résumé`,
    d.summary,
    ``,
    `## Objectif déclaré`,
    d.objective,
    ``,
    `## Difficultés identifiées`,
    list(d.difficulties),
    ``,
    `## Besoins exprimés`,
    list(d.needs),
    ``,
    `## Questions et objections`,
    list(d.questionsAndObjections),
    ``,
    `## Réponses apportées`,
    list(d.answersGiven),
    ``,
    `## Informations manquantes`,
    list(d.missingInformation),
    ``,
    `## Offre éventuellement recommandée`,
    d.recommendedOffer,
    ``,
    `## Décision réellement exprimée`,
    d.decision,
    ``,
    `## Prochaine action convenue`,
    d.nextAction,
    ``,
    `## Points d'amélioration du coach`,
    list(d.coachImprovements),
    ``,
    `---`,
    `Couverture : ${d.coverage.covered} traités, ${d.coverage.partial} partiels / ${d.coverage.total}. Temps de parole : coach ${d.talkRatio.coach} %, prospect ${d.talkRatio.prospect} %.`,
    ``,
  ].join("\n");
}

export function debriefToJson(d: Debrief): string {
  return JSON.stringify(d, null, 2);
}
