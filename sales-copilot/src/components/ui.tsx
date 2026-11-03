import type { ReactNode } from "react";
import type { QuestionStatus, Speaker } from "../core/types";

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold tracking-wide text-gold uppercase">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

const STATUS_STYLE: Record<QuestionStatus, { label: string; cls: string; icon: string }> = {
  not_covered: { label: "Non traitée", cls: "text-muted", icon: "○" },
  partial: { label: "Partielle", cls: "text-warn border-warn/40", icon: "◐" },
  covered: { label: "Traitée", cls: "text-ok border-ok/40", icon: "●" },
};

export function StatusChip({ status, manual }: { status: QuestionStatus; manual?: boolean }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`chip ${s.cls}`} title={manual ? "Validé manuellement" : "Détection automatique"}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
      {manual && <span aria-label="validé manuellement">✓</span>}
    </span>
  );
}

export const SPEAKER_LABEL: Record<Speaker, string> = { coach: "Coach", prospect: "Prospect", unknown: "À attribuer" };
export const SPEAKER_CLS: Record<Speaker, string> = {
  coach: "bg-violet-600 text-white",
  prospect: "bg-gold text-ink",
  unknown: "bg-panel-2 text-muted border border-dashed border-line",
};

export function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export function Confidence({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(value * 100);
  const cls = pct >= 75 ? "text-ok" : pct >= 50 ? "text-warn" : "text-danger";
  return <span className={`text-[10px] tabular-nums ${cls}`} title="Niveau de confiance">{pct} %</span>;
}
