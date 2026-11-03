import { useStore, type Screen } from "./lib/store";
import Analysis from "./screens/Analysis";
import Dashboard from "./screens/Dashboard";
import Debrief from "./screens/Debrief";
import LiveMeeting from "./screens/LiveMeeting";
import Prospects from "./screens/Prospects";
import Settings from "./screens/Settings";

const NAV: { id: Screen; label: string; icon: string }[] = [
  { id: "dashboard", label: "Tableau de bord", icon: "▦" },
  { id: "prospects", label: "Prospects", icon: "☰" },
  { id: "live", label: "Rendez-vous en direct", icon: "◉" },
  { id: "analysis", label: "Analyse conversationnelle", icon: "◇" },
  { id: "debrief", label: "Débriefing", icon: "✎" },
  { id: "settings", label: "Réglages & administration", icon: "⚙" },
];

const MODE_LABEL = { local: "100 % local", hybrid: "Hybride (cloud sur demande)", deep: "Analyse approfondie autorisée" } as const;

function MicBadge() {
  const { audio } = useStore();
  const st = audio?.state ?? "idle";
  if (st === "listening")
    return (
      <span className="chip border-danger bg-danger/15 text-danger" role="status">
        <span aria-hidden>●</span> Micro actif — écoute en cours
      </span>
    );
  if (st === "paused") return <span className="chip border-warn text-warn" role="status">❚❚ Micro en pause</span>;
  if (st === "loading_model") return <span className="chip text-muted" role="status">Chargement du modèle…</span>;
  return <span className="chip text-muted" role="status">Micro coupé</span>;
}

export default function App() {
  const { ready, fatal, screen, go, settings, toast, session, info } = useStore();

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card max-w-lg p-6">
          <h1 className="mb-2 text-lg font-bold text-gold">Smart &amp; Strong — Sales Copilot</h1>
          <p className="text-sm">{fatal}</p>
        </div>
      </div>
    );
  }
  if (!ready) return <div className="flex h-full items-center justify-center text-muted">Ouverture de la base locale chiffrée…</div>;

  return (
    <div className="flex h-full">
      <nav className="flex w-60 shrink-0 flex-col border-r border-line bg-violet/40" aria-label="Navigation principale">
        <div className="px-4 py-5">
          <div className="text-xs font-semibold tracking-[0.2em] text-gold">SMART &amp; STRONG</div>
          <div className="text-lg font-bold">Sales Copilot</div>
        </div>
        <ul className="flex-1 space-y-1 px-2">
          {NAV.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => go(n.id)}
                aria-current={screen === n.id ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${screen === n.id ? "bg-violet-600 font-semibold text-white" : "text-muted hover:bg-panel-2 hover:text-white"}`}
              >
                <span aria-hidden className="w-4 text-center text-gold">{n.icon}</span>
                {n.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t border-line p-3 text-[11px] text-muted">
          {session && (
            <div className="truncate">
              RDV ouvert : <span className="text-white">{session.meeting.type} — {session.prospect ? `${session.prospect.firstName} ${session.prospect.lastName}` : ""}</span>
            </div>
          )}
          <div>Base chiffrée {info?.keyStorage === "keychain" ? "(clé dans le Trousseau)" : "(clé dans un fichier local)"}</div>
          <div>Aucune télémétrie · v{info?.version}</div>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`chip ${settings?.aiMode === "local" ? "border-ok/50 text-ok" : "border-gold/60 text-gold"}`} title="Mode IA (modifiable dans Réglages)">
              {settings ? MODE_LABEL[settings.aiMode] : ""}
            </span>
          </div>
          <MicBadge />
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">
          {screen === "dashboard" && <Dashboard />}
          {screen === "prospects" && <Prospects />}
          {screen === "live" && <LiveMeeting />}
          {screen === "analysis" && <Analysis />}
          {screen === "debrief" && <Debrief />}
          {screen === "settings" && <Settings />}
        </main>
      </div>

      {toast && (
        <div role="alert" className="card fixed right-5 bottom-5 z-50 max-w-md border-gold/50 px-4 py-3 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
