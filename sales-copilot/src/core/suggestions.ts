import { currentPhase, type MeetingState } from "./analyzer";
import { OBJECTION_RESPONSES } from "./objections";
import type { Question, Suggestion } from "./types";

// Builds at most three short, actionable suggestions from the structured state.

export const MAX_SUGGESTIONS = 3;

export interface SuggestionOptions {
  dismissed: string[];
  /** Variant index requested per suggestion id ("autre formulation"). */
  variants: Record<string, number>;
  /** Optional suggestion produced by the local LLM — shown first when present. */
  llmSuggestion?: Suggestion | null;
}

function questionVariants(q: Question): string[] {
  const topic = q.label.toLowerCase();
  return [
    q.ask,
    `« Pouvez-vous m'en dire un peu plus sur ce point : ${topic} ? »`,
    `« Si on parle de ${topic}, comment le décririez-vous avec vos mots ? »`,
  ];
}

function pick<T>(list: T[], variant: number): T {
  return list[((variant % list.length) + list.length) % list.length];
}

export function buildSuggestions(state: MeetingState, opts: SuggestionOptions): Suggestion[] {
  const out: Suggestion[] = [];
  const phase = currentPhase(state);
  const { questionnaire } = state;

  if (opts.llmSuggestion && !opts.dismissed.includes(opts.llmSuggestion.id)) {
    out.push(opts.llmSuggestion);
  }

  // 1. Most recent open objection or clarification request.
  const openObjections = state.objections.filter((o) => !o.resolved && !o.dismissed);
  const latest = openObjections[openObjections.length - 1];
  if (latest) {
    const id = `obj:${latest.id}`;
    if (!opts.dismissed.includes(id)) {
      const variant = opts.variants[id] ?? 0;
      out.push({
        id,
        kind: latest.kind === "clarification" ? "reformulation" : "objection",
        priority: 1,
        phase,
        title: latest.kind === "clarification" ? "Demande de clarification" : `Objection : ${latest.label}`,
        text: pick(OBJECTION_RESPONSES[latest.kind], variant),
        why: "Le prospect l'a exprimé explicitement.",
        evidence: [latest.evidence],
        toConfirm: [],
        variant,
      });
    }
  }

  // 2. Next missing topic, preferring the current phase, then the questionnaire order.
  const phaseIndex = Math.max(0, questionnaire.phases.indexOf(phase));
  const missing = questionnaire.questions
    .filter((q) => state.questions[q.id]?.status === "not_covered")
    .filter((q) => !opts.dismissed.includes(`q:${q.id}`))
    .sort((a, b) => {
      const pa = questionnaire.phases.indexOf(a.phase);
      const pb = questionnaire.phases.indexOf(b.phase);
      const da = pa < phaseIndex ? 10 + pa : pa - phaseIndex;
      const db = pb < phaseIndex ? 10 + pb : pb - phaseIndex;
      return da - db;
    });
  const next = missing[0];
  if (next) {
    const id = `q:${next.id}`;
    const variant = opts.variants[id] ?? 0;
    out.push({
      id,
      kind: "question",
      priority: 2,
      phase: next.phase,
      title: `Question suivante : ${next.label}`,
      text: pick(questionVariants(next), variant),
      why: next.sensitive
        ? "Information non abordée. Donnée potentiellement sensible : ne la noter que si le prospect l'évoque lui-même."
        : "Information encore non abordée dans la conversation.",
      evidence: [],
      toConfirm: [],
      variant,
    });
  }

  // 3. A partially covered topic to confirm by reformulation.
  const partial = questionnaire.questions.find(
    (q) => state.questions[q.id]?.status === "partial" && !opts.dismissed.includes(`c:${q.id}`) && state.questions[q.id].evidence.length > 0,
  );
  if (partial) {
    const qs = state.questions[partial.id];
    const id = `c:${partial.id}`;
    const variant = opts.variants[id] ?? 0;
    const lastEvidence = qs.evidence[qs.evidence.length - 1];
    const wordings = [
      `Reformuler pour confirmer : « Si je comprends bien, concernant ${partial.label.toLowerCase()}, … C'est bien ça ? »`,
      `« Vous avez évoqué ${partial.label.toLowerCase()} : pouvez-vous préciser ? »`,
      `Vérifier : « Qu'est-ce qui est le plus important pour vous sur ce point ? »`,
    ];
    out.push({
      id,
      kind: "confirm",
      priority: 3,
      phase: partial.phase,
      title: `À confirmer : ${partial.label}`,
      text: pick(wordings, variant),
      why: "Le sujet a été abordé mais la réponse reste incomplète.",
      evidence: lastEvidence ? [lastEvidence] : [],
      toConfirm: [partial.label],
      variant,
    });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}
