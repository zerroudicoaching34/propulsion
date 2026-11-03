import { jsPDF } from "jspdf";
import type { Debrief } from "./types";

// PDF export of a debrief, generated locally (no network).

export function debriefToPdf(d: Debrief): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 48;
  const width = doc.internal.pageSize.getWidth() - margin * 2;
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = margin;

  const ensure = (h: number) => {
    if (y + h > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const para = (text: string, size = 10, style: "normal" | "bold" = "normal", color: [number, number, number] = [20, 20, 20]) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(text, width) as string[]) {
      ensure(size * 1.35);
      doc.text(line, margin, y);
      y += size * 1.35;
    }
  };
  const section = (title: string, body: string | string[]) => {
    y += 8;
    para(title, 12, "bold", [42, 20, 70]);
    const items = Array.isArray(body) ? (body.length ? body.map((b) => `• ${b}`) : ["• Non renseigné"]) : [body];
    for (const item of items) para(item);
  };

  para(`Débriefing ${d.meetingType} — ${d.prospectName}`, 18, "bold", [42, 20, 70]);
  para(`Généré le ${new Date(d.generatedAt).toLocaleString("fr-FR")} — Smart & Strong Sales Copilot`, 9, "normal", [110, 110, 110]);
  section("Résumé", d.summary);
  section("Objectif déclaré", d.objective);
  section("Difficultés identifiées", d.difficulties);
  section("Besoins exprimés", d.needs);
  section("Questions et objections", d.questionsAndObjections);
  section("Réponses apportées", d.answersGiven);
  section("Informations manquantes", d.missingInformation);
  section("Offre éventuellement recommandée", d.recommendedOffer);
  section("Décision réellement exprimée", d.decision);
  section("Prochaine action convenue", d.nextAction);
  section("Points d'amélioration du coach", d.coachImprovements);
  y += 8;
  para(
    `Couverture : ${d.coverage.covered} traités, ${d.coverage.partial} partiels / ${d.coverage.total}. Temps de parole : coach ${d.talkRatio.coach} %, prospect ${d.talkRatio.prospect} %.`,
    9,
    "normal",
    [110, 110, 110],
  );
  return new Uint8Array(doc.output("arraybuffer"));
}
