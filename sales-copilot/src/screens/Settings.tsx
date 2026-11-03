import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Card, Field, formatDate } from "../components/ui";
import { defaultOffers } from "../core/offers";
import { defaultQuestionnaire } from "../core/questionnaires";
import type { MeetingType, Offer, Question, Questionnaire } from "../core/types";
import { api, errorMessage, type AppSettings, type CloudTransfer, type OllamaStatus } from "../lib/api";
import { DEFAULT_CONSENT_TEXT, saveConsentText, saveOffers, saveQuestionnaire } from "../lib/kb";
import { useStore } from "../lib/store";

type Tab = "general" | "ai" | "cloud" | "offers" | "questionnaires" | "consent" | "about";
const TABS: [Tab, string][] = [
  ["general", "Confidentialité"],
  ["ai", "IA locale & transcription"],
  ["cloud", "Cloud (facultatif)"],
  ["offers", "Offres"],
  ["questionnaires", "Questionnaires R1/R2"],
  ["consent", "Texte de consentement"],
  ["about", "À propos"],
];

const MODES: [AppSettings["aiMode"], string, string][] = [
  ["local", "A — 100 % local (recommandé)", "Transcription, analyse et stockage sur ce Mac. Aucun transfert de conversation vers Internet."],
  ["hybrid", "B — Hybride", "Tout reste local ; vous pouvez envoyer des extraits choisis au fournisseur cloud, après prévisualisation et confirmation."],
  ["deep", "C — Analyse approfondie", "En plus du mode B, vous pouvez envoyer le rendez-vous complet après la séance, après prévisualisation et confirmation."],
];

function GeneralTab({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-5">
      <Card title="Mode IA">
        <div className="space-y-2">
          {MODES.map(([v, l, d]) => (
            <label key={v} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${s.aiMode === v ? "border-gold" : "border-line"}`}>
              <input type="radio" name="mode" checked={s.aiMode === v} onChange={() => set({ aiMode: v })} />
              <span><span className="font-semibold">{l}</span><span className="block text-xs text-muted">{d}</span></span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Il n'y a jamais de basculement automatique vers le cloud, même si l'IA locale échoue.</p>
      </Card>
      <Card title="Conservation des données">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={s.retainByDefault} onChange={(e) => set({ retainByDefault: e.target.checked })} />
            <span>Conserver les nouveaux rendez-vous par défaut<span className="block text-xs text-muted">Désactivé par défaut : le contenu (transcription, analyse, débriefing) est effacé à la fermeture de l'application.</span></span>
          </label>
          <Field label="Durée de conservation des rendez-vous conservés (jours)">
            <input className="input" type="number" min={1} value={s.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) })} />
          </Field>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
          <li>L'audio n'est jamais enregistré sur le disque : il est transcrit en mémoire puis libéré.</li>
          <li>La base de données est chiffrée (SQLCipher) ; la clé est stockée dans le Trousseau macOS.</li>
          <li>Aucune télémétrie n'existe dans l'application.</li>
        </ul>
      </Card>
      <Card title="Analyse conversationnelle">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={s.showDiscGrid} onChange={(e) => set({ showDiscGrid: e.target.checked })} />
          <span>Afficher la grille DISC pédagogique (facultatif)<span className="block text-xs text-muted">Simple repère pour adapter ses explications ; jamais un diagnostic de personnalité.</span></span>
        </label>
      </Card>
    </div>
  );
}

function AiTab({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  const { notify } = useStore();
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [devices, setDevices] = useState<string[]>([]);
  const [modelInfo, setModelInfo] = useState<string | null>(null);
  useEffect(() => {
    api.ollamaStatus().then(setOllama).catch(() => setOllama(null));
    api.audioDevices().then(setDevices).catch(() => setDevices([]));
  }, []);
  const checkModel = async () => {
    try {
      const size = await api.whisperCheck(s.whisperModelPath);
      setModelInfo(`Modèle trouvé (${(size / 1e6).toFixed(0)} Mo).`);
    } catch (e) {
      setModelInfo(errorMessage(e));
    }
  };
  return (
    <div className="space-y-5">
      <Card title="Transcription (Whisper, local)">
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Fichier du modèle Whisper (.bin)" hint="Ex. ~/Library/Application Support/fr.smartandstrong.salescopilot/models/ggml-large-v3-turbo-q5_0.bin">
            <div className="flex gap-2">
              <input className="input" value={s.whisperModelPath} onChange={(e) => set({ whisperModelPath: e.target.value })} />
              <button className="btn" onClick={checkModel}>Vérifier</button>
            </div>
          </Field>
          <Field label="Threads de calcul">
            <input className="input" type="number" min={1} max={16} value={s.whisperThreads} onChange={(e) => set({ whisperThreads: Number(e.target.value) })} />
          </Field>
          <Field label="Micro">
            <select className="input" value={s.inputDevice} onChange={(e) => set({ inputDevice: e.target.value })}>
              <option value="">Micro par défaut du système</option>
              {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        </div>
        {modelInfo && <p className="mt-2 text-sm">{modelInfo}</p>}
      </Card>
      <Card title="IA locale (Ollama)">
        <div className="grid gap-3 lg:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.llmEnabled} onChange={(e) => set({ llmEnabled: e.target.checked })} /> Activer l'IA locale
          </label>
          <Field label="Adresse (locale uniquement)"><input className="input" value={s.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} /></Field>
          <Field label="Modèle">
            <input className="input" list="ollama-models" value={s.ollamaModel} onChange={(e) => set({ ollamaModel: e.target.value })} />
            <datalist id="ollama-models">{ollama?.models.map((m) => <option key={m} value={m} />)}</datalist>
          </Field>
          <Field label="Actualisation des suggestions IA (secondes)" hint="Les règles locales réagissent à chaque phrase ; l'IA affine à cet intervalle.">
            <input className="input" type="number" min={5} value={s.llmIntervalSec} onChange={(e) => set({ llmIntervalSec: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <button className="btn btn-sm" onClick={() => api.ollamaStatus().then(setOllama).catch((e) => notify(errorMessage(e)))}>Tester</button>
          {ollama && (ollama.reachable ? <span className={ollama.configuredModelAvailable ? "text-ok" : "text-warn"}>Ollama joignable · {ollama.models.length} modèle(s){ollama.message ? ` · ${ollama.message}` : ""}</span> : <span className="text-warn">{ollama.message}</span>)}
        </div>
      </Card>
    </div>
  );
}

function CloudTab({ s, set }: { s: AppSettings; set: (p: Partial<AppSettings>) => void }) {
  const { notify } = useStore();
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [log, setLog] = useState<CloudTransfer[]>([]);
  useEffect(() => {
    api.secretHasApiKey(s.cloud.kind).then(setHasKey).catch(() => setHasKey(false));
    api.cloudTransfers().then(setLog).catch(() => setLog([]));
  }, [s.cloud.kind]);
  const setCloud = (p: Partial<AppSettings["cloud"]>) => set({ cloud: { ...s.cloud, ...p } });
  return (
    <div className="space-y-5">
      <Card title="Fournisseur">
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Type d'API">
            <select
              className="input"
              value={s.cloud.kind}
              onChange={(e) =>
                setCloud(
                  e.target.value === "anthropic"
                    ? { kind: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" }
                    : { kind: "openai_compatible", label: "Fournisseur compatible OpenAI", baseUrl: "https://", model: "" },
                )
              }
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai_compatible">Compatible OpenAI (Mistral, etc.)</option>
            </select>
          </Field>
          <Field label="Nom affiché"><input className="input" value={s.cloud.label} onChange={(e) => setCloud({ label: e.target.value })} /></Field>
          <Field label="URL de base (HTTPS)"><input className="input" value={s.cloud.baseUrl} onChange={(e) => setCloud({ baseUrl: e.target.value })} /></Field>
          <Field label="Modèle"><input className="input" value={s.cloud.model} onChange={(e) => setCloud({ model: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Clé API (Trousseau macOS)">
        <p className="mb-2 text-sm">{hasKey ? "Une clé est enregistrée dans le Trousseau." : "Aucune clé enregistrée."} La clé n'est jamais réaffichée ni stockée dans la base.</p>
        <div className="flex gap-2">
          <input className="input" type="password" autoComplete="off" placeholder="Coller la clé…" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn" disabled={!key.trim()} onClick={() => api.secretSetApiKey(s.cloud.kind, key).then(() => { setKey(""); setHasKey(true); notify("Clé enregistrée dans le Trousseau."); }).catch((e) => notify(errorMessage(e)))}>Enregistrer</button>
          {hasKey && <button className="btn btn-danger" onClick={() => api.secretDeleteApiKey(s.cloud.kind).then(() => setHasKey(false)).catch((e) => notify(errorMessage(e)))}>Supprimer</button>}
        </div>
      </Card>
      <Card title="Journal des transferts cloud">
        {log.length === 0 ? (
          <p className="text-sm text-muted">Aucun transfert effectué.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-muted"><tr><th className="py-1">Date</th><th>Fournisseur</th><th>Modèle</th><th>Objet</th><th>Taille</th><th>Empreinte</th><th>Statut</th></tr></thead>
            <tbody className="divide-y divide-line">
              {log.map((t) => (
                <tr key={t.id}>
                  <td className="py-1">{formatDate(t.createdAt)}</td><td>{t.provider}</td><td>{t.model}</td>
                  <td>{t.purpose === "deep_analysis" ? "Analyse complète" : "Extraits"}</td>
                  <td>{t.bytes} o</td><td className="font-mono">{t.sha256.slice(0, 12)}…</td>
                  <td className={t.status === "sent" ? "text-ok" : t.status === "error" ? "text-danger" : ""} title={t.error ?? ""}>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-muted">Le journal contient uniquement des métadonnées (jamais le contenu envoyé).</p>
      </Card>
    </div>
  );
}

const csv = (a: string[]) => a.join(", ");
const uncsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function OffersTab() {
  const { kb, reloadKb, notify } = useStore();
  const [offers, setOffers] = useState<Offer[]>(kb?.offers ?? []);
  const upd = (i: number, p: Partial<Offer>) => setOffers((o) => o.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const persist = async (list: Offer[]) => {
    try {
      await saveOffers(list);
      await reloadKb();
      notify("Offres enregistrées.");
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <p className="max-w-2xl text-sm text-muted">Tarifs, durées, garanties et inclusions sont utilisés tels quels : un champ vide reste « à définir » et n'est jamais complété par l'IA.</p>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setOffers((o) => [...o, { id: `offre_${Date.now()}`, name: "Nouvelle offre", priceLabel: "", monthlyPriceMin: null, monthlyPriceMax: null, oneTimePrice: null, commitments: "", inclusions: [], exclusions: [], goal: "", guarantee: "", active: true }])}>+ Offre</button>
          <button className="btn" onClick={async () => { if (await ask("Restaurer les offres par défaut ?")) { setOffers(defaultOffers()); await persist(defaultOffers()); } }}>Réinitialiser</button>
          <button className="btn btn-gold" onClick={() => persist(offers)}>Enregistrer</button>
        </div>
      </div>
      {offers.map((o, i) => (
        <Card key={o.id} title={o.name || "Offre"} actions={<label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={o.active} onChange={(e) => upd(i, { active: e.target.checked })} /> Active</label>}>
          <div className="grid gap-3 lg:grid-cols-4">
            <Field label="Nom"><input className="input" value={o.name} onChange={(e) => upd(i, { name: e.target.value })} /></Field>
            <Field label="Tarif affiché"><input className="input" value={o.priceLabel} placeholder="À définir" onChange={(e) => upd(i, { priceLabel: e.target.value })} /></Field>
            <Field label="Mensuel min (€)"><input className="input" type="number" value={o.monthlyPriceMin ?? ""} onChange={(e) => upd(i, { monthlyPriceMin: num(e.target.value) })} /></Field>
            <Field label="Mensuel max (€)"><input className="input" type="number" value={o.monthlyPriceMax ?? ""} onChange={(e) => upd(i, { monthlyPriceMax: num(e.target.value) })} /></Field>
            <Field label="Paiement unique (€)"><input className="input" type="number" value={o.oneTimePrice ?? ""} onChange={(e) => upd(i, { oneTimePrice: num(e.target.value) })} /></Field>
            <Field label="Engagement / durées"><input className="input" value={o.commitments} onChange={(e) => upd(i, { commitments: e.target.value })} /></Field>
            <Field label="Objectif de l'offre"><input className="input" value={o.goal} onChange={(e) => upd(i, { goal: e.target.value })} /></Field>
            <Field label="Garantie (laisser vide si aucune)"><input className="input" value={o.guarantee} onChange={(e) => upd(i, { guarantee: e.target.value })} /></Field>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Field label="Inclus (une ligne par élément)"><textarea className="input min-h-[90px]" value={o.inclusions.join("\n")} onChange={(e) => upd(i, { inclusions: e.target.value.split("\n").filter((x) => x.trim()) })} /></Field>
            <Field label="Non inclus (une ligne par élément)"><textarea className="input min-h-[90px]" value={o.exclusions.join("\n")} onChange={(e) => upd(i, { exclusions: e.target.value.split("\n").filter((x) => x.trim()) })} /></Field>
          </div>
          <button className="btn btn-sm btn-danger mt-3" onClick={() => setOffers((l) => l.filter((_, k) => k !== i))}>Retirer cette offre</button>
        </Card>
      ))}
    </div>
  );
}

function QuestionnairesTab() {
  const { kb, reloadKb, notify } = useStore();
  const [type, setType] = useState<MeetingType>("R1");
  const [q, setQ] = useState<Questionnaire | null>(kb ? structuredClone(kb.questionnaires.R1) : null);
  useEffect(() => {
    if (kb) setQ(structuredClone(kb.questionnaires[type]));
  }, [type, kb]);
  if (!q) return null;
  const upd = (i: number, p: Partial<Question>) => setQ({ ...q, questions: q.questions.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  const persist = async (val: Questionnaire) => {
    try {
      await saveQuestionnaire({ ...val, version: val.version + 1 });
      await reloadKb();
      notify(`Questionnaire ${val.type} enregistré (s'applique aux nouveaux rendez-vous).`);
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {(["R1", "R2"] as MeetingType[]).map((t) => <button key={t} className={`btn ${type === t ? "btn-gold" : ""}`} onClick={() => setType(t)}>{t}</button>)}
          <span className="self-center text-sm text-muted">{q.questions.length} questions</span>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setQ({ ...q, questions: [...q.questions, { id: `${type.toLowerCase()}_q${Date.now()}`, label: "Nouvelle question", ask: "", phase: q.phases[0], answerCues: [], askCues: [] }] })}>+ Question</button>
          <button className="btn" onClick={async () => { if (await ask(`Restaurer le questionnaire ${type} par défaut ?`)) { const d = defaultQuestionnaire(type); setQ(d); await persist(d); } }}>Réinitialiser</button>
          <button className="btn btn-gold" onClick={() => persist(q)}>Enregistrer</button>
        </div>
      </div>
      <Field label="Étapes (séparées par des virgules)"><input className="input" value={csv(q.phases)} onChange={(e) => setQ({ ...q, phases: uncsv(e.target.value) })} /></Field>
      {q.questions.map((x, i) => (
        <Card key={x.id}>
          <div className="grid gap-3 lg:grid-cols-[1fr_2fr_160px]">
            <Field label={`Sujet ${i + 1}`}><input className="input" value={x.label} onChange={(e) => upd(i, { label: e.target.value })} /></Field>
            <Field label="Formulation suggérée"><input className="input" value={x.ask} onChange={(e) => upd(i, { ask: e.target.value })} /></Field>
            <Field label="Étape">
              <select className="input" value={x.phase} onChange={(e) => upd(i, { phase: e.target.value })}>{q.phases.map((p) => <option key={p}>{p}</option>)}</select>
            </Field>
            <Field label="Indices de réponse du prospect (virgules)"><input className="input" value={csv(x.answerCues)} onChange={(e) => upd(i, { answerCues: uncsv(e.target.value) })} /></Field>
            <Field label="Indices de question du coach (virgules)"><input className="input" value={csv(x.askCues)} onChange={(e) => upd(i, { askCues: uncsv(e.target.value) })} /></Field>
            <div className="flex flex-col justify-end gap-1 text-xs">
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!x.sensitive} onChange={(e) => upd(i, { sensitive: e.target.checked })} /> Sensible (santé)</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={!!x.coachDelivers} onChange={(e) => upd(i, { coachDelivers: e.target.checked })} /> Présenté par le coach</label>
              <button className="btn btn-sm btn-danger" onClick={() => setQ({ ...q, questions: q.questions.filter((_, k) => k !== i) })}>Retirer</button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ConsentTab() {
  const { kb, reloadKb, notify } = useStore();
  const [text, setText] = useState(kb?.consentText ?? "");
  return (
    <Card title="Texte d'information lu au prospect">
      <textarea className="input min-h-[280px] text-sm" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-3 flex gap-2">
        <button className="btn btn-gold" onClick={() => saveConsentText(text).then(reloadKb).then(() => notify("Texte enregistré.")).catch((e) => notify(errorMessage(e)))}>Enregistrer</button>
        <button className="btn" onClick={() => setText(DEFAULT_CONSENT_TEXT)}>Texte par défaut</button>
      </div>
    </Card>
  );
}

function AboutTab() {
  const { info } = useStore();
  if (!info) return null;
  return (
    <Card title="Application">
      <dl className="grid grid-cols-[220px_1fr] gap-y-2 text-sm">
        <dt className="text-muted">Version</dt><dd>{info.version}</dd>
        <dt className="text-muted">Système</dt><dd>{info.os} / {info.arch}</dd>
        <dt className="text-muted">Dossier de données</dt><dd className="font-mono text-xs">{info.dataDir}</dd>
        <dt className="text-muted">Base de données</dt><dd>SQLCipher (chiffrée), schéma v{info.schemaVersion}</dd>
        <dt className="text-muted">Clé de chiffrement</dt><dd>{info.keyStorage === "keychain" ? "Trousseau macOS" : "Fichier local protégé (Trousseau indisponible)"}</dd>
        <dt className="text-muted">Whisper</dt><dd>{info.whisperCompiled ? "intégré (whisper.cpp)" : "non compilé"}</dd>
        <dt className="text-muted">Télémétrie</dt><dd>Aucune</dd>
      </dl>
    </Card>
  );
}

export default function Settings() {
  const { settings, reloadSettings, notify } = useStore();
  const [tab, setTab] = useState<Tab>("general");
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  useEffect(() => setDraft(settings), [settings]);
  if (!draft) return null;
  const set = (p: Partial<AppSettings>) => setDraft({ ...draft, ...p });
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const saveSettings = async () => {
    try {
      await api.settingsSet(draft);
      await reloadSettings();
      notify("Réglages enregistrés.");
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const settingsTab = tab === "general" || tab === "ai" || tab === "cloud";
  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 space-y-1 border-r border-line p-3">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${tab === id ? "bg-violet-600 font-semibold" : "text-muted hover:bg-panel-2"}`}>{label}</button>
        ))}
      </aside>
      <div className="scroll-y flex-1 space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{TABS.find((t) => t[0] === tab)?.[1]}</h1>
          {settingsTab && <button className="btn btn-gold" disabled={!dirty} onClick={saveSettings}>Enregistrer les réglages</button>}
        </div>
        {tab === "general" && <GeneralTab s={draft} set={set} />}
        {tab === "ai" && <AiTab s={draft} set={set} />}
        {tab === "cloud" && <CloudTab s={draft} set={set} />}
        {tab === "offers" && <OffersTab />}
        {tab === "questionnaires" && <QuestionnairesTab />}
        {tab === "consent" && <ConsentTab />}
        {tab === "about" && <AboutTab />}
      </div>
    </div>
  );
}
