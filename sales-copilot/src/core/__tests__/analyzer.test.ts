import { analyzeAll, analyzeSegment, coverage, createMeetingState, currentPhase, reanalyze, setQuestionManually } from "../analyzer";
import { R1_CONVERSATION, R2_CONVERSATION, toSegments } from "../fixtures/conversations";
import { defaultQuestionnaire } from "../questionnaires";

describe("questionnaires", () => {
  it("R1 and R2 each contain 18 questions with unique ids", () => {
    for (const t of ["R1", "R2"] as const) {
      const q = defaultQuestionnaire(t);
      expect(q.questions).toHaveLength(18);
      expect(new Set(q.questions.map((x) => x.id)).size).toBe(18);
      for (const x of q.questions) expect(q.phases).toContain(x.phase);
    }
  });
});

describe("R1 analysis on a fictional conversation", () => {
  const segments = toSegments("m1", R1_CONVERSATION);
  const state = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segments);

  it("marks spontaneously given previous attempts as covered (out of order)", () => {
    const q = state.questions["r1_attempts"];
    expect(q.status).toBe("covered");
    expect(q.evidence[0].excerpt).toContain("Weight Watchers");
    expect(q.confidence).toBeGreaterThan(0.5);
  });

  it("detects the objective, obstacles, budget and availability", () => {
    expect(state.questions["r1_objective"].status).toBe("covered");
    expect(state.questions["r1_obstacles"].status).toBe("covered");
    expect(state.questions["r1_budget"].status).toBe("covered");
    expect(state.questions["r1_availability"].status).not.toBe("not_covered");
  });

  it("leaves topics never discussed as not covered", () => {
    expect(state.questions["r1_decision_makers"].status).toBe("not_covered");
    expect(state.questions["r1_health"].status).toBe("not_covered");
  });

  it("extracts facts (budget, frequency, weight goal)", () => {
    expect(state.facts.budgetAmounts).toContain(800);
    expect(state.facts.sessionsPerWeek).toBe(2);
    expect(state.facts.weightGoalKg).toBe(8);
  });

  it("detects explicit doubt and a clarification request from the prospect", () => {
    const kinds = state.objections.map((o) => o.kind);
    expect(kinds).toContain("doubt");
    expect(kinds).toContain("clarification");
  });

  it("is idempotent: replaying a segment changes nothing", () => {
    const again = analyzeSegment(state, segments[3]);
    expect(again).toBe(state);
  });

  it("reports coverage", () => {
    const c = coverage(state);
    expect(c.total).toBe(18);
    expect(c.covered).toBeGreaterThanOrEqual(5);
  });
});

describe("manual validation and speaker correction", () => {
  it("never overrides a manual validation", () => {
    let state = createMeetingState(defaultQuestionnaire("R1"));
    state = setQuestionManually(state, "r1_attempts", "not_covered");
    state = analyzeAll(state, toSegments("m2", R1_CONVERSATION));
    expect(state.questions["r1_attempts"].status).toBe("not_covered");
    expect(state.questions["r1_attempts"].manual).toBe(true);
  });

  it("re-analysis after correcting a speaker changes the attribution", () => {
    const segs = toSegments("m3", [["coach", "J'ai fait Weight Watchers puis un abonnement en salle de sport."]]);
    let state = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segs);
    expect(state.questions["r1_attempts"].status).toBe("not_covered");
    const corrected = segs.map((s) => ({ ...s, speaker: "prospect" as const, edited: true }));
    state = reanalyze(state, corrected);
    expect(state.questions["r1_attempts"].status).toBe("covered");
  });

  it("a coach question followed by a prospect reply counts as an answer", () => {
    const segs = toSegments("m4", [
      ["coach", "Qu'avez-vous déjà essayé par le passé ?"],
      ["prospect", "Pas grand-chose honnêtement, quelques vidéos sur internet."],
    ]);
    const state = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segs);
    expect(state.questions["r1_attempts"].status).toBe("covered");
    expect(state.questions["r1_attempts"].evidence.map((e) => e.segmentId)).toContain("m4_s2");
  });
});

describe("R2 analysis", () => {
  const state = analyzeAll(createMeetingState(defaultQuestionnaire("R2")), toSegments("r2", R2_CONVERSATION));
  it("recognises items delivered by the coach", () => {
    expect(state.questions["r2_method"].status).toBe("covered");
    expect(state.questions["r2_offer"].status).toBe("covered");
    expect(state.questions["r2_price"].status).not.toBe("not_covered");
  });
  it("detects price, commitment, reflection and third-party objections", () => {
    const kinds = state.objections.map((o) => o.kind);
    for (const k of ["price", "commitment", "think", "third_party"]) expect(kinds).toContain(k);
  });
  it("estimates the current phase", () => {
    expect(state.questionnaire.phases).toContain(currentPhase(state));
  });
});
