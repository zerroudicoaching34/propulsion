import { detectObjections } from "./objections";
import { excerpt, matchCues, normalize, wordCount } from "./text";
import type {
  DetectedObjection,
  Evidence,
  QuestionState,
  QuestionStatus,
  Questionnaire,
  Segment,
} from "./types";

// Incremental, rule-based analysis. Each new segment updates a structured state;
// the whole conversation is never re-analysed. This layer is deterministic,
// instant and works offline. The optional local LLM layer (llm.ts) can refine
// the same state at a lower frequency.

export interface Facts {
  budgetAmounts: number[];
  sessionsPerWeek: number | null;
  weightGoalKg: number | null;
}

export interface MeetingState {
  questionnaire: Questionnaire;
  questions: Record<string, QuestionState>;
  objections: DetectedObjection[];
  /** Questions the coach just asked: the next prospect replies are read as answers. */
  pending: { questionIds: string[]; segmentId: string; remaining: number } | null;
  processed: string[];
  facts: Facts;
  lastTouchedQuestionId: string | null;
  /** Rolling summary maintained by the LLM layer (empty when the LLM is not used). */
  rollingSummary: string;
}

const STATUS_RANK: Record<QuestionStatus, number> = { not_covered: 0, partial: 1, covered: 2 };
const MAX_EVIDENCE = 3;

export function createMeetingState(questionnaire: Questionnaire): MeetingState {
  const questions: Record<string, QuestionState> = {};
  for (const q of questionnaire.questions) {
    questions[q.id] = {
      questionId: q.id,
      status: "not_covered",
      answer: null,
      evidence: [],
      confidence: 0,
      manual: false,
      origin: "none",
    };
  }
  return {
    questionnaire,
    questions,
    objections: [],
    pending: null,
    processed: [],
    facts: { budgetAmounts: [], sessionsPerWeek: null, weightGoalKg: null },
    lastTouchedQuestionId: null,
    rollingSummary: "",
  };
}

/** Upgrades a question state (never downgrades, never touches manual validations). */
export function upgradeQuestion(
  current: QuestionState,
  next: { status: QuestionStatus; confidence: number; evidence?: Evidence; answer?: string | null; origin: QuestionState["origin"] },
): QuestionState {
  if (current.manual) return current;
  const better = STATUS_RANK[next.status] > STATUS_RANK[current.status];
  const same = STATUS_RANK[next.status] === STATUS_RANK[current.status];
  if (!better && !same) {
    // Lower status: we may still collect evidence, but keep the status.
    return next.evidence ? withEvidence(current, next.evidence) : current;
  }
  let updated: QuestionState = {
    ...current,
    status: better ? next.status : current.status,
    confidence: Math.max(current.confidence, next.confidence),
    origin: better || next.confidence > current.confidence ? next.origin : current.origin,
  };
  if (next.answer && (better || !current.answer)) updated.answer = next.answer;
  if (next.evidence) updated = withEvidence(updated, next.evidence);
  return updated;
}

function withEvidence(q: QuestionState, ev: Evidence): QuestionState {
  if (q.evidence.some((e) => e.segmentId === ev.segmentId)) return q;
  return { ...q, evidence: [...q.evidence, ev].slice(-MAX_EVIDENCE) };
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  quinze: 15, vingt: 20, trente: 30,
};

function parseNumber(token: string): number | null {
  const t = token.replace(/\s/g, "").replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

export function extractFacts(normalizedText: string, previous: Facts): Facts {
  const facts: Facts = { ...previous, budgetAmounts: [...previous.budgetAmounts] };
  const money = /(\d[\d\s]{0,6}(?:[.,]\d+)?)\s*(?:€|euros?\b)/g;
  for (const m of normalizedText.matchAll(money)) {
    const n = parseNumber(m[1]);
    if (n !== null && n > 0 && !facts.budgetAmounts.includes(n)) facts.budgetAmounts.push(n);
  }
  const freq = /\b(\d|un|une|deux|trois|quatre|cinq)\s*(?:fois|seances?|entrainements?)\s*(?:par|a la|la)\s*semaine/.exec(normalizedText);
  if (freq) facts.sessionsPerWeek = parseNumber(freq[1]);
  const weight = /\bperdre\s*(?:environ\s*|a peu pres\s*)?(\d{1,3}|cinq|dix|quinze|vingt|trente)\s*(?:kilos?|kg)\b/.exec(normalizedText);
  if (weight) facts.weightGoalKg = parseNumber(weight[1]);
  return facts;
}

/**
 * Applies one new segment to the state. Pure function: returns a new state.
 * Segments already processed are ignored (idempotent), so callers can replay safely.
 */
export function analyzeSegment(state: MeetingState, segment: Segment): MeetingState {
  if (state.processed.includes(segment.id) || !segment.text.trim()) return state;
  const norm = normalize(segment.text);
  const questions = { ...state.questions };
  const ev: Evidence = { segmentId: segment.id, excerpt: excerpt(segment.text) };
  let pending = state.pending;
  let lastTouched = state.lastTouchedQuestionId;

  if (segment.speaker === "coach") {
    const asked: string[] = [];
    for (const q of state.questionnaire.questions) {
      const hits = matchCues(norm, q.askCues);
      if (!hits.length) continue;
      asked.push(q.id);
      lastTouched = q.id;
      if (q.coachDelivers) {
        questions[q.id] = upgradeQuestion(questions[q.id], {
          status: hits.length >= 2 || wordCount(segment.text) >= 15 ? "covered" : "partial",
          confidence: 0.6,
          evidence: ev,
          answer: excerpt(segment.text, 200),
          origin: "rules",
        });
      } else {
        questions[q.id] = upgradeQuestion(questions[q.id], { status: "partial", confidence: 0.3, evidence: ev, origin: "rules" });
      }
    }
    pending = asked.length ? { questionIds: asked, segmentId: segment.id, remaining: 2 } : pending;
  } else {
    // Prospect (or not yet attributed: lower confidence).
    const factor = segment.speaker === "prospect" ? 1 : 0.7;
    const words = wordCount(segment.text);
    for (const q of state.questionnaire.questions) {
      const hits = matchCues(norm, q.answerCues);
      const answersPending = pending?.questionIds.includes(q.id) && words >= 3;
      if (!hits.length && !answersPending) continue;
      let score = Math.min(hits.length, 3) * 0.3 + (answersPending ? (words >= 6 ? 0.55 : 0.4) : 0) + (words >= 12 ? 0.1 : 0);
      score = Math.min(0.95, score * factor);
      if (score < 0.25) continue;
      const status: QuestionStatus = score >= 0.55 ? "covered" : "partial";
      questions[q.id] = upgradeQuestion(questions[q.id], {
        status,
        confidence: Number(score.toFixed(2)),
        evidence: ev,
        answer: excerpt(segment.text, 200),
        origin: "rules",
      });
      lastTouched = q.id;
    }
    if (pending) pending = pending.remaining > 1 ? { ...pending, remaining: pending.remaining - 1 } : null;
  }

  let objections = state.objections;
  if (segment.speaker !== "coach") {
    for (const found of detectObjections(segment)) {
      const existing = objections.find((o) => o.kind === found.kind && !o.resolved && !o.dismissed);
      objections = existing
        ? objections.map((o) => (o === existing ? { ...o, evidence: found.evidence } : o))
        : [...objections, found];
    }
  }

  return {
    ...state,
    questions,
    objections,
    pending,
    processed: [...state.processed, segment.id],
    facts: segment.speaker === "coach" ? state.facts : extractFacts(norm, state.facts),
    lastTouchedQuestionId: lastTouched,
  };
}

export function analyzeAll(state: MeetingState, segments: Segment[]): MeetingState {
  return segments.reduce(analyzeSegment, state);
}

/**
 * Rebuilds the automatic part of the state from scratch (used after the coach
 * corrects a speaker or edits a text). Manual validations are preserved.
 */
export function reanalyze(state: MeetingState, segments: Segment[]): MeetingState {
  const fresh = createMeetingState(state.questionnaire);
  for (const [id, q] of Object.entries(state.questions)) {
    if (q.manual) fresh.questions[id] = q;
  }
  const rebuilt = analyzeAll(fresh, segments);
  // Keep objection decisions (resolved / dismissed) taken by the coach.
  const objections = rebuilt.objections.map((o) => {
    const prev = state.objections.find((p) => p.kind === o.kind && p.evidence.segmentId === o.evidence.segmentId);
    return prev ? { ...o, id: prev.id, resolved: prev.resolved, dismissed: prev.dismissed } : o;
  });
  return { ...rebuilt, objections, rollingSummary: state.rollingSummary };
}

/** Manual validation from the coach — always wins over automatic updates. */
export function setQuestionManually(
  state: MeetingState,
  questionId: string,
  status: QuestionStatus,
  answer?: string,
): MeetingState {
  const q = state.questions[questionId];
  if (!q) return state;
  return {
    ...state,
    questions: {
      ...state.questions,
      [questionId]: { ...q, status, answer: answer ?? q.answer, manual: true, origin: "manual", confidence: 1 },
    },
  };
}

export function clearManual(state: MeetingState, questionId: string): MeetingState {
  const q = state.questions[questionId];
  if (!q) return state;
  return { ...state, questions: { ...state.questions, [questionId]: { ...q, manual: false } } };
}

export function coverage(state: MeetingState): { covered: number; partial: number; total: number; ratio: number } {
  const all = Object.values(state.questions);
  const covered = all.filter((q) => q.status === "covered").length;
  const partial = all.filter((q) => q.status === "partial").length;
  const total = all.length;
  return { covered, partial, total, ratio: total ? (covered + partial * 0.5) / total : 0 };
}

/** Estimated current phase: the phase of the most recently discussed topic. */
export function currentPhase(state: MeetingState): string {
  const { questionnaire } = state;
  if (state.lastTouchedQuestionId) {
    const q = questionnaire.questions.find((x) => x.id === state.lastTouchedQuestionId);
    if (q) return q.phase;
  }
  return questionnaire.phases[0] ?? "";
}

export function setObjectionFlag(
  state: MeetingState,
  objectionId: string,
  flag: "resolved" | "dismissed",
  value = true,
): MeetingState {
  return {
    ...state,
    objections: state.objections.map((o) => (o.id === objectionId ? { ...o, [flag]: value } : o)),
  };
}
