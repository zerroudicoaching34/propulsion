import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  analyzeSegment,
  clearManual,
  coverage,
  createMeetingState,
  reanalyze,
  setObjectionFlag,
  setQuestionManually,
  type MeetingState,
} from "../core/analyzer";
import { LLM_JSON_SCHEMA, LlmScheduler, buildLlmMessages, mergeLlmAnalysis, parseLlmOutput } from "../core/llm";
import type { Prospect, QuestionStatus, Segment, Speaker, Suggestion } from "../core/types";
import { api, errorMessage, isTauri, on, type AppInfo, type AppSettings, type AudioStatus, type StoredMeeting } from "./api";
import { loadKnowledgeBase, type KnowledgeBase } from "./kb";

export type Screen = "dashboard" | "prospects" | "live" | "analysis" | "debrief" | "settings";

export interface LiveSession {
  meeting: StoredMeeting;
  prospect: Prospect | null;
  segments: Segment[];
  state: MeetingState;
  dismissed: string[];
  variants: Record<string, number>;
  llmSuggestion: Suggestion | null;
}

export interface LlmInfo {
  status: "off" | "idle" | "running" | "error" | "unavailable";
  lastLatencyMs: number | null;
  calls: number;
  rejected: number;
  message: string | null;
}

interface Store {
  ready: boolean;
  fatal: string | null;
  info: AppInfo | null;
  settings: AppSettings | null;
  kb: KnowledgeBase | null;
  screen: Screen;
  go: (s: Screen) => void;
  toast: string | null;
  notify: (msg: string) => void;
  reloadSettings: () => Promise<void>;
  reloadKb: () => Promise<void>;
  // live session
  session: LiveSession | null;
  openMeeting: (meetingId: string, screen?: Screen) => Promise<void>;
  closeMeeting: () => void;
  refreshMeeting: () => Promise<void>;
  audio: AudioStatus | null;
  refreshAudio: () => Promise<void>;
  audioLevel: number;
  transcriptionLatencyMs: number | null;
  llm: LlmInfo;
  setSpeaker: (s: Speaker) => Promise<void>;
  addManualSegment: (speaker: Speaker, text: string) => Promise<void>;
  correctSegment: (id: string, patch: { speaker?: Speaker; text?: string }) => Promise<void>;
  deleteSegment: (id: string) => Promise<void>;
  setQuestion: (questionId: string, status: QuestionStatus | "auto") => void;
  flagObjection: (id: string, flag: "resolved" | "dismissed") => void;
  dismissSuggestion: (id: string) => void;
  otherWording: (id: string) => void;
  persistAnalysis: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("Store missing");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [toast, setToast] = useState<string | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null);
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [trLatency, setTrLatency] = useState<number | null>(null);
  const [llm, setLlm] = useState<LlmInfo>({ status: "off", lastLatencyMs: null, calls: 0, rejected: 0, message: null });

  const sessionRef = useRef<LiveSession | null>(null);
  sessionRef.current = session;
  const settingsRef = useRef<AppSettings | null>(null);
  settingsRef.current = settings;
  const scheduler = useRef(new LlmScheduler());
  const dirty = useRef(false);
  // Clock for notes typed by the coach: continues after the last segment.
  const manualClock = useRef(Date.now());

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4500);
  }, []);

  const reloadSettings = useCallback(async () => setSettings(await api.settingsGet()), []);
  const reloadKb = useCallback(async () => setKb(await loadKnowledgeBase()), []);

  useEffect(() => {
    if (!isTauri()) {
      setFatal("Cette interface doit être ouverte dans l'application Smart & Strong Copilot (Tauri), pas dans un navigateur.");
      return;
    }
    (async () => {
      try {
        const [i, s] = await Promise.all([api.appInfo(), api.settingsGet()]);
        setInfo(i);
        setSettings(s);
        setKb(await loadKnowledgeBase());
        setAudio(await api.audioStatus());
        setReady(true);
      } catch (e) {
        setFatal(errorMessage(e));
      }
    })();
  }, []);

  // ---- session state updates ----
  const update = useCallback((fn: (s: LiveSession) => LiveSession) => {
    setSession((cur) => {
      if (!cur) return cur;
      dirty.current = true;
      return fn(cur);
    });
  }, []);

  const openMeeting = useCallback(
    async (meetingId: string, target: Screen = "live") => {
      if (!kb) return;
      const meeting = await api.meetingGet(meetingId);
      if (!meeting) {
        notify("Rendez-vous introuvable");
        return;
      }
      const [prospect, segments] = await Promise.all([api.prospectGet(meeting.prospectId), api.segmentList(meetingId)]);
      let state: MeetingState | null = null;
      if (meeting.analysisJson) {
        try {
          state = JSON.parse(meeting.analysisJson) as MeetingState;
        } catch {
          state = null;
        }
      }
      if (!state) state = createMeetingState(structuredClone(kb.questionnaires[meeting.type]));
      // Analyse any segment not processed yet (idempotent).
      for (const s of segments) state = analyzeSegment(state, s);
      scheduler.current = new LlmScheduler((settingsRef.current?.llmIntervalSec ?? 20) * 1000);
      // Segments already present are not re-sent to the LLM.
      if (segments.length) scheduler.current.begin(-Infinity, segments), scheduler.current.end(0);
      scheduler.current.lastLatencyMs = null;
      setLlm((l) => ({ ...l, calls: 0, rejected: 0, lastLatencyMs: null }));
      manualClock.current = Date.now() - (segments.length ? segments[segments.length - 1].endMs : 0);
      setSession({ meeting, prospect, segments, state, dismissed: [], variants: {}, llmSuggestion: null });
      setScreen(target);
    },
    [kb, notify],
  );

  const refreshMeeting = useCallback(async () => {
    const cur = sessionRef.current;
    if (!cur) return;
    const meeting = await api.meetingGet(cur.meeting.id);
    if (meeting) setSession((s) => (s ? { ...s, meeting } : s));
  }, []);

  const persistAnalysis = useCallback(async () => {
    const cur = sessionRef.current;
    if (!cur) return;
    dirty.current = false;
    const cov = coverage(cur.state);
    const kinds = [...new Set(cur.state.objections.filter((o) => !o.dismissed).map((o) => o.kind))].join(",");
    try {
      await api.meetingUpdate(cur.meeting.id, {
        analysisJson: JSON.stringify(cur.state),
        objectionKinds: kinds,
        coverageCovered: cov.covered,
        coverageTotal: cov.total,
      });
    } catch (e) {
      notify(`Sauvegarde : ${errorMessage(e)}`);
    }
  }, [notify]);

  const closeMeeting = useCallback(() => {
    void persistAnalysis();
    setSession(null);
  }, [persistAnalysis]);

  // Save the analysis every few seconds when it changed.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (dirty.current) void persistAnalysis();
    }, 4000);
    return () => window.clearInterval(t);
  }, [persistAnalysis]);

  // ---- backend events ----
  useEffect(() => {
    if (!isTauri()) return;
    const subs = [
      on<Segment>("transcript:segment", (seg) => {
        update((s) => (seg.meetingId !== s.meeting.id ? s : { ...s, segments: [...s.segments, seg], state: analyzeSegment(s.state, seg) }));
      }),
      on<{ ms: number }>("transcript:latency", (p) => setTrLatency(p.ms)),
      on<{ level: number }>("audio:level", (p) => setAudioLevel(p.level)),
      on<{ state: AudioStatus["state"]; message: string | null }>("audio:state", async (p) => {
        setAudio(await api.audioStatus());
        if (p.state === "error" && p.message) notify(p.message);
      }),
      on<{ message: string }>("audio:error", (p) => notify(p.message)),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [update, notify]);

  // ---- local LLM loop (throttled, never sends anything outside the machine) ----
  useEffect(() => {
    const t = window.setInterval(async () => {
      const cur = sessionRef.current;
      const s = settingsRef.current;
      if (!cur || !s) return;
      if (!s.llmEnabled) {
        setLlm((l) => (l.status === "off" ? l : { ...l, status: "off" }));
        return;
      }
      const sched = scheduler.current;
      sched.minIntervalMs = s.llmIntervalSec * 1000;
      if (!sched.shouldRun(Date.now(), cur.segments)) return;
      const ctxStart = Math.max(0, cur.segments.length - 14);
      const batch = sched.begin(Date.now(), cur.segments);
      const context = cur.segments.slice(ctxStart).filter((x) => !batch.includes(x)).slice(-6);
      setLlm((l) => ({ ...l, status: "running", calls: sched.calls }));
      try {
        const reply = await api.ollamaChat(buildLlmMessages({ state: cur.state, newSegments: batch, contextSegments: context }), LLM_JSON_SCHEMA);
        sched.end(Date.now());
        const parsed = parseLlmOutput(reply.content);
        if (!parsed) {
          setLlm((l) => ({ ...l, status: "error", lastLatencyMs: sched.lastLatencyMs, message: "Réponse de l'IA locale invalide (ignorée)" }));
          return;
        }
        let rejected = 0;
        update((sess) => {
          const merged = mergeLlmAnalysis(sess.state, parsed, sess.segments);
          rejected = merged.rejected;
          return { ...sess, state: merged.state, llmSuggestion: merged.suggestion ?? sess.llmSuggestion };
        });
        setLlm((l) => ({ ...l, status: "idle", lastLatencyMs: sched.lastLatencyMs, rejected: l.rejected + rejected, message: null }));
      } catch (e) {
        sched.end(Date.now());
        setLlm((l) => ({ ...l, status: "unavailable", lastLatencyMs: null, message: errorMessage(e) }));
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [update]);

  // ---- actions ----
  const refreshAudio = useCallback(async () => setAudio(await api.audioStatus()), []);

  const setSpeaker = useCallback(async (sp: Speaker) => {
    await api.audioSetSpeaker(sp);
    setAudio(await api.audioStatus());
  }, []);

  const addManualSegment = useCallback(
    async (speaker: Speaker, text: string) => {
      const cur = sessionRef.current;
      if (!cur) return;
      const last = cur.segments[cur.segments.length - 1];
      const elapsed = Date.now() - manualClock.current;
      const seg = await api.segmentAdd(cur.meeting.id, speaker, text, Math.max(elapsed, last ? last.endMs + 1 : 0));
      update((s) => ({ ...s, segments: [...s.segments, seg], state: analyzeSegment(s.state, seg) }));
    },
    [update],
  );

  const correctSegment = useCallback(
    async (id: string, patch: { speaker?: Speaker; text?: string }) => {
      const seg = await api.segmentUpdate(id, patch);
      update((s) => {
        const segments = s.segments.map((x) => (x.id === id ? seg : x));
        return { ...s, segments, state: reanalyze(s.state, segments) };
      });
    },
    [update],
  );

  const deleteSegment = useCallback(
    async (id: string) => {
      await api.segmentDelete(id);
      update((s) => {
        const segments = s.segments.filter((x) => x.id !== id);
        return { ...s, segments, state: reanalyze(s.state, segments) };
      });
    },
    [update],
  );

  const setQuestion = useCallback(
    (questionId: string, status: QuestionStatus | "auto") => {
      update((s) => ({
        ...s,
        state: status === "auto" ? reanalyze(clearManual(s.state, questionId), s.segments) : setQuestionManually(s.state, questionId, status),
      }));
    },
    [update],
  );

  const flagObjection = useCallback((id: string, flag: "resolved" | "dismissed") => update((s) => ({ ...s, state: setObjectionFlag(s.state, id, flag) })), [update]);
  const dismissSuggestion = useCallback(
    (id: string) => update((s) => ({ ...s, dismissed: [...s.dismissed, id], llmSuggestion: s.llmSuggestion?.id === id ? null : s.llmSuggestion })),
    [update],
  );
  const otherWording = useCallback((id: string) => update((s) => ({ ...s, variants: { ...s.variants, [id]: (s.variants[id] ?? 0) + 1 } })), [update]);

  const value = useMemo<Store>(
    () => ({
      ready, fatal, info, settings, kb, screen, go: setScreen, toast, notify, reloadSettings, reloadKb,
      session, openMeeting, closeMeeting, refreshMeeting, audio, refreshAudio, audioLevel, transcriptionLatencyMs: trLatency, llm,
      setSpeaker, addManualSegment, correctSegment, deleteSegment, setQuestion, flagObjection, dismissSuggestion, otherWording, persistAnalysis,
    }),
    [ready, fatal, info, settings, kb, screen, toast, notify, reloadSettings, reloadKb, session, openMeeting, closeMeeting, refreshMeeting, audio, refreshAudio, audioLevel, trLatency, llm, setSpeaker, addManualSegment, correctSegment, deleteSegment, setQuestion, flagObjection, dismissSuggestion, otherWording, persistAnalysis],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

