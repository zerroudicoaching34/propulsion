import { useEffect, useMemo, useState } from "react";
import { Card, Empty, StatTile, formatDate } from "../components/ui";
import { OBJECTION_LABELS } from "../core/objections";
import type { ObjectionKind, Prospect } from "../core/types";
import { api, errorMessage, type StoredMeeting } from "../lib/api";
import { useStore } from "../lib/store";

// Every number here is computed from data actually stored. No prediction, no invented rate.

const KEY_FIELDS: [keyof Prospect, string][] = [
  ["objective", "Objectif"],
  ["currentSituation", "Situation"],
  ["obstacles", "Obstacles"],
  ["constraints", "Contraintes"],
  ["budget", "Budget"],
  ["autonomy", "Autonomie"],
  ["decisionCriteria", "Critères de décision"],
];

export default function Dashboard() {
  const { go, openMeeting, notify } = useStore();
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [meetings, setMeetings] = useState<StoredMeeting[]>([]);

  useEffect(() => {
    Promise.all([api.prospectList(), api.meetingList()])
      .then(([p, m]) => {
        setProspects(p);
        setMeetings(m);
      })
      .catch((e) => notify(errorMessage(e)));
  }, [notify]);

  const byId = useMemo(() => new Map(prospects.map((p) => [p.id, p])), [prospects]);
  const now = Date.now();
  const upcoming = meetings
    .filter((m) => m.status === "planned" && new Date(m.scheduledAt).getTime() >= now - 3600_000)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .slice(0, 6);
  const done = meetings.filter((m) => m.status === "done");
  const r1 = meetings.filter((m) => m.type === "R1").length;
  const r2 = meetings.filter((m) => m.type === "R2").length;
  const withDecision = done.filter((m) => m.decision.trim());
  const r2Decided = withDecision.filter((m) => m.type === "R2");
  const agreements = r2Decided.filter((m) => /accord/i.test(m.decision)).length;

  const objectionCounts = new Map<string, number>();
  for (const m of meetings) {
    for (const k of m.objectionKinds.split(",").filter(Boolean)) objectionCounts.set(k, (objectionCounts.get(k) ?? 0) + 1);
  }
  const topObjections = [...objectionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const missing = prospects
    .map((p) => ({ p, fields: KEY_FIELDS.filter(([k]) => !String(p[k] ?? "").trim()).map(([, l]) => l) }))
    .filter((x) => x.fields.length > 0)
    .slice(0, 6);

  return (
    <div className="scroll-y h-full space-y-5 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold">Tableau de bord</h1>
        <button className="btn btn-gold" onClick={() => go("prospects")}>+ Nouveau prospect</button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Prospects" value={prospects.length} />
        <StatTile label="Rendez-vous R1" value={r1} />
        <StatTile label="Rendez-vous R2" value={r2} />
        <StatTile label="Rendez-vous terminés" value={done.length} />
        <StatTile label="Décisions enregistrées" value={withDecision.length} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Prochains rendez-vous">
          {upcoming.length === 0 ? (
            <Empty>Aucun rendez-vous planifié.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {upcoming.map((m) => {
                const p = byId.get(m.prospectId);
                return (
                  <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                    <span>
                      <span className="chip mr-2 text-gold">{m.type}</span>
                      {p ? `${p.firstName} ${p.lastName}` : "—"}
                      <span className="ml-2 text-muted">{formatDate(m.scheduledAt)}</span>
                    </span>
                    <button className="btn btn-sm" onClick={() => openMeeting(m.id, "live")}>Ouvrir</button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Conversion (données réelles)">
          {r2Decided.length === 0 ? (
            <Empty>Pas encore de R2 terminé avec une décision enregistrée : aucune statistique affichée.</Empty>
          ) : (
            <div className="text-sm">
              <div className="text-3xl font-bold tabular-nums">
                {agreements} / {r2Decided.length}
              </div>
              <p className="mt-1 text-muted">
                R2 terminés où un accord a été exprimé, parmi les R2 terminés avec une décision enregistrée. Aucune projection n'est calculée.
              </p>
            </div>
          )}
        </Card>

        <Card title="Objections les plus fréquentes">
          {topObjections.length === 0 ? (
            <Empty>Aucune objection relevée pour l'instant.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {topObjections.map(([k, n]) => (
                <li key={k} className="flex items-center gap-3">
                  <span className="w-48 shrink-0">{OBJECTION_LABELS[k as ObjectionKind] ?? k}</span>
                  <span className="h-2 rounded bg-gold" style={{ width: `${(n / topObjections[0][1]) * 100}%`, maxWidth: "60%" }} aria-hidden />
                  <span className="tabular-nums text-muted">{n} RDV</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Informations commerciales manquantes">
          {missing.length === 0 ? (
            <Empty>Toutes les fiches prospects sont complètes.</Empty>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {missing.map(({ p, fields }) => (
                <li key={p.id} className="py-2">
                  <span className="font-medium">{p.firstName} {p.lastName}</span>
                  <span className="ml-2 text-muted">{fields.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Historique des prospects">
        {prospects.length === 0 ? (
          <Empty>Aucun prospect. Créez une première fiche pour démarrer.</Empty>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr><th className="py-1">Prospect</th><th>Objectif</th><th>Rendez-vous</th><th>Dernière décision</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {prospects.map((p) => {
                const ms = meetings.filter((m) => m.prospectId === p.id);
                const last = ms.find((m) => m.decision);
                return (
                  <tr key={p.id}>
                    <td className="py-2 font-medium">{p.firstName} {p.lastName}</td>
                    <td className="max-w-xs truncate text-muted">{p.objective || "—"}</td>
                    <td className="text-muted">{ms.map((m) => m.type).join(", ") || "—"}</td>
                    <td className="text-muted">{last?.decision || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
