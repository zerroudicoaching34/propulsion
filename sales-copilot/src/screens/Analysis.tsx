import { useMemo } from "react";
import { NoSession } from "../components/NoSession";
import { Card, Empty } from "../components/ui";
import { DISC_DISCLAIMER, DISC_TEACHING_GRID, observePreferences } from "../core/preferences";
import { buildNeedProfile, recommendOffer, type Tri } from "../core/recommendation";
import { useStore } from "../lib/store";

const TRI: Record<Tri, string> = { yes: "Oui", no: "Non", unknown: "Non exprimé" };

export default function Analysis() {
  const { session, settings, kb } = useStore();
  const observations = useMemo(() => (session ? observePreferences(session.segments) : []), [session]);
  const profile = useMemo(() => (session ? buildNeedProfile(session.prospect, session.segments, session.state.facts) : null), [session]);
  const reco = useMemo(() => (profile && kb ? recommendOffer(profile, kb.offers) : null), [profile, kb]);

  if (!session) return <NoSession target="analysis" title="Analyse conversationnelle — choisir un rendez-vous" />;

  return (
    <div className="scroll-y h-full space-y-5 p-6">
      <div>
        <h1 className="text-2xl font-bold">Analyse conversationnelle</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Observations fondées uniquement sur les mots employés par le prospect, chacune justifiée par un extrait. Aucune émotion, aucun trait
          psychologique et aucune information de santé ne sont déduits de la voix ou du ton.
        </p>
      </div>

      <Card title="Préférences de communication observées">
        {observations.length === 0 ? (
          <Empty>Pas assez d'éléments dans les propos du prospect pour une observation.</Empty>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {observations.map((o) => (
              <li key={o.key} className="rounded-lg border border-line bg-panel-2 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{o.label}</span>
                  <span className="chip text-muted">{o.count} indice(s)</span>
                </div>
                {o.evidence.map((e) => (
                  <blockquote key={e.segmentId} className="mt-2 border-l-2 border-gold/50 pl-2 text-[13px] text-muted italic">« {e.excerpt} »</blockquote>
                ))}
                {settings?.showDiscGrid && <p className="mt-2 text-[12px] text-gold">{DISC_TEACHING_GRID[o.key]}</p>}
              </li>
            ))}
          </ul>
        )}
        {settings?.showDiscGrid && <p className="mt-3 rounded border border-line p-2 text-[11px] text-muted">{DISC_DISCLAIMER}</p>}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Besoins identifiés">
          {profile && (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-line">
                {(
                  [
                    ["Autonome", profile.autonomous],
                    ["Souhaite du présentiel / encadrement", profile.wantsInPerson],
                    ["Souhaite la distance", profile.wantsRemote],
                    ["Programmation personnalisée", profile.wantsPersonalProgram],
                    ["Accompagnement nutrition", profile.wantsNutrition],
                    ["Veut apprendre une méthode", profile.wantsToLearnMethod],
                    ["Pratique hebdomadaire simple", profile.wantsSimpleWeekly],
                    ["Encadrement intensif", profile.wantsIntensive],
                    ["Peut se déplacer", profile.canTravel],
                    ["Demande un service premium", profile.wantsPremiumService],
                  ] as [string, Tri][]
                ).map(([l, v]) => (
                  <tr key={l}>
                    <td className="py-1.5">{l}</td>
                    <td className={`text-right ${v === "unknown" ? "text-muted" : v === "yes" ? "text-ok" : "text-warn"}`}>{TRI[v]}</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1.5">Budget communiqué</td>
                  <td className="text-right">{profile.budgetMonthly !== null ? `${profile.budgetMonthly} €` : <span className="text-muted">Non exprimé</span>}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Orientation d'offre">
          {reco && (
            <div className="space-y-3 text-sm">
              {reco.offerName ? (
                <div className="text-xl font-bold text-gold">{reco.offerName}</div>
              ) : (
                <div className="font-semibold text-warn">Pas de recommandation à ce stade</div>
              )}
              <ul className="list-disc pl-5">{reco.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              {reco.missing.length > 0 && <p className="text-warn">Informations manquantes : {reco.missing.join(", ")}</p>}
              {reco.alternatives.length > 0 && (
                <div>
                  <div className="text-xs text-muted">Autres options envisageables</div>
                  <ul className="mt-1 space-y-1">{reco.alternatives.map((a) => <li key={a.offerId}><strong>{a.offerName}</strong> <span className="text-muted">— {a.reason}</span></li>)}</ul>
                </div>
              )}
              <p className="text-[11px] text-muted">L'orientation repose sur les besoins exprimés ; elle ne privilégie jamais l'offre la plus chère. La décision appartient au prospect.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
