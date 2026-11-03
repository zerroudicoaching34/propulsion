import { useEffect, useMemo, useRef, useState } from "react";
import { CloudDialog } from "../components/CloudDialog";
import { Card, Confidence, Empty, SPEAKER_CLS, SPEAKER_LABEL, StatusChip, formatDate, formatMs } from "../components/ui";
import { coverage, currentPhase } from "../core/analyzer";
import { buildSuggestions } from "../core/suggestions";
import type { QuestionStatus, Segment, Speaker } from "../core/types";
import { api, errorMessage, type StoredMeeting } from "../lib/api";
import { useStore } from "../lib/store";

const NEXT_STATUS: Record<QuestionStatus, QuestionStatus> = { not_covered: "partial", partial: "covered", covered: "not_covered" };

function MeetingPicker() {
  const { openMeeting, go, notify } = useStore();
  const [meetings, setMeetings] = useState<StoredMeeting[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    Promise.all([api.meetingList(), api.prospectList()])
      .then(([m, p]) => {
        setMeetings(m.filter((x) => x.status !== "done"));
        setNames(Object.fromEntries(p.map((x) => [x.id, `${x.firstName} ${x.lastName}`])));
      })
      .catch((e) => notify(errorMessage(e)));
  }, [notify]);
  return (
    <div className="mx-auto max-w-2xl p-8">
      <Card title="Choisir un rendez-vous">
        {meetings.length === 0 ? (
          <Empty>
            Aucun rendez-vous planifié. <button className="text-gold underline" onClick={() => go("prospects")}>Créez une fiche prospect</button> puis planifiez un R1 ou un R2.
          </Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {meetings.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2">
                <span><span className="chip mr-2 text-gold">{m.type}</span>{names[m.prospectId]} <span className="text-muted">· {formatDate(m.scheduledAt)}</span></span>
                <button className="btn btn-sm btn-gold" onClick={() => openMeeting(m.id, "live")}>Ouvrir</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ConsentGate() {
  const { session, kb, refreshMeeting, notify, go } = useStore();
  const [checked, setChecked] = useState(false);
  if (!session || !kb) return null;
  const record = async () => {
    try {
      await api.meetingSetConsent(session.meeting.id, true);
      await refreshMeeting();
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  return (
    <div className="scroll-y h-full p-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold">Consentement avant l'écoute</h1>
        <p className="text-sm text-muted">
          Lisez ce texte au prospect (modifiable dans Réglages → Administration). L'écoute ne peut pas démarrer tant que son accord n'est pas enregistré.
        </p>
        <Card>
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{kb.consentText}</p>
        </Card>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          Le prospect ({session.prospect?.firstName} {session.prospect?.lastName}) a donné son accord explicite, et je l'ai informé qu'il peut le retirer à tout moment.
        </label>
        <div className="flex gap-2">
          <button className="btn btn-gold" disabled={!checked} onClick={record}>Enregistrer le consentement</button>
          <button className="btn" onClick={() => go("prospects")}>Pas de consentement — ne pas écouter</button>
        </div>
      </div>
    </div>
  );
}

function Controls() {
  const { session, audio, refreshAudio, audioLevel, transcriptionLatencyMs, setSpeaker, notify, settings, persistAnalysis, go, refreshMeeting } = useStore();
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const st = audio?.state ?? "idle";
  const thisMeeting = !audio?.meetingId || audio.meetingId === session.meeting.id;
  const active = thisMeeting && (st === "listening" || st === "paused" || st === "loading_model");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      await refreshAudio();
      setBusy(false);
    }
  };

  const finish = async () => {
    await run(async () => {
      await api.audioStop(false);
      await persistAnalysis();
      await api.meetingUpdate(session.meeting.id, { status: "done" });
      await refreshMeeting();
    });
    go("debrief");
  };

  const withdraw = async () => {
    await run(async () => {
      await api.meetingSetConsent(session.meeting.id, false); // also stops listening, discards pending audio
      await refreshMeeting();
    });
    notify("Consentement retiré : écoute arrêtée immédiatement.");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
      <div className="mr-2">
        <div className="text-sm font-bold">{session.prospect?.firstName} {session.prospect?.lastName} <span className="chip ml-1 text-gold">{session.meeting.type}</span></div>
        <div className="text-[11px] text-muted">
          {!settings?.whisperModelPath && "⚠ Aucun modèle Whisper configuré (Réglages) · "}
          {transcriptionLatencyMs !== null && `Transcription : ${(transcriptionLatencyMs / 1000).toFixed(1)} s · `}
          {audio?.device && `Micro : ${audio.device}`}
        </div>
      </div>

      {!active && (
        <button className="btn btn-gold" disabled={busy || !thisMeeting} onClick={() => run(() => api.audioStart(session.meeting.id))}>
          ● Démarrer l'écoute
        </button>
      )}
      {active && st === "listening" && <button className="btn" disabled={busy} onClick={() => run(api.audioPause)}>❚❚ Pause</button>}
      {active && st === "paused" && <button className="btn" disabled={busy} onClick={() => run(api.audioResume)}>▶ Reprendre</button>}
      {active && <button className="btn btn-danger" disabled={busy} onClick={() => run(() => api.audioStop(false))}>■ Arrêter</button>}
      {st === "loading_model" && <span className="text-xs text-muted">Chargement du modèle de transcription…</span>}

      {active && (
        <div className="h-2 w-24 overflow-hidden rounded bg-panel-2" aria-label="Niveau du micro" title="Niveau du micro">
          <div className="h-full bg-ok" style={{ width: `${Math.min(100, audioLevel * 800)}%` }} />
        </div>
      )}

      <div className="ml-2 flex items-center gap-1" role="group" aria-label="Qui parle ?">
        <span className="mr-1 text-xs text-muted">Qui parle :</span>
        {(["coach", "prospect", "unknown"] as Speaker[]).map((sp, i) => (
          <button
            key={sp}
            onClick={() => run(() => setSpeaker(sp))}
            aria-pressed={audio?.speaker === sp}
            className={`btn btn-sm ${audio?.speaker === sp ? SPEAKER_CLS[sp] : ""}`}
            title={`Raccourci : ${["C", "P", "U"][i]}`}
          >
            {SPEAKER_LABEL[sp]} <kbd className="opacity-60">{["C", "P", "U"][i]}</kbd>
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs" title="Par défaut, le contenu du rendez-vous est effacé à la fermeture de l'application">
          <input
            type="checkbox"
            checked={session.meeting.retain}
            onChange={(e) => run(async () => { await api.meetingUpdate(session.meeting.id, { retain: e.target.checked }); await refreshMeeting(); })}
          />
          Conserver ce rendez-vous
        </label>
        <button className="btn btn-sm" onClick={withdraw}>Retrait du consentement</button>
        <button className="btn btn-sm btn-gold" onClick={finish}>Terminer → débriefing</button>
      </div>
    </div>
  );
}

function ProgressColumn() {
  const { session, setQuestion } = useStore();
  if (!session) return null;
  const { state } = session;
  const cov = coverage(state);
  const phase = currentPhase(state);
  const qn = state.questionnaire;
  const facts = state.facts;
  return (
    <div className="scroll-y h-full space-y-3 p-3">
      <Card title="Progression">
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>Étape estimée : <strong className="text-white">{phase}</strong></span>
          <span>{cov.covered}/{cov.total} traitées · {cov.partial} partielles</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-panel-2" role="progressbar" aria-valuenow={Math.round(cov.ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-gold" style={{ width: `${cov.ratio * 100}%` }} />
        </div>
        {(facts.budgetAmounts.length > 0 || facts.sessionsPerWeek || facts.weightGoalKg) && (
          <div className="mt-3 flex flex-wrap gap-1 text-[11px]">
            {facts.budgetAmounts.length > 0 && <span className="chip">Montant(s) évoqué(s) : {facts.budgetAmounts.join(", ")} €</span>}
            {facts.sessionsPerWeek && <span className="chip">{facts.sessionsPerWeek}×/semaine</span>}
            {facts.weightGoalKg && <span className="chip">−{facts.weightGoalKg} kg évoqués</span>}
          </div>
        )}
      </Card>
      {qn.phases.map((ph) => (
        <div key={ph}>
          <h3 className={`mb-1 px-1 text-xs font-semibold uppercase ${ph === phase ? "text-gold" : "text-muted"}`}>{ph}</h3>
          <ul className="space-y-1">
            {qn.questions.filter((q) => q.phase === ph).map((q) => {
              const s = state.questions[q.id];
              return (
                <li key={q.id} className="rounded-lg border border-line bg-panel px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] leading-tight">{q.label}{q.sensitive && <span className="ml-1 text-[10px] text-warn" title="Donnée potentiellement sensible (santé)">⚕</span>}</span>
                    <button onClick={() => setQuestion(q.id, NEXT_STATUS[s.status])} title="Cliquer pour valider / corriger manuellement">
                      <StatusChip status={s.status} manual={s.manual} />
                    </button>
                  </div>
                  {s.answer && s.status !== "not_covered" && (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted" title={s.evidence.map((e) => e.excerpt).join("\n")}>
                      « {s.answer} » <Confidence value={s.manual ? null : s.confidence} />
                    </p>
                  )}
                  {s.manual && (
                    <button className="mt-1 text-[10px] text-muted underline" onClick={() => setQuestion(q.id, "auto")}>revenir à la détection automatique</button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SegmentRow({ seg }: { seg: Segment }) {
  const { correctSegment, deleteSegment, notify } = useStore();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(seg.text);
  const cycle: Record<Speaker, Speaker> = { unknown: "prospect", prospect: "coach", coach: "unknown" };
  const run = (p: Promise<unknown>) => p.catch((e) => notify(errorMessage(e)));
  return (
    <li className="group flex gap-3 py-2">
      <div className="w-24 shrink-0 text-right">
        <button
          className={`rounded px-2 py-0.5 text-[11px] font-semibold ${SPEAKER_CLS[seg.speaker]}`}
          onClick={() => run(correctSegment(seg.id, { speaker: cycle[seg.speaker] }))}
          title="Corriger le locuteur"
        >
          {SPEAKER_LABEL[seg.speaker]}
        </button>
        <div className="mt-1 text-[10px] text-muted tabular-nums">
          {formatMs(seg.startMs)} {seg.source === "manual" ? "· saisi" : <Confidence value={seg.confidence} />}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex gap-2">
            <textarea className="input text-sm" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <div className="flex flex-col gap-1">
              <button className="btn btn-sm btn-gold" onClick={() => { void run(correctSegment(seg.id, { text })); setEditing(false); }}>OK</button>
              <button className="btn btn-sm" onClick={() => { setText(seg.text); setEditing(false); }}>Annuler</button>
            </div>
          </div>
        ) : (
          <p className="text-[15px] leading-snug">
            {seg.text}
            {seg.edited && <span className="ml-1 text-[10px] text-muted">(corrigé)</span>}
          </p>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <button className="btn btn-sm" onClick={() => setEditing(true)} aria-label="Corriger le texte">✎</button>
          <button className="btn btn-sm" onClick={() => run(deleteSegment(seg.id))} aria-label="Supprimer ce segment">✕</button>
        </div>
      )}
    </li>
  );
}

function TranscriptColumn() {
  const { session, addManualSegment, audio, notify } = useStore();
  const [note, setNote] = useState("");
  const [noteSpeaker, setNoteSpeaker] = useState<Speaker>("prospect");
  const bottom = useRef<HTMLDivElement>(null);
  const count = session?.segments.length ?? 0;
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [count]);
  if (!session) return null;
  const submit = async () => {
    if (!note.trim()) return;
    try {
      await addManualSegment(noteSpeaker, note);
      setNote("");
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="scroll-y flex-1 px-4">
        {session.segments.length === 0 ? (
          <Empty>
            {audio?.state === "listening" ? "Écoute en cours… la transcription apparaîtra après chaque phrase." : "Démarrez l'écoute, ou saisissez des notes ci-dessous."}
          </Empty>
        ) : (
          <ul className="divide-y divide-line/60">{session.segments.map((s) => <SegmentRow key={s.id} seg={s} />)}</ul>
        )}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t border-line p-3">
        <select className="input w-32" value={noteSpeaker} onChange={(e) => setNoteSpeaker(e.target.value as Speaker)} aria-label="Locuteur de la note">
          <option value="prospect">Prospect</option>
          <option value="coach">Coach</option>
        </select>
        <input
          className="input flex-1"
          placeholder="Saisir ce qui a été dit (utile sans micro ou pour compléter)…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn" onClick={submit}>Ajouter</button>
      </div>
    </div>
  );
}

function CopilotColumn() {
  const { session, dismissSuggestion, otherWording, flagObjection, llm, settings } = useStore();
  const [cloud, setCloud] = useState(false);
  const [cloudResult, setCloudResult] = useState<string | null>(null);
  const suggestions = useMemo(
    () => (session ? buildSuggestions(session.state, { dismissed: session.dismissed, variants: session.variants, llmSuggestion: session.llmSuggestion }) : []),
    [session],
  );
  if (!session) return null;
  const objections = session.state.objections.filter((o) => !o.dismissed);
  const llmLabel =
    llm.status === "off" ? "IA locale désactivée — règles seules"
    : llm.status === "unavailable" ? "IA locale indisponible — règles seules"
    : llm.status === "running" ? "IA locale : analyse…"
    : llm.status === "error" ? llm.message ?? "Erreur IA locale"
    : `IA locale active${llm.lastLatencyMs !== null ? ` · ${(llm.lastLatencyMs / 1000).toFixed(1)} s` : ""}`;
  return (
    <div className="scroll-y h-full space-y-3 p-3">
      <div className="flex items-center justify-between text-[11px] text-muted" title={llm.message ?? ""}>
        <span>{llmLabel}</span>
        {llm.calls > 0 && <span>{llm.calls} appel(s){llm.rejected ? ` · ${llm.rejected} élément(s) non justifié(s) écarté(s)` : ""}</span>}
      </div>
      {suggestions.length === 0 && <Empty>Pas de suggestion pour l'instant.</Empty>}
      {suggestions.map((s, i) => (
        <div key={s.id} className={`card p-3 ${i === 0 ? "border-gold/60" : ""}`}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className={`text-[11px] font-semibold uppercase ${i === 0 ? "text-gold" : "text-muted"}`}>{i === 0 ? "Suggestion principale" : s.title.split(" : ")[0]}</span>
            {s.kind === "llm" && <span className="chip text-[10px] text-muted">IA locale</span>}
          </div>
          <div className="text-sm font-semibold">{s.title}</div>
          <p className="mt-1 text-[15px] leading-snug">{s.text}</p>
          <p className="mt-1 text-[11px] text-muted">{s.why}</p>
          {s.evidence.map((e) => (
            <blockquote key={e.segmentId} className="mt-1 border-l-2 border-gold/50 pl-2 text-[12px] text-muted italic">« {e.excerpt} »</blockquote>
          ))}
          {s.toConfirm.length > 0 && <p className="mt-1 text-[11px] text-warn">À confirmer : {s.toConfirm.join(", ")}</p>}
          <div className="mt-2 flex gap-2">
            <button className="btn btn-sm" onClick={() => dismissSuggestion(s.id)}>Ignorer</button>
            {s.kind !== "llm" && <button className="btn btn-sm" onClick={() => otherWording(s.id)}>Autre formulation</button>}
          </div>
        </div>
      ))}

      <Card title="Objections et clarifications">
        {objections.length === 0 ? (
          <p className="text-xs text-muted">Aucune détectée.</p>
        ) : (
          <ul className="space-y-2">
            {objections.map((o) => (
              <li key={o.id} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className={o.resolved ? "text-muted line-through" : ""}>{o.label}</span>
                  {!o.resolved && (
                    <span className="flex gap-1">
                      <button className="btn btn-sm" onClick={() => flagObjection(o.id, "resolved")}>Traitée</button>
                      <button className="btn btn-sm" onClick={() => flagObjection(o.id, "dismissed")} aria-label="Ce n'est pas une objection">✕</button>
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted italic">« {o.evidence.excerpt} »</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {settings && settings.aiMode !== "local" && (
        <Card title="Cloud (sur demande)">
          <p className="mb-2 text-xs text-muted">Envoie uniquement les derniers extraits, après prévisualisation et confirmation.</p>
          <button className="btn btn-sm" disabled={session.segments.length === 0} onClick={() => setCloud(true)}>Analyser les derniers extraits…</button>
          {cloudResult && <p className="mt-2 text-sm whitespace-pre-wrap">{cloudResult}</p>}
        </Card>
      )}
      {cloud && (
        <CloudDialog
          purpose="excerpt_analysis"
          segments={session.segments.slice(-10)}
          prospect={session.prospect}
          meetingId={session.meeting.id}
          meetingType={session.meeting.type}
          onClose={() => setCloud(false)}
          onResult={setCloudResult}
        />
      )}
    </div>
  );
}

export default function LiveMeeting() {
  const { session, setSpeaker, notify } = useStore();

  // Keyboard shortcuts for the active speaker (ignored while typing).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
      const map: Record<string, Speaker> = { c: "coach", p: "prospect", u: "unknown" };
      const sp = map[e.key.toLowerCase()];
      if (sp) setSpeaker(sp).catch((err) => notify(errorMessage(err)));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setSpeaker, notify]);

  if (!session) return <MeetingPicker />;
  if (!session.meeting.consentGiven) return <ConsentGate />;
  return (
    <div className="flex h-full flex-col">
      <Controls />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,1fr)_minmax(380px,1.6fr)_minmax(280px,1.1fr)]">
        <div className="min-h-0 border-r border-line"><ProgressColumn /></div>
        <div className="min-h-0 border-r border-line"><TranscriptColumn /></div>
        <div className="min-h-0"><CopilotColumn /></div>
      </div>
    </div>
  );
}
