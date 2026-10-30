import type { Confirmation } from "./confirm.js";
import type { Rfq } from "./extract.js";
import type { Quotation } from "./quote.js";
import { SheetClient, type SheetAccess } from "./sheet.js";

/**
 * What the agent remembers about each RFQ, so a customer's reply can be matched to the exact
 * quotation they received (including the prices quoted at the time) and revised or confirmed.
 * Kept in a hidden tab; one row per RFQ, overwritten on each revision.
 */
export type QuotedState = {
  stage: "quoted";
  rfqMessageId: string;
  baseNumber: string;
  revision: number;
  rfq: Rfq;
  quotation: Quotation;
  updatedAt: string;
};

/** The RFQ has been read and a confirmation sent; no quotation exists until the customer confirms. */
export type ConfirmationState = {
  stage: "confirmation";
  rfqMessageId: string;
  /** The quotation number the quotation will get (Q-...), reserved now. */
  baseNumber: string;
  round: number;
  rfq: Rfq;
  confirmation: Confirmation;
  updatedAt: string;
};

export type QuoteState = QuotedState | ConfirmationState;

export const STATE_TAB = "_agent_state";
const HEADER = ["RFQ Message-ID", "Quote No.", "Revision", "Updated", "RFQ JSON", "Quotation JSON", "Reminders sent", "Last reminder"];
// Google Sheets cells hold at most 50,000 characters.
const MAX_CELL = 49_000;

// Not a table for people: kept hidden and compact (clipped text, short rows), never wrapped, since
// wrapping ~50,000-character JSON cells would make rows hundreds of lines tall.
const WIDTHS = [220, 140, 70, 160, 300, 300, 100, 160];

export function formatStateTab(sheet: SheetClient): Promise<void> {
  return formatHiddenTab(sheet, STATE_TAB, WIDTHS);
}

/** Compact format for hidden data tabs (agent state, alerts, usage): clipped text, short rows, never wrapped. */
export async function formatHiddenTab(sheet: SheetClient, title: string, widths: number[]): Promise<void> {
  const tab = await sheet.ensureTab(title, { hidden: true });
  await sheet.batchUpdate([
    {
      repeatCell: {
        range: { sheetId: tab.sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: widths.length },
        cell: { userEnteredFormat: { wrapStrategy: "CLIP", verticalAlignment: "TOP", textFormat: { fontSize: 9 } } },
        fields: "userEnteredFormat(wrapStrategy,verticalAlignment,textFormat)",
      },
    },
    ...widths.map((w, i) => ({
      updateDimensionProperties: {
        range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: w },
        fields: "pixelSize",
      },
    })),
    {
      updateDimensionProperties: {
        range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 0 },
        properties: { pixelSize: 21 },
        fields: "pixelSize",
      },
    },
  ]);
}

export async function saveState(access: SheetAccess, state: QuoteState): Promise<void> {
  const sheet = await SheetClient.connect(access);
  await sheet.ensureTab(STATE_TAB, { hidden: true });
  const ids = (await sheet.getValues(STATE_TAB, "A:A")).map((r) => r[0]);
  // Also upgrades a tab created before the reminder columns existed.
  if (ids.length === 0 || ((await sheet.getValues(STATE_TAB, "A1:1"))[0] ?? []).length < HEADER.length) {
    await sheet.putValues(STATE_TAB, "A1", [HEADER]);
    await formatStateTab(sheet);
  }

  const rfqJson = JSON.stringify(state.rfq);
  // Column F holds the quotation, or (before the customer has confirmed) the confirmation we sent.
  const documentJson = JSON.stringify(state.stage === "quoted" ? state.quotation : state.confirmation);
  const label = state.stage === "quoted" ? state.quotation.number : state.confirmation.number;
  if (rfqJson.length > MAX_CELL || documentJson.length > MAX_CELL) {
    throw new Error(`${label} is too large to store (${rfqJson.length}/${documentJson.length} chars)`);
  }
  // New customer activity starts the reminder count again (reminders sent = 0, no last reminder).
  const row = [state.rfqMessageId, label, state.stage === "quoted" ? state.revision : state.round, state.updatedAt, rfqJson, documentJson, 0, ""];
  const index = ids.indexOf(state.rfqMessageId);
  if (index > 0) await sheet.putValues(STATE_TAB, `A${index + 1}`, [row]);
  else await sheet.appendValues(STATE_TAB, [row]);
}

/** One stored row to a state. Rows written before confirmations existed hold a quotation: stage "quoted". */
export function parseStateRow(row: string[]): QuoteState {
  const document = JSON.parse(row[5]) as Quotation | Confirmation;
  const base = { rfqMessageId: row[0], updatedAt: row[3], rfq: JSON.parse(row[4]) as Rfq };
  if ("round" in document && "interpretations" in document) {
    return { ...base, stage: "confirmation", baseNumber: document.baseNumber, round: document.round, confirmation: document };
  }
  const quotation = document as Quotation;
  return { ...base, stage: "quoted", baseNumber: quotation.number.replace(/-R\d+$/, ""), revision: Number(row[2]) || 0, quotation };
}

/** Finds the stored state for the first of `messageIds` that is a known RFQ. */
export async function loadState(access: SheetAccess, messageIds: string[]): Promise<QuoteState | null> {
  const sheet = await SheetClient.connect(access);
  let rows: string[][];
  try {
    rows = await sheet.getValues(STATE_TAB, "A2:H");
  } catch {
    return null; // tab not created yet
  }
  for (const id of messageIds) {
    const row = rows.find((r) => r[0] === id);
    if (row) return parseStateRow(row);
  }
  return null;
}

/** Every stored RFQ with how many reminders it has had and when the last one was drafted. */
export async function listStates(access: SheetAccess): Promise<{ state: QuoteState; reminders: number; lastReminderAt: string }[]> {
  const sheet = await SheetClient.connect(access);
  let rows: string[][];
  try {
    rows = await sheet.getValues(STATE_TAB, "A2:H");
  } catch {
    return [];
  }
  return rows
    .filter((r) => r[0] && r[5])
    .map((r) => ({ state: parseStateRow(r), reminders: Number(r[6]) || 0, lastReminderAt: r[7] ?? "" }));
}

/** Records that a reminder draft was made for this RFQ. */
export async function markReminder(access: SheetAccess, rfqMessageId: string, reminders: number): Promise<void> {
  const sheet = await SheetClient.connect(access);
  const ids = (await sheet.getValues(STATE_TAB, "A:A")).map((r) => r[0]);
  const index = ids.indexOf(rfqMessageId);
  if (index < 1) return;
  await sheet.putValues(STATE_TAB, `G${index + 1}`, [[reminders, new Date().toISOString()]]);
}