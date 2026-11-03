// Domain types shared by the UI, the analysis engine and the Tauri backend bridge.

export type MeetingType = "R1" | "R2";
export type Speaker = "coach" | "prospect" | "unknown";
export type QuestionStatus = "not_covered" | "partial" | "covered";
export type AiMode = "local" | "hybrid" | "deep";

/** One transcribed (or typed) utterance. */
export interface Segment {
  id: string;
  meetingId: string;
  /** Milliseconds since the meeting started. */
  startMs: number;
  endMs: number;
  speaker: Speaker;
  text: string;
  /** 0..1 when provided by the speech engine, null otherwise. */
  confidence: number | null;
  /** "whisper" for automatic transcription, "manual" for text typed by the coach. */
  source: "whisper" | "manual";
  edited: boolean;
}

export interface Question {
  id: string;
  label: string;
  /** Suggested wording the coach can use. */
  ask: string;
  phase: string;
  /** Cues (accent-insensitive, lowercase) indicating the prospect answered this topic. */
  answerCues: string[];
  /** Cues indicating the coach asked about this topic. */
  askCues: string[];
  /** Marks topics that may involve health data (RGPD art. 9). */
  sensitive?: boolean;
  /** R2 items delivered by the coach (presentation): the coach saying it covers it. */
  coachDelivers?: boolean;
}

export interface Questionnaire {
  type: MeetingType;
  version: number;
  phases: string[];
  questions: Question[];
}

export interface Evidence {
  segmentId: string;
  excerpt: string;
}

export interface QuestionState {
  questionId: string;
  status: QuestionStatus;
  answer: string | null;
  evidence: Evidence[];
  /** 0..1 */
  confidence: number;
  /** Set when the coach validated or corrected the status by hand — never overwritten automatically. */
  manual: boolean;
  /** Who last updated it. */
  origin: "rules" | "llm" | "manual" | "none";
}

export type ObjectionKind =
  | "price"
  | "time"
  | "think"
  | "third_party"
  | "doubt"
  | "commitment"
  | "distance"
  | "clarification";

export interface DetectedObjection {
  id: string;
  kind: ObjectionKind;
  label: string;
  evidence: Evidence;
  resolved: boolean;
  dismissed: boolean;
}

export interface Suggestion {
  id: string;
  kind: "question" | "objection" | "confirm" | "reformulation" | "llm";
  priority: 1 | 2 | 3;
  phase: string;
  title: string;
  /** Short wording the coach can say. */
  text: string;
  why: string;
  evidence: Evidence[];
  toConfirm: string[];
  /** Index into alternative wordings, for "autre formulation". */
  variant: number;
}

export interface Offer {
  id: string;
  name: string;
  /** Display string — never computed, never invented. Empty means "à définir". */
  priceLabel: string;
  /** Monthly price used only for budget comparison; null when unknown. */
  monthlyPriceMin: number | null;
  monthlyPriceMax: number | null;
  oneTimePrice: number | null;
  commitments: string;
  inclusions: string[];
  exclusions: string[];
  goal: string;
  guarantee: string;
  active: boolean;
}

export interface Prospect {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  objective: string;
  currentSituation: string;
  previousAttempts: string;
  obstacles: string;
  constraints: string;
  budget: string;
  autonomy: string;
  decisionCriteria: string;
  coachNotes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Meeting {
  id: string;
  prospectId: string;
  type: MeetingType;
  scheduledAt: string;
  status: "planned" | "live" | "done";
  consentGiven: boolean;
  consentAt: string | null;
  /** When false (default) the meeting content is purged automatically. */
  retain: boolean;
  decision: string;
  nextAction: string;
  debriefJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationObservation {
  key:
    | "precision"
    | "detail"
    | "simplicity"
    | "security"
    | "results"
    | "examples";
  label: string;
  count: number;
  evidence: Evidence[];
}

export interface Recommendation {
  offerId: string | null;
  offerName: string | null;
  reasons: string[];
  missing: string[];
  alternatives: { offerId: string; offerName: string; reason: string }[];
  sufficient: boolean;
}

export interface Debrief {
  generatedAt: string;
  meetingType: MeetingType;
  prospectName: string;
  summary: string;
  objective: string;
  difficulties: string[];
  needs: string[];
  questionsAndObjections: string[];
  answersGiven: string[];
  missingInformation: string[];
  recommendedOffer: string;
  decision: string;
  nextAction: string;
  coachImprovements: string[];
  coverage: { covered: number; partial: number; total: number };
  talkRatio: { coach: number; prospect: number };
}
