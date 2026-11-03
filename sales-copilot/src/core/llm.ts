import { z } from "zod";
import { upgradeQuestion, type MeetingState } from "./analyzer";
import { OBJECTION_LABELS } from "./objections";
import { excerpt, normalize, uid } from "./text";
import type { ObjectionKind, Segment, Suggestion } from "./types";

// Local LLM layer (Ollama). Builds compact prompts from the structured state and
// the few latest exchanges (never the whole conversation), validates the JSON
// answer and merges it without overriding manual validations.

export const SYSTEM_PROMPT = `Tu es le copilote discret d'un coach Smart & Strong pendant un rendez-vous commercial.
Règles impératives :
- Tu analyses uniquement ce qui est dit. Tu n'inventes aucune information, aucun tarif, aucune garantie, aucun résultat.
- Chaque élément détecté doit citer un extrait EXACT de la transcription et l'identifiant du segment.
- Tu n'infères ni émotion, ni trouble psychologique, ni vulnérabilité, ni information de santé non exprimée.
- Tu ne proposes jamais de technique de pression ou de manipulation. Les suggestions aident à comprendre le besoin et à laisser une décision libre et éclairée.
- Les suggestions sont courtes (une ou deux phrases), en français, faciles à lire pendant une conversation.
- Tu réponds UNIQUEMENT avec un objet JSON conforme au schéma demandé.`;

const objectionKinds = Object.keys(OBJECTION_LABELS) as [ObjectionKind, ...ObjectionKind[]];

export const LlmAnalysisSchema = z.object({
  phase: z.string().max(80).optional().default(""),
  questions: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(["partial", "covered"]),
        answer: z.string().max(400).optional().default(""),
        segment_id: z.string(),
        excerpt: z.string().max(400),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(18)
    .default([]),
  objections: z
    .array(z.object({ kind: z.enum(objectionKinds), segment_id: z.string(), excerpt: z.string().max(400) }))
    .max(5)
    .default([]),
  suggestion: z
    .object({
      title: z.string().max(120),
      text: z.string().max(400),
      why: z.string().max(300).optional().default(""),
      to_confirm: z.array(z.string().max(120)).max(5).optional().default([]),
    })
    .nullable()
    .optional()
    .default(null),
  summary: z.string().max(1500).optional().default(""),
});
export type LlmAnalysis = z.infer<typeof LlmAnalysisSchema>;

/** JSON schema passed to Ollama's `format` field to constrain decoding. */
export const LLM_JSON_SCHEMA = {
  type: "object",
  properties: {
    phase: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["partial", "covered"] },
          answer: { type: "string" },
          segment_id: { type: "string" },
          excerpt: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["id", "status", "segment_id", "excerpt", "confidence"],
      },
    },
    objections: {
      type: "array",
      items: {
        type: "object",
        properties: { kind: { type: "string", enum: objectionKinds }, segment_id: { type: "string" }, excerpt: { type: "string" } },
        required: ["kind", "segment_id", "excerpt"],
      },
    },
    suggestion: {
      type: ["object", "null"],
      properties: { title: { type: "string" }, text: { type: "string" }, why: { type: "string" }, to_confirm: { type: "array", items: { type: "string" } } },
    },
    summary: { type: "string" },
  },
  required: ["questions", "objections", "suggestion", "summary"],
} as const;

const SPEAKER_FR = { coach: "COACH", prospect: "PROSPECT", unknown: "INCONNU" } as const;

export interface LlmPromptInput {
  state: MeetingState;
  /** Segments not yet seen by the LLM. */
  newSegments: Segment[];
  /** A few previous segments for context. */
  contextSegments: Segment[];
}

export function buildLlmMessages(input: LlmPromptInput): { role: "system" | "user"; content: string }[] {
  const { state, newSegments, contextSegments } = input;
  const qn = state.questionnaire;
  const questions = qn.questions
    .map((q) => {
      const s = state.questions[q.id];
      return `- ${q.id} | ${q.label} | statut actuel: ${s.status}${s.manual ? " (validé par le coach)" : ""}`;
    })
    .join("\n");
  const fmt = (s: Segment) => `[${s.id}] ${SPEAKER_FR[s.speaker]}: ${s.text}`;
  const user = `Rendez-vous ${qn.type}. Étapes possibles : ${qn.phases.join(", ")}.

Questionnaire (id | sujet | statut) :
${questions}

Résumé incrémental jusqu'ici :
${state.rollingSummary || "(aucun)"}

Contexte précédent :
${contextSegments.map(fmt).join("\n") || "(aucun)"}

NOUVEAUX échanges à analyser :
${newSegments.map(fmt).join("\n")}

Réponds en JSON avec :
- "phase": étape actuelle parmi la liste,
- "questions": sujets du questionnaire traités ou partiellement traités dans les NOUVEAUX échanges (id exact, extrait exact, segment_id exact, confidence 0..1),
- "objections": objections explicites ou demandes de clarification du prospect (kind parmi ${objectionKinds.join(", ")}),
- "suggestion": une seule suggestion courte pour le coach, ou null,
- "summary": le résumé incrémental mis à jour (5 phrases maximum, faits uniquement).`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** Parses the raw model output. Returns null when it is not valid JSON or does not match the schema. */
export function parseLlmOutput(raw: string): LlmAnalysis | null {
  let text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1];
  try {
    const parsed = LlmAnalysisSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Anti-hallucination: the excerpt must really appear in the referenced segment. */
function excerptIsGrounded(seg: Segment | undefined, ex: string): boolean {
  if (!seg) return false;
  const a = normalize(seg.text);
  const b = normalize(ex).replace(/…$/, "").trim();
  if (!b) return false;
  if (a.includes(b)) return true;
  // Tolerate small paraphrases: at least 70 % of the excerpt's words are in the segment.
  const words = b.split(" ").filter((w) => w.length > 2);
  if (!words.length) return false;
  const present = words.filter((w) => a.includes(w)).length;
  return present / words.length >= 0.7;
}

export interface MergeResult {
  state: MeetingState;
  suggestion: Suggestion | null;
  rejected: number;
}

export function mergeLlmAnalysis(state: MeetingState, analysis: LlmAnalysis, segments: Segment[]): MergeResult {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const questions = { ...state.questions };
  let rejected = 0;

  for (const q of analysis.questions) {
    const seg = byId.get(q.segment_id);
    if (!questions[q.id] || !excerptIsGrounded(seg, q.excerpt)) {
      rejected += 1;
      continue;
    }
    questions[q.id] = upgradeQuestion(questions[q.id], {
      status: q.status,
      confidence: Math.min(0.9, q.confidence),
      evidence: { segmentId: q.segment_id, excerpt: excerpt(seg!.text) },
      answer: q.answer || excerpt(seg!.text, 200),
      origin: "llm",
    });
  }

  let objections = state.objections;
  for (const o of analysis.objections) {
    const seg = byId.get(o.segment_id);
    if (!seg || seg.speaker === "coach" || !excerptIsGrounded(seg, o.excerpt)) {
      rejected += 1;
      continue;
    }
    if (objections.some((x) => x.kind === o.kind && !x.resolved && !x.dismissed)) continue;
    objections = [
      ...objections,
      { id: uid("obj"), kind: o.kind, label: OBJECTION_LABELS[o.kind], evidence: { segmentId: seg.id, excerpt: excerpt(seg.text) }, resolved: false, dismissed: false },
    ];
  }

  const suggestion: Suggestion | null = analysis.suggestion
    ? {
        id: uid("llm"),
        kind: "llm",
        priority: 1,
        phase: analysis.phase,
        title: analysis.suggestion.title,
        text: analysis.suggestion.text,
        why: analysis.suggestion.why || "Proposé par l'IA locale.",
        evidence: [],
        toConfirm: analysis.suggestion.to_confirm,
        variant: 0,
      }
    : null;

  return {
    state: { ...state, questions, objections, rollingSummary: analysis.summary || state.rollingSummary },
    suggestion,
    rejected,
  };
}

/**
 * Throttles LLM refreshes: at most one call in flight, a minimum interval
 * between calls, and only when new segments arrived.
 */
export class LlmScheduler {
  private inFlight = false;
  private lastStart = -Infinity;
  private seen = new Set<string>();
  public lastLatencyMs: number | null = null;
  public calls = 0;

  constructor(public minIntervalMs = 15000, public maxSegmentsPerCall = 8) {}

  pending(segments: Segment[]): Segment[] {
    return segments.filter((s) => !this.seen.has(s.id) && s.text.trim());
  }

  shouldRun(now: number, segments: Segment[]): boolean {
    return !this.inFlight && now - this.lastStart >= this.minIntervalMs && this.pending(segments).length > 0;
  }

  /** Marks the start of a call and returns the batch to send. */
  begin(now: number, segments: Segment[]): Segment[] {
    this.inFlight = true;
    this.lastStart = now;
    this.calls += 1;
    const batch = this.pending(segments).slice(-this.maxSegmentsPerCall);
    // Older unseen segments beyond the batch are covered by the rule engine only.
    for (const s of this.pending(segments)) this.seen.add(s.id);
    return batch;
  }

  end(now: number): void {
    this.inFlight = false;
    this.lastLatencyMs = now - this.lastStart;
  }

  get busy(): boolean {
    return this.inFlight;
  }
}
