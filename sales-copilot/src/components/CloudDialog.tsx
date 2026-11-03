import { useEffect, useState } from "react";
import { buildCloudPayload, payloadHash, type CloudPurpose, type RedactionOptions } from "../core/cloud";
import type { Prospect, Segment } from "../core/types";
import { api, errorMessage } from "../lib/api";
import { useStore } from "../lib/store";

// Explicit, previewed, editable, cancellable cloud transfer. Nothing is sent before
// the coach ticks the confirmation and clicks "Envoyer". The backend re-checks the
// mode, the confirmation and that the payload is exactly the one previewed.

export function CloudDialog({
  purpose,
  segments,
  prospect,
  meetingId,
  meetingType,
  onClose,
  onResult,
}: {
  purpose: CloudPurpose;
  segments: Segment[];
  prospect: Prospect | null;
  meetingId: string;
  meetingType: "R1" | "R2";
  onClose: () => void;
  onResult: (content: string) => void;
}) {
  const { settings, notify } = useStore();
  const [opts, setOpts] = useState<RedactionOptions>({ names: true, contacts: true });
  const [payload, setPayload] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  useEffect(() => {
    setPayload(buildCloudPayload(purpose, segments, prospect, opts, meetingType));
    setConfirmed(false);
  }, [purpose, segments, prospect, opts, meetingType]);

  useEffect(() => {
    if (settings) api.secretHasApiKey(settings.cloud.kind).then(setHasKey).catch(() => setHasKey(false));
  }, [settings]);

  if (!settings) return null;
  const provider = settings.cloud;

  const send = async () => {
    setSending(true);
    try {
      const previewSha256 = await payloadHash(payload);
      const res = await api.cloudAnalyze({ meetingId, purpose, payload, previewSha256, confirmed });
      onResult(res.content);
      notify(`Analyse reçue de ${res.provider} (${res.model}). Transfert journalisé.`);
      onClose();
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-labelledby="cloud-title">
      <div className="card flex max-h-full w-full max-w-3xl flex-col p-5">
        <h2 id="cloud-title" className="text-lg font-bold text-gold">
          {purpose === "deep_analysis" ? "Analyse approfondie dans le cloud" : "Analyse cloud d'extraits"}
        </h2>
        <div className="mt-3 space-y-1 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          <p>
            <strong>Fournisseur :</strong> {provider.label} — modèle <code>{provider.model}</code> ({provider.baseUrl})
          </p>
          <p>
            Le texte ci-dessous quittera votre ordinateur et sera traité par ce fournisseur, selon ses propres conditions de conservation.
            Vérifiez que le prospect a accepté ce traitement, en particulier si des informations de santé sont évoquées.
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={opts.names} onChange={(e) => setOpts((o) => ({ ...o, names: e.target.checked }))} /> Masquer les noms
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={opts.contacts} onChange={(e) => setOpts((o) => ({ ...o, contacts: e.target.checked }))} /> Masquer e-mails et téléphones
          </label>
          <span className="text-muted">{segments.length} extrait(s) · {payload.length.toLocaleString("fr-FR")} caractères</span>
        </div>
        <label className="label mt-3" htmlFor="cloud-payload">Données envoyées (modifiables)</label>
        <textarea id="cloud-payload" className="input scroll-y min-h-[260px] flex-1 font-mono text-xs" value={payload} onChange={(e) => { setPayload(e.target.value); setConfirmed(false); }} />
        {hasKey === false && <p className="mt-2 text-sm text-danger">Aucune clé API enregistrée pour ce fournisseur (Réglages → Cloud).</p>}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
          J'ai relu ces données et je confirme leur envoi à {provider.label}.
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose} disabled={sending}>Annuler</button>
          <button className="btn btn-gold" onClick={send} disabled={!confirmed || sending || !payload.trim() || hasKey === false}>
            {sending ? "Envoi…" : "Envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}
