import type { AiConfig } from "./config.js";
import type { Rfq } from "./extract.js";
import type { InventoryItem } from "./inventory.js";
import type { FetchedEmail } from "./mail.js";
import { matchRfq, type LineStatus, type Matched, type MatchedLine } from "./quote.js";

// The email that goes to the customer BEFORE any quotation: what we understood, which catalog part we
// matched (no prices, no stock), every interpretation we made, and what we still need to know. The
// quotation is only prepared after the customer replies to confirm. Nothing here is assumed: whatever
// is unclear becomes a question.

export type ConfirmationOffer = {
  label: string;
  sku: string;
  partNumber: string;
  description: string;
  maker: string;
  quality: string;
  specifications: string;
};

export type ConfirmationLine = {
  no: number;
  requested: string;
  status: LineStatus;
  /** Exact part-number match (checked by code). False = matched by description, or not matched. */
  verified: boolean;
  qty: number | null;
  note: string;
  offers: ConfirmationOffer[];
  /** Every SKU the customer has been shown for this line, in all rounds. Absent in old stored rows. */
  seen?: string[];
};

export type Confirmation = {
  /** CF-yymmdd-HASH, with -2, -3 for later rounds. */
  number: string;
  /** The quotation number (Q-...) reserved for this RFQ. */
  baseNumber: string;
  round: number;
  /** The RFQ's own subject, kept for the quotation that follows. */
  subject: string;
  vessel: string;
  lines: ConfirmationLine[];
  interpretations: string[];
  questions: string[];
  greeting: string;
  intro: string;
  closing: string;
};

export const MAX_CONFIRMATION_ROUNDS = 3;

export function confirmationNumber(baseQuoteNumber: string, round: number): string {
  return `${baseQuoteNumber.replace(/^Q-/, "CF-")}${round > 1 ? `-${round}` : ""}`;
}

function toLine(l: MatchedLine): ConfirmationLine {
  return {
    no: l.no,
    requested: l.requested,
    status: l.status,
    verified: l.verified,
    qty: l.qty,
    note: l.note,
    offers: l.offers.map((o) => ({
      label: o.label,
      sku: o.item.sku,
      partNumber: o.item.partNumber,
      description: o.item.description,
      maker: o.item.maker,
      quality: o.item.quality,
      specifications: o.item.specifications,
    })),
  };
}

/** Builds the confirmation from an already matched RFQ (pure: no Claude call). */
export function confirmationFrom(
  email: FetchedEmail,
  rfq: Rfq,
  match: Matched,
  baseQuoteNumber: string,
  round: number,
  /** Later rounds: the confirmation the customer last saw, and which of its lines each current line came from. */
  previous?: { confirmation: Confirmation; origins: (number | null)[] },
): Confirmation {
  const lines = match.lines.map((l, i) => {
    const line = toLine(l);
    const origin = previous?.origins[i];
    const before = origin === null || origin === undefined ? undefined : previous?.confirmation.lines[origin];
    const prior = before ? before.seen ?? before.offers.map((o) => o.sku) : [];
    return { ...line, seen: [...new Set([...prior, ...line.offers.map((o) => o.sku)])] };
  });

  // Questions the code always asks, so they never depend on the model remembering to.
  const questions = [...match.questions];
  for (const l of lines) {
    if (l.qty === null && l.status !== "needs_info") questions.push(`How many do you need for item ${l.no}?`);
  }
  if (rfq.quality_preference === null) {
    questions.push("Which quality do you want: genuine OEM, OEM-licensed (maker-approved) or aftermarket?");
  }

  return {
    number: confirmationNumber(baseQuoteNumber, round),
    baseNumber: baseQuoteNumber,
    round,
    subject: email.subject,
    vessel: rfq.vessel.name,
    lines,
    interpretations: rfq.assumptions.map((a) => a.trim()).filter(Boolean),
    questions: questions.filter((q, i) => questions.indexOf(q) === i),
    greeting: match.greeting,
    intro: match.intro,
    closing: match.closing,
  };
}

export async function buildConfirmation(
  email: FetchedEmail,
  rfq: Rfq,
  inventory: InventoryItem[],
  ai: AiConfig,
  options: { round: number; baseQuoteNumber: string; context?: string },
): Promise<Confirmation> {
  const match = await matchRfq(email, rfq, inventory, ai, { mode: "confirm", context: options.context });
  return confirmationFrom(email, rfq, match, options.baseQuoteNumber, options.round);
}

/**
 * May the quotation be prepared now? Every line must be settled without us having assumed anything:
 * an exact part-number match, or the same catalog part the customer saw in our confirmation, or a
 * definite "not in our catalog". `origins[i]` is the line number (0-based) the current line had in the
 * confirmation the customer saw, or null for an item added since.
 */
export function checkReady(lines: MatchedLine[], shown: Confirmation, origins: (number | null)[]): { ready: boolean; open: number[] } {
  // "Seen": the customer was shown this catalog part for this line in some round, and has now confirmed.
  const open: number[] = [];
  lines.forEach((l, i) => {
    if (l.status === "not_stocked") return;
    if (l.status === "quoted" && l.qty !== null && l.offers.length === 1) {
      if (l.verified) return;
      const prev = origins[i] === null || origins[i] === undefined ? undefined : shown.lines[origins[i]!];
      const seen = prev ? prev.seen ?? prev.offers.map((o) => o.sku) : [];
      if (seen.includes(l.offers[0].item.sku)) return;
    }
    open.push(l.no);
  });
  return { ready: open.length === 0, open };
}

/** What we showed the customer, for Claude to read when their reply arrives. */
export function confirmationSummary(c: Confirmation): string {
  return [
    `Confirmation ${c.number} (round ${c.round}, vessel ${c.vessel || "-"})`,
    ...c.lines.map((l) => {
      const offers = l.offers.map((o) => `   ${o.label}: SKU ${o.sku}, ${o.description}, ${o.maker}, P/N ${o.partNumber}, ${o.quality}`).join("\n");
      return `Line ${l.no} [${l.status}${l.verified ? ", exact part number" : ""}] ${l.requested}${l.note ? ` | note: ${l.note}` : ""}${offers ? `\n${offers}` : ""}`;
    }),
    c.questions.length ? `Our open questions: ${c.questions.map((x, i) => `${i + 1}) ${x}`).join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Rendering ──────────────────────────────────────────────────────────────────────────────

export const lineStatusText = (l: ConfirmationLine): string => {
  switch (l.status) {
    case "quoted":
      return l.verified ? "Matched by your part number" : "Matched by description, so please check it's the right part";
    case "choose":
      return "Please choose one option";
    case "not_stocked":
      return "Not in our catalog";
    case "needs_info":
      return "We need a bit more information";
  }
};

export function confirmationInstruction(c: Confirmation): string {
  return c.questions.length > 0
    ? "Once you've answered those and the rest looks right, reply and we'll prepare your quotation."
    : "If all of this looks right, just reply \"Confirmed\" and we'll prepare your quotation.";
}

/** The email body; the item-by-item table is in the attached PDF (renderConfirmationPdf). */
export function renderConfirmation(c: Confirmation, signature: string): { text: string } {
  const text = [c.greeting, "", c.intro, "", `Our request confirmation ${c.number} is attached, listing each item and the part we matched.`, ""];
  if (c.questions.length > 0) text.push("A few things we need from you:", ...c.questions.map((x, i) => `${i + 1}. ${x}`), "");
  text.push(confirmationInstruction(c), "", ...(c.closing ? [c.closing, ""] : []), signature);
  return { text: text.join("\n") };
}
