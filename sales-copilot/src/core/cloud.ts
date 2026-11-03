import type { Prospect, Segment } from "./types";

// Cloud payload preparation. Nothing in this module sends anything: it only
// prepares the exact text that the coach previews, edits and explicitly confirms.
// The Rust backend re-checks the mode, the confirmation and the payload hash.

export interface RedactionOptions {
  names: boolean;
  contacts: boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// French phone numbers (06 12 34 56 78, +33 6 12 34 56 78, 0612345678…)
const PHONE = /(?:\+33\s?|0033\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, prospect: Pick<Prospect, "firstName" | "lastName" | "email" | "phone"> | null, opts: RedactionOptions): string {
  let out = text;
  if (opts.contacts) {
    out = out.replace(EMAIL, "[email]").replace(PHONE, "[téléphone]");
    if (prospect?.email) out = out.replace(new RegExp(escapeRegExp(prospect.email), "gi"), "[email]");
  }
  if (opts.names && prospect) {
    for (const [name, tag] of [[prospect.firstName, "[Prénom]"], [prospect.lastName, "[Nom]"]] as const) {
      if (name && name.trim().length >= 2) {
        out = out.replace(new RegExp(`(^|[^\\p{L}])${escapeRegExp(name.trim())}(?![\\p{L}])`, "giu"), `$1${tag}`);
      }
    }
  }
  return out;
}

export type CloudPurpose = "excerpt_analysis" | "deep_analysis";

export function buildCloudPayload(
  purpose: CloudPurpose,
  segments: Segment[],
  prospect: Prospect | null,
  opts: RedactionOptions,
  meetingType: "R1" | "R2",
): string {
  const speaker = { coach: "Coach", prospect: "Prospect", unknown: "Inconnu" } as const;
  const lines = segments.map((s) => `${speaker[s.speaker]} : ${redact(s.text, prospect, opts)}`);
  const instruction =
    purpose === "deep_analysis"
      ? `Analyse ce rendez-vous commercial ${meetingType} de coaching sportif. Donne : résumé factuel, besoins exprimés, objections, informations manquantes, points d'amélioration du coach. N'invente rien, cite des extraits, n'infère aucune information de santé ou psychologique.`
      : `Analyse ces extraits d'un rendez-vous ${meetingType}. Indique les informations commerciales importantes et une question pertinente à poser ensuite. N'invente rien.`;
  return `${instruction}\n\n---\n${lines.join("\n")}`;
}

/** SHA-256 hex of the UTF-8 payload — identical to the Rust-side check. */
export async function payloadHash(payload: string): Promise<string> {
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
