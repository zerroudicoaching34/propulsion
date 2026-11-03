import { ask, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { CloudDialog } from "../components/CloudDialog";
import { NoSession } from "../components/NoSession";
import { Card, formatDate } from "../components/ui";
import { buildDebrief, debriefToJson, debriefToMarkdown, detectDecision } from "../core/debrief";
import type { Debrief as DebriefT } from "../core/types";
import { api, errorMessage, type CloudResult } from "../lib/api";
import { useStore } from "../lib/store";

function List({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-sm text-muted">Non renseigné</p>;
  return <ul className="list-disc space-y-1 pl-5 text-sm">{items.map((i, k) => <li key={k}>{i}</li>)}</ul>;
}

export default function Debrief() {
  const { session, kb, notify, refreshMeeting, closeMeeting, go, settings, llm } = useStore();
  const [decision, setDecision] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [cloudResults, setCloudResults] = useState<CloudResult[]>([]);

  useEffect(() => {
    if (!session) return;
    setDecision(session.meeting.decision);
    setNextAction(session.meeting.nextAction);
    try {
      setSummary(session.meeting.debriefJson ? (JSON.parse(session.meeting.debriefJson) as DebriefT).summary : "");
    } catch {
      setSummary("");
    }
    api.cloudResults(session.meeting.id).then(setCloudResults).catch(() => setCloudResults([]));
  }, [session?.meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const debrief = useMemo(() => {
    if (!session || !kb) return null;
    return buildDebrief({
      state: session.state,
      segments: session.segments,
      prospect: session.prospect,
      meeting: { type: session.meeting.type, decision, nextAction },
      offers: kb.offers,
      summaryOverride: summary,
    });
  }, [session, kb, decision, nextAction, summary]);

  if (!session) return <NoSession target="debrief" title="Débriefing — choisir un rendez-vous" />;
  if (!debrief) return null;

  const persist = async () => {
    // Decision: what the coach typed, otherwise the decision actually detected in the transcript.
    const detected = detectDecision(session.segments).label;
    const finalDecision = decision.trim() || (detected !== "Non exprimée" ? detected : "");
    await api.meetingUpdate(session.meeting.id, { decision: finalDecision, nextAction: nextAction.trim(), debriefJson: JSON.stringify(debrief) });
    await refreshMeeting();
  };

  const localSummary = async () => {
    setBusy(true);
    try {
      const md = debriefToMarkdown({ ...debrief, summary: "(à rédiger)" });
      const reply = await api.ollamaChat(
        [
          { role: "system", content: "Tu rédiges en français un résumé factuel de 5 phrases maximum d'un rendez-vous commercial de coaching sportif, à partir des éléments fournis uniquement. N'invente rien. Aucune déduction psychologique ou médicale. Réponds en JSON {\"summary\": \"...\"}." },
          { role: "user", content: md },
        ],
        { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      );
      const parsed = JSON.parse(reply.content) as { summary?: string };
      if (parsed.summary) setSummary(parsed.summary.trim());
      notify(`Résumé rédigé par l'IA locale en ${(reply.latencyMs / 1000).toFixed(1)} s — relisez-le.`);
    } catch (e) {
      notify(`IA locale : ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doExport = async (kind: "md" | "json" | "pdf") => {
    const base = `debriefing-${session.meeting.type}-${(debrief.prospectName || "prospect").replace(/[^\p{L}\d]+/gu, "-")}-${new Date().toISOString().slice(0, 10)}`;
    const path = await save({ defaultPath: `${base}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] });
    if (!path) return;
    try {
      await persist();
      if (kind === "md") await api.exportSave(path, { text: debriefToMarkdown(debrief) });
      if (kind === "json") await api.exportSave(path, { text: debriefToJson(debrief) });
      if (kind === "pdf") {
        const { debriefToPdf } = await import("../core/pdf");
        await api.exportSave(path, { bytes: debriefToPdf(debrief) });
      }
      notify(`Exporté : ${path}`);
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  const deleteData = async () => {
    const ok = await ask("Supprimer définitivement ce rendez-vous : transcription, analyse, débriefing et résultats cloud ? La fiche prospect est conservée.", { title: "Suppression", kind: "warning" });
    if (!ok) return;
    try {
      const id = session.meeting.id;
      closeMeeting();
      await api.meetingDelete(id);
      notify("Données du rendez-vous supprimées.");
      go("dashboard");
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  return (
    <div className="scroll-y h-full space-y-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Débriefing {debrief.meetingType} — {debrief.prospectName}</h1>
          <p className="text-sm text-muted">{formatDate(session.meeting.scheduledAt)} · {debrief.coverage.covered}/{debrief.coverage.total} sujets traités · temps de parole coach {debrief.talkRatio.coach} % / prospect {debrief.talkRatio.prospect} %</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={() => persist().then(() => notify("Débriefing enregistré.")).catch((e) => notify(errorMessage(e)))}>Enregistrer</button>
          <button className="btn" onClick={() => doExport("md")}>Export Markdown</button>
          <button className="btn" onClick={() => doExport("pdf")}>Export PDF</button>
          <button className="btn" onClick={() => doExport("json")}>Export JSON</button>
          <button className="btn btn-danger" onClick={deleteData}>Supprimer les données</button>
        </div>
      </div>

      {!session.meeting.retain && (
        <p className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          Conservation désactivée : la transcription, l'analyse et ce débriefing seront effacés à la fermeture de l'application (seuls le type, la date, la
          décision et la prochaine action sont gardés pour les statistiques). Exportez le débriefing ou cochez « Conserver ce rendez-vous » dans l'écran en direct.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Résumé"
          actions={
            settings?.llmEnabled && (
              <button className="btn btn-sm" disabled={busy || llm.status === "running"} onClick={localSummary}>{busy ? "Rédaction…" : "Rédiger avec l'IA locale"}</button>
            )
          }
        >
          <textarea className="input min-h-[110px] text-sm" value={summary || debrief.summary} onChange={(e) => setSummary(e.target.value)} aria-label="Résumé" />
        </Card>
        <Card title="Décision et suite">
          <label className="label" htmlFor="decision">Décision réellement exprimée</label>
          <input id="decision" className="input mb-1" value={decision} placeholder={debrief.decision} onChange={(e) => setDecision(e.target.value)} />
          <p className="mb-3 text-[11px] text-muted">Détection : {debrief.decision}. Saisissez la décision exacte si besoin.</p>
          <label className="label" htmlFor="next">Prochaine action convenue</label>
          <input id="next" className="input" value={nextAction} placeholder={debrief.nextAction} onChange={(e) => setNextAction(e.target.value)} />
        </Card>
        <Card title="Objectif déclaré"><p className="text-sm">{debrief.objective}</p></Card>
        <Card title="Offre éventuellement recommandée"><p className="text-sm">{debrief.recommendedOffer}</p></Card>
        <Card title="Difficultés identifiées"><List items={debrief.difficulties} /></Card>
        <Card title="Besoins exprimés"><List items={debrief.needs} /></Card>
        <Card title="Questions et objections"><List items={debrief.questionsAndObjections} /></Card>
        <Card title="Réponses apportées"><List items={debrief.answersGiven} /></Card>
        <Card title="Informations manquantes"><List items={debrief.missingInformation} /></Card>
        <Card title="Points d'amélioration du coach"><List items={debrief.coachImprovements} /></Card>
      </div>

      {settings?.aiMode === "deep" && (
        <Card title="Analyse approfondie cloud (facultative)" actions={<button className="btn btn-sm" disabled={!session.segments.length} onClick={() => setCloudOpen(true)}>Préparer l'envoi…</button>}>
          {cloudResults.length === 0 ? (
            <p className="text-sm text-muted">Aucune analyse cloud pour ce rendez-vous.</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold text-muted uppercase">Analyse locale</div>
                <pre className="text-sm whitespace-pre-wrap">{debriefToMarkdown(debrief)}</pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold text-muted uppercase">{cloudResults[0].provider} · {cloudResults[0].model} · {formatDate(cloudResults[0].createdAt)}</div>
                <pre className="text-sm whitespace-pre-wrap">{cloudResults[0].content}</pre>
              </div>
            </div>
          )}
        </Card>
      )}
      {cloudOpen && (
        <CloudDialog
          purpose="deep_analysis"
          segments={session.segments}
          prospect={session.prospect}
          meetingId={session.meeting.id}
          meetingType={session.meeting.type}
          onClose={() => setCloudOpen(false)}
          onResult={() => api.cloudResults(session.meeting.id).then(setCloudResults)}
        />
      )}
    </div>
  );
}
