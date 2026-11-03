import { ask } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { Card, Empty, Field, formatDate } from "../components/ui";
import type { Prospect } from "../core/types";
import { api, errorMessage, type StoredMeeting } from "../lib/api";
import { useStore } from "../lib/store";

const EMPTY: Partial<Prospect> = {
  firstName: "", lastName: "", email: "", phone: "", objective: "", currentSituation: "", previousAttempts: "", obstacles: "",
  constraints: "", budget: "", autonomy: "", decisionCriteria: "", coachNotes: "",
};

const TEXT_FIELDS: [keyof Prospect, string, string?][] = [
  ["objective", "Objectif", "Tel qu'exprimé par le prospect"],
  ["currentSituation", "Situation actuelle"],
  ["previousAttempts", "Tentatives précédentes"],
  ["obstacles", "Obstacles déclarés"],
  ["constraints", "Contraintes (disponibilités, localisation…)"],
  ["budget", "Budget communiqué", "Uniquement s'il a été communiqué"],
  ["autonomy", "Niveau d'autonomie"],
  ["decisionCriteria", "Critères de décision"],
  ["coachNotes", "Notes personnelles du coach"],
];

function localDateTimeValue(d = new Date()): string {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

export default function Prospects() {
  const { notify, openMeeting, session, closeMeeting } = useStore();
  const [list, setList] = useState<Prospect[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Prospect>>(EMPTY);
  const [meetings, setMeetings] = useState<StoredMeeting[]>([]);
  const [newType, setNewType] = useState<"R1" | "R2">("R1");
  const [newDate, setNewDate] = useState(localDateTimeValue());
  const [filter, setFilter] = useState("");

  const reload = useCallback(async () => setList(await api.prospectList()), []);
  useEffect(() => {
    reload().catch((e) => notify(errorMessage(e)));
  }, [reload, notify]);

  useEffect(() => {
    if (!selected) {
      setMeetings([]);
      return;
    }
    api.meetingList(selected).then(setMeetings).catch((e) => notify(errorMessage(e)));
  }, [selected, notify]);

  const select = (p: Prospect | null) => {
    setSelected(p?.id ?? null);
    setForm(p ? { ...p } : { ...EMPTY });
  };

  const save = async () => {
    if (!form.firstName?.trim() && !form.lastName?.trim()) {
      notify("Indiquez au moins un prénom ou un nom.");
      return;
    }
    try {
      const saved = await api.prospectUpsert({ ...form, id: form.id ?? "" });
      await reload();
      select(saved);
      notify("Fiche enregistrée.");
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!form.id) return;
    const ok = await ask(`Supprimer définitivement ${form.firstName} ${form.lastName} et tous ses rendez-vous (transcriptions, analyses, débriefings) ?`, {
      title: "Suppression",
      kind: "warning",
    });
    if (!ok) return;
    try {
      if (session?.meeting.prospectId === form.id) closeMeeting();
      await api.prospectDelete(form.id);
      select(null);
      await reload();
      notify("Prospect et données associées supprimés.");
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  const createMeeting = async () => {
    if (!form.id) return;
    try {
      const m = await api.meetingCreate(form.id, newType, new Date(newDate).toISOString());
      setMeetings(await api.meetingList(form.id));
      notify(`Rendez-vous ${m.type} créé.`);
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  const deleteMeeting = async (m: StoredMeeting) => {
    const ok = await ask(`Supprimer le rendez-vous ${m.type} du ${formatDate(m.scheduledAt)} et toutes ses données ?`, { title: "Suppression", kind: "warning" });
    if (!ok) return;
    try {
      if (session?.meeting.id === m.id) closeMeeting();
      await api.meetingDelete(m.id);
      setMeetings(await api.meetingList(m.prospectId));
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  const shown = list.filter((p) => `${p.firstName} ${p.lastName}`.toLowerCase().includes(filter.toLowerCase()));
  const set = (k: keyof Prospect, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="space-y-2 p-4">
          <button className="btn btn-gold w-full" onClick={() => select(null)}>+ Nouvelle fiche</button>
          <input className="input" placeholder="Rechercher…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Rechercher un prospect" />
        </div>
        <ul className="scroll-y flex-1 px-2 pb-4">
          {shown.length === 0 && <Empty>Aucun prospect.</Empty>}
          {shown.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => select(p)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected === p.id ? "bg-violet-600" : "hover:bg-panel-2"}`}
              >
                <div className="font-medium">{p.firstName} {p.lastName}</div>
                <div className="truncate text-xs text-muted">{p.objective || "Objectif non renseigné"}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="scroll-y flex-1 space-y-5 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{form.id ? `${form.firstName} ${form.lastName}` : "Nouvelle fiche prospect"}</h1>
          <div className="flex gap-2">
            {form.id && <button className="btn btn-danger" onClick={remove}>Supprimer</button>}
            <button className="btn btn-gold" onClick={save}>Enregistrer</button>
          </div>
        </div>

        <Card title="Identité (coordonnées facultatives)">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Prénom"><input className="input" value={form.firstName ?? ""} onChange={(e) => set("firstName", e.target.value)} /></Field>
            <Field label="Nom"><input className="input" value={form.lastName ?? ""} onChange={(e) => set("lastName", e.target.value)} /></Field>
            <Field label="E-mail"><input className="input" type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
            <Field label="Téléphone"><input className="input" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
          </div>
        </Card>

        <Card title="Informations commerciales">
          <div className="grid gap-3 lg:grid-cols-2">
            {TEXT_FIELDS.map(([k, label, hint]) => (
              <Field key={k} label={label} hint={hint}>
                <textarea className="input min-h-[64px]" value={String(form[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
              </Field>
            ))}
          </div>
        </Card>

        {form.id && (
          <Card title="Rendez-vous">
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <Field label="Type">
                <select className="input" value={newType} onChange={(e) => setNewType(e.target.value as "R1" | "R2")}>
                  <option value="R1">R1 — Découverte et diagnostic</option>
                  <option value="R2">R2 — Présentation et décision</option>
                </select>
              </Field>
              <Field label="Date">
                <input className="input" type="datetime-local" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              </Field>
              <button className="btn" onClick={createMeeting}>Planifier</button>
            </div>
            {meetings.length === 0 ? (
              <Empty>Aucun rendez-vous pour ce prospect.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {meetings.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex items-center gap-2">
                      <span className="chip text-gold">{m.type}</span>
                      {formatDate(m.scheduledAt)}
                      <span className="text-muted">
                        · {m.status === "planned" ? "planifié" : m.status === "live" ? "en cours" : "terminé"}
                        {m.decision && ` · ${m.decision}`}
                        {m.contentPurged && " · contenu effacé (conservation désactivée)"}
                      </span>
                    </span>
                    <span className="flex gap-2">
                      <button className="btn btn-sm btn-gold" onClick={() => openMeeting(m.id, "live")}>{m.status === "done" ? "Rouvrir" : "Démarrer"}</button>
                      {!m.contentPurged && m.status === "done" && <button className="btn btn-sm" onClick={() => openMeeting(m.id, "debrief")}>Débriefing</button>}
                      <button className="btn btn-sm btn-danger" onClick={() => deleteMeeting(m)} aria-label="Supprimer le rendez-vous">Supprimer</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
