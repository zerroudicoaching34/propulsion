import { analyzeAll, createMeetingState, setObjectionFlag } from "../analyzer";
import { buildCloudPayload, payloadHash, redact } from "../cloud";
import { buildDebrief, debriefToJson, debriefToMarkdown, detectDecision, talkRatio } from "../debrief";
import { R1_CONVERSATION, R2_CONVERSATION, toSegments } from "../fixtures/conversations";
import { LlmScheduler, buildLlmMessages, mergeLlmAnalysis, parseLlmOutput } from "../llm";
import { defaultOffers } from "../offers";
import { debriefToPdf } from "../pdf";
import { observePreferences } from "../preferences";
import { defaultQuestionnaire } from "../questionnaires";
import { buildNeedProfile, recommendOffer } from "../recommendation";
import { MAX_SUGGESTIONS, buildSuggestions } from "../suggestions";
import type { Prospect } from "../types";

const prospect: Prospect = {
  id: "p1", firstName: "Camille", lastName: "Martin", email: "camille.martin@example.com", phone: "06 12 34 56 78",
  objective: "", currentSituation: "", previousAttempts: "", obstacles: "", constraints: "", budget: "", autonomy: "",
  decisionCriteria: "", coachNotes: "", createdAt: "", updatedAt: "",
};

const r1Segments = toSegments("m1", R1_CONVERSATION);
const r1State = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), r1Segments);

describe("live suggestions", () => {
  it("never returns more than three suggestions", () => {
    const s = buildSuggestions(r1State, { dismissed: [], variants: {}, llmSuggestion: { id: "llm1", kind: "llm", priority: 1, phase: "", title: "t", text: "x", why: "", evidence: [], toConfirm: [], variant: 0 } });
    expect(s.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });

  it("prioritises the latest open objection, then the next missing question", () => {
    const s = buildSuggestions(r1State, { dismissed: [], variants: {} });
    expect(s[0].kind === "objection" || s[0].kind === "reformulation").toBe(true);
    expect(s[0].evidence[0].excerpt.length).toBeGreaterThan(0);
    expect(s.some((x) => x.kind === "question")).toBe(true);
  });

  it("supports dismissing and asking for another wording", () => {
    const first = buildSuggestions(r1State, { dismissed: [], variants: {} });
    const q = first.find((x) => x.kind === "question")!;
    const other = buildSuggestions(r1State, { dismissed: [], variants: { [q.id]: 1 } }).find((x) => x.id === q.id)!;
    expect(other.text).not.toBe(q.text);
    const without = buildSuggestions(r1State, { dismissed: [q.id], variants: {} });
    expect(without.find((x) => x.id === q.id)).toBeUndefined();
  });

  it("drops objection suggestions once the coach marks them handled", () => {
    let st = r1State;
    for (const o of st.objections) st = setObjectionFlag(st, o.id, "resolved");
    const s = buildSuggestions(st, { dismissed: [], variants: {} });
    expect(s.some((x) => x.kind === "objection" || x.kind === "reformulation")).toBe(false);
  });
});

describe("offer recommendation", () => {
  const offers = defaultOffers();

  it("orients the fictional R1 prospect (needs a frame, 2x/week, can travel, 800 €) to Advanced with reasons", () => {
    const reco = recommendOffer(buildNeedProfile(prospect, r1Segments, r1State.facts), offers);
    expect(reco.offerId).toBe("advanced");
    expect(reco.reasons.length).toBeGreaterThan(0);
  });

  it("orients an autonomous remote prospect asking for programming to Online Pilotage", () => {
    const segs = toSegments("o", [["prospect", "Je suis autonome, je m'entraîne seul à la maison, mais je veux un programme personnalisé à distance. Mon budget c'est 200 euros."]]);
    const st = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segs);
    expect(recommendOffer(buildNeedProfile(null, segs, st.facts), offers).offerId).toBe("online");
  });

  it("orients a simple weekly practice to Basic", () => {
    const segs = toSegments("b", [["prospect", "Je veux juste quelque chose de simple, une fois par semaine pour garder la régularité, je peux venir, j'ai 300 euros."]]);
    const st = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segs);
    expect(recommendOffer(buildNeedProfile(null, segs, st.facts), offers).offerId).toBe("basic");
  });

  it("orients an autonomous learner to Evergreen", () => {
    const segs = toSegments("e", [["prospect", "Je suis autonome et je veux apprendre la méthode à mon rythme, une formation me suffit."]]);
    expect(recommendOffer(buildNeedProfile(null, segs, { budgetAmounts: [], sessionsPerWeek: null, weightGoalKg: null }), offers).offerId).toBe("evergreen");
  });

  it("says when information is insufficient and never defaults to the most expensive offer", () => {
    const reco = recommendOffer(buildNeedProfile(null, [], { budgetAmounts: [], sessionsPerWeek: null, weightGoalKg: null }), offers);
    expect(reco.offerId).toBeNull();
    expect(reco.sufficient).toBe(false);
    expect(reco.missing.length).toBeGreaterThan(2);
  });

  it("never recommends Elite without an explicit premium request", () => {
    const segs = toSegments("x", [["prospect", "Je veux une transformation intensive, trois fois par semaine, j'ai besoin d'un cadre, budget 2000 euros, je peux venir."]]);
    const st = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segs);
    expect(recommendOffer(buildNeedProfile(null, segs, st.facts), offers).offerId).not.toBe("elite");
  });
});

describe("communication preferences", () => {
  it("returns observations backed by excerpts, prospect words only", () => {
    const obs = observePreferences(r1Segments);
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(o.evidence.length).toBeGreaterThan(0);
      for (const e of o.evidence) expect(r1Segments.find((s) => s.id === e.segmentId)?.speaker).toBe("prospect");
    }
  });
});

describe("debrief and exports", () => {
  const r2Segments = toSegments("m2", R2_CONVERSATION);
  const r2State = analyzeAll(createMeetingState(defaultQuestionnaire("R2")), r2Segments);
  const debrief = buildDebrief({ state: r2State, segments: r2Segments, prospect, meeting: { type: "R2", decision: "", nextAction: "" }, offers: defaultOffers() });

  it("reports the decision actually expressed, not an invented one", () => {
    expect(detectDecision(r2Segments).label).toBe("Souhaite réfléchir");
    expect(debrief.decision).toContain("Souhaite réfléchir");
    expect(debrief.nextAction).toContain("lundi");
  });

  it("computes the talk ratio", () => {
    const r = talkRatio(r2Segments);
    expect(r.coach + r.prospect).toBe(100);
  });

  it("exports Markdown, JSON and PDF", () => {
    const md = debriefToMarkdown(debrief);
    expect(md).toContain("# Débriefing R2 — Camille Martin");
    expect(md).toContain("## Décision réellement exprimée");
    expect(JSON.parse(debriefToJson(debrief)).meetingType).toBe("R2");
    const pdf = debriefToPdf(debrief);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe("local LLM layer", () => {
  const base = createMeetingState(defaultQuestionnaire("R1"));
  const segs = toSegments("l", [["prospect", "J'ai essayé le jeûne intermittent il y a deux ans."]]);

  it("builds a compact prompt with only new and context segments", () => {
    const msgs = buildLlmMessages({ state: base, newSegments: segs, contextSegments: [] });
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("[l_s1] PROSPECT");
    expect(msgs[1].content).toContain("r1_attempts");
  });

  it("rejects invalid JSON and schema violations", () => {
    expect(parseLlmOutput("not json")).toBeNull();
    expect(parseLlmOutput('{"questions":[{"id":"x"}]}')).toBeNull();
  });

  it("merges grounded results and rejects hallucinated excerpts", () => {
    const raw = JSON.stringify({
      phase: "Exploration",
      questions: [
        { id: "r1_attempts", status: "covered", answer: "Jeûne intermittent", segment_id: "l_s1", excerpt: "J'ai essayé le jeûne intermittent", confidence: 0.8 },
        { id: "r1_budget", status: "covered", segment_id: "l_s1", excerpt: "mon budget est de 500 euros", confidence: 0.9 },
        { id: "unknown_q", status: "covered", segment_id: "l_s1", excerpt: "J'ai essayé", confidence: 0.9 },
      ],
      objections: [],
      suggestion: { title: "Approfondir", text: "Qu'est-ce qui vous a fait arrêter ?", why: "", to_confirm: [] },
      summary: "Le prospect a déjà essayé le jeûne intermittent.",
    });
    const parsed = parseLlmOutput("```json\n" + raw + "\n```");
    expect(parsed).not.toBeNull();
    const merged = mergeLlmAnalysis(base, parsed!, segs);
    expect(merged.state.questions["r1_attempts"].status).toBe("covered");
    expect(merged.state.questions["r1_attempts"].origin).toBe("llm");
    expect(merged.state.questions["r1_budget"].status).toBe("not_covered");
    expect(merged.rejected).toBe(2);
    expect(merged.suggestion?.text).toContain("arrêter");
    expect(merged.state.rollingSummary).toContain("jeûne");
  });

  it("throttles calls: one in flight, minimum interval, only with new segments", () => {
    const sched = new LlmScheduler(10_000);
    expect(sched.shouldRun(0, [])).toBe(false);
    expect(sched.shouldRun(0, segs)).toBe(true);
    const batch = sched.begin(0, segs);
    expect(batch).toHaveLength(1);
    expect(sched.shouldRun(20_000, segs)).toBe(false); // in flight + nothing new
    sched.end(1500);
    expect(sched.lastLatencyMs).toBe(1500);
    const more = [...segs, ...toSegments("l2", [["prospect", "Et aussi la course à pied."]])];
    expect(sched.shouldRun(5_000, more)).toBe(false); // too soon
    expect(sched.shouldRun(10_000, more)).toBe(true);
  });
});

describe("cloud payload preparation (no network)", () => {
  it("redacts names, emails and phone numbers", () => {
    const out = redact("Camille Martin, camille.martin@example.com, 06 12 34 56 78, tél +33 6 98 76 54 32", prospect, { names: true, contacts: true });
    expect(out).not.toMatch(/Camille|Martin|@|06 12/);
    expect(out).toContain("[Prénom]");
    expect(out).toContain("[téléphone]");
  });

  it("builds a payload and a stable SHA-256 hash", async () => {
    const payload = buildCloudPayload("deep_analysis", r1Segments.slice(0, 2), prospect, { names: true, contacts: true }, "R1");
    expect(payload).not.toContain("Camille");
    const h1 = await payloadHash(payload);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await payloadHash(payload)).toBe(h1);
    expect(await payloadHash(payload + " ")).not.toBe(h1);
    expect(await payloadHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("elite is never pushed", () => {
  it("does not list Elite as an alternative without an explicit premium request", () => {
    const segs = toSegments("y", [["prospect", "Je veux une transformation, deux fois par semaine, j'ai besoin d'un cadre, je peux venir, budget 900 euros."]]);
    const st = analyzeAll(createMeetingState(defaultQuestionnaire("R1")), segs);
    const reco = recommendOffer(buildNeedProfile(null, segs, st.facts), defaultOffers());
    expect(reco.alternatives.map((a) => a.offerId)).not.toContain("elite");
  });
});
