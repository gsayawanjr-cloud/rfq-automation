import { JWT } from "google-auth-library";
import type { FetchedEmail } from "./mail.js";
import type { Rfq } from "./extract.js";

/** Access to the spreadsheet; each table (RFQs, Inventory, Quotations) is a tab in it. */
export type SheetAccess = { serviceAccountJson: string; sheetId: string };
export type SheetConfig = SheetAccess & { tab: string };

export type Cell = string | number;

export type Column = {
  header: string;
  /** Maximum width in pixels. Columns are sized to their content up to this; longer text wraps. */
  width: number;
  /** Minimum width in pixels (default 60). */
  minWidth?: number;
  align?: "LEFT" | "CENTER" | "RIGHT";
  muted?: boolean;
  /** Sheets number format pattern, e.g. "#,##0.00" for prices. */
  numberFormat?: string;
};

/** Colored "pill" for cells whose value matches. */
export type Pill = { column: string; condition: "TEXT_EQ" | "NUMBER_EQ"; value: string; bg: string; fg: string };

export type TableSpec = {
  columns: Column[];
  frozenColumns: number;
  pills?: Pill[];
  dropdowns?: { column: string; options: string[] }[];
};

// ─── Shared table machinery ─────────────────────────────────────────────────────────────────

// Sheets can't auto-fit row heights to wrapped text from the API, so estimate it: average glyph width
// of 10pt Arial, line height, and cell padding, all in pixels.
const CHAR_WIDTH = 7;
const LINE_HEIGHT = 17;
const CELL_PADDING = 8;
const MIN_ROW_HEIGHT = 21;
const HEADER_MIN_HEIGHT = 40;
const DEFAULT_MIN_WIDTH = 60;
// Bold header text is a little wider than body text.
const BOLD_FACTOR = 1.1;
// Every header has a filter button on its right, which takes this much of the text width.
const FILTER_BUTTON = 24;
// Headers wrap onto at most this many lines.
const HEADER_MAX_LINES = 2;

// Dropdown cells show an arrow chip on their right, which takes this much of the text width.
const DROPDOWN_ARROW = 24;

// Muted columns (Message-IDs) use 8pt text, about 80% the width of the 10pt body text.
const MUTED_FACTOR = 0.8;

/**
 * Per-column body text metrics: pill columns show bold text, muted columns small text, and
 * dropdown columns lose room to their arrow.
 */
function bodyMetrics(spec: TableSpec) {
  const pills = new Set((spec.pills ?? []).map((p) => p.column));
  const dropdowns = new Map((spec.dropdowns ?? []).map((d) => [d.column, d.options]));
  return spec.columns.map((c) => ({
    charWidth: CHAR_WIDTH * (c.muted ? MUTED_FACTOR : 1) * (pills.has(c.header) ? BOLD_FACTOR : 1),
    reserved: dropdowns.has(c.header) ? DROPDOWN_ARROW : 0,
    options: dropdowns.get(c.header) ?? [],
  }));
}

/**
 * Lines a text takes when wrapped like Sheets does: whole words per line, breaking a word only
 * when it is longer than a full line.
 */
function wrappedLines(text: string, charsPerLine: number): number {
  return text.split("\n").reduce((total, paragraph) => {
    let lines = 1;
    let used = 0;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const need = used === 0 ? word.length : used + 1 + word.length;
      if (need <= charsPerLine) used = need;
      else if (word.length <= charsPerLine) {
        lines++;
        used = word.length;
      } else {
        // A word longer than a line breaks across lines.
        lines += used === 0 ? Math.ceil(word.length / charsPerLine) - 1 : Math.ceil(word.length / charsPerLine);
        used = word.length % charsPerLine || charsPerLine;
      }
    }
    return total + lines;
  }, 0);
}

/** Row height for wrapped text, from the columns' actual widths (less `reserved(i)` px per cell). */
function estimateRowHeight(
  widths: number[],
  row: Cell[],
  charWidth: (i: number) => number = () => CHAR_WIDTH,
  reserved: (i: number) => number = () => 0,
): number {
  const lines = row.map((value, i) => {
    const charsPerLine = Math.max(1, Math.floor(((widths[i] ?? 100) - CELL_PADDING * 2 - reserved(i)) / charWidth(i)));
    return wrappedLines(String(value ?? ""), charsPerLine);
  });
  return Math.max(MIN_ROW_HEIGHT, Math.max(1, ...lines) * LINE_HEIGHT + CELL_PADDING);
}

/** Width a header needs to show whole words on at most HEADER_MAX_LINES lines, beside its filter button. */
function headerWidth(header: string): number {
  let chars = Math.max(1, ...header.split(/\s+/).map((w) => w.length));
  while (wrappedLines(header, chars) > HEADER_MAX_LINES) chars++;
  return Math.ceil(chars * CHAR_WIDTH * BOLD_FACTOR + CELL_PADDING * 2 + FILTER_BUTTON + 4);
}

/**
 * Width each column needs: its data's longest line, within [minWidth, width], but never narrower
 * than its header needs or (for dropdowns) its longest option on one line, so headers and
 * dropdown values stay readable whatever the column's maximum.
 */
function fitWidths(spec: TableSpec, values: string[][]): number[] {
  const metrics = bodyMetrics(spec);
  return spec.columns.map((c, i) => {
    const { charWidth, reserved, options } = metrics[i]!;
    const longest = values
      .slice(1)
      .reduce((max, row) => Math.max(max, ...String(row[i] ?? "").split("\n").map((l) => l.length)), 0);
    const dataNeed = Math.ceil(longest * charWidth + CELL_PADDING * 2 + reserved + 4);
    const longestOption = Math.max(0, ...options.map((o) => o.length));
    const optionNeed = options.length > 0 ? Math.ceil(longestOption * CHAR_WIDTH * BOLD_FACTOR + CELL_PADDING * 2 + reserved + 4) : 0;
    return Math.max(headerWidth(c.header), optionNeed, Math.min(c.width, Math.max(c.minWidth ?? DEFAULT_MIN_WIDTH, dataNeed)));
  });
}

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

export function columnLetter(index: number): string {
  let letter = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  }
  return letter;
}

async function getToken(serviceAccountJson: string): Promise<string> {
  let credentials: { client_email?: string; private_key?: string };
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  const jwt = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Could not get a Google access token for the service account");
  return token;
}

async function sheetsFetch(token: string, url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Google Sheets API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export type TabInfo = { title: string; sheetId: number; bandedRangeIds: number[]; conditionalFormatCount: number };

export class SheetClient {
  readonly spreadsheet: string;

  private constructor(private token: string, access: SheetAccess) {
    this.spreadsheet = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(access.sheetId)}`;
  }

  static async connect(access: SheetAccess): Promise<SheetClient> {
    return new SheetClient(await getToken(access.serviceAccountJson), access);
  }

  private range(tab: string, range: string) {
    return encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${range}`);
  }

  batchUpdate(requests: object[]) {
    if (requests.length === 0) return Promise.resolve({});
    return sheetsFetch(this.token, `${this.spreadsheet}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
  }

  /** Values as displayed (formatted), one array per row. */
  async getValues(tab: string, range: string): Promise<string[][]> {
    const result = await sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}`);
    return result.values ?? [];
  }

  /** Raw values: numbers stay numbers (prices, stock). */
  async getRawValues(tab: string, range: string): Promise<Cell[][]> {
    const result = await sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return result.values ?? [];
  }

  putValues(tab: string, range: string, values: Cell[][]) {
    return sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
  }

  clearValues(tab: string, range: string) {
    return sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}:clear`, { method: "POST", body: "{}" });
  }

  /** Appends rows and returns the 1-based sheet row of the first one. */
  async appendValues(tab: string, values: Cell[][]): Promise<number | null> {
    // OVERWRITE fills the next empty, already-formatted rows. INSERT_ROWS would insert new rows that
    // copy the formatting of the row above — for the first row, the header's white bold text.
    const result = await sheetsFetch(
      this.token,
      `${this.spreadsheet}/values/${this.range(tab, "A1")}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
      { method: "POST", body: JSON.stringify({ values }) },
    );
    // updatedRange looks like "'RFQs'!A3:T3"; the number after the "!" column letters is the first row written.
    return Number(/!\$?[A-Z]+\$?(\d+)/.exec(result.updates?.updatedRange ?? "")?.[1]) || null;
  }

  /**
   * Sizes every column to its content (within the column's min/max; longer text wraps), then sets
   * every row tall enough for its wrapped text at those widths. Call after any data is written.
   */
  async fitColumns(tab: TabInfo, spec: TableSpec): Promise<void> {
    const values = await this.getValues(tab.title, `A1:${columnLetter(spec.columns.length - 1)}`);
    const widths = fitWidths(spec, values);
    const metrics = bodyMetrics(spec);
    const headerHeight = Math.max(
      HEADER_MIN_HEIGHT,
      estimateRowHeight(widths, spec.columns.map((c) => c.header), () => CHAR_WIDTH * BOLD_FACTOR, () => FILTER_BUTTON),
    );
    await this.batchUpdate([
      ...widths.map((w, i) => ({
        updateDimensionProperties: {
          range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: w },
          fields: "pixelSize",
        },
      })),
      {
        updateDimensionProperties: {
          range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: headerHeight },
          fields: "pixelSize",
        },
      },
      ...values.slice(1).map((row, i) => ({
        updateDimensionProperties: {
          range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: i + 1, endIndex: i + 2 },
          properties: {
            pixelSize: estimateRowHeight(widths, row, (col) => metrics[col]?.charWidth ?? CHAR_WIDTH, (col) => metrics[col]?.reserved ?? 0),
          },
          fields: "pixelSize",
        },
      })),
    ]);
  }

  /** Titles of all tabs in the spreadsheet. */
  async listTabs(): Promise<string[]> {
    const meta = await sheetsFetch(this.token, `${this.spreadsheet}?fields=sheets(properties(title))`);
    return (meta.sheets ?? []).map((s: any) => s.properties.title);
  }

  /** Finds a tab, creating it (optionally hidden) if it doesn't exist yet. */
  async ensureTab(title: string, options: { hidden?: boolean } = {}): Promise<TabInfo> {
    const meta = await sheetsFetch(
      this.token,
      `${this.spreadsheet}?fields=sheets(properties(sheetId,title),bandedRanges(bandedRangeId),conditionalFormats(booleanRule))`,
    );
    const sheet = (meta.sheets ?? []).find((s: any) => s.properties.title === title);
    if (sheet) {
      return {
        title,
        sheetId: sheet.properties.sheetId,
        bandedRangeIds: (sheet.bandedRanges ?? []).map((b: any) => b.bandedRangeId),
        conditionalFormatCount: (sheet.conditionalFormats ?? []).length,
      };
    }
    const created = await this.batchUpdate([{ addSheet: { properties: { title, hidden: options.hidden === true } } }]);
    return { title, sheetId: created.replies[0].addSheet.properties.sheetId, bandedRangeIds: [], conditionalFormatCount: 0 };
  }

  /**
   * Writes the header and applies the table styling: wrapped text everywhere, banding, pills,
   * dropdowns, filter, and columns sized to their content. Safe to run repeatedly. Every visible
   * table tab must be created through this, so new tabs always wrap and auto-size.
   */
  async applyLayout(tab: TabInfo, spec: TableSpec): Promise<void> {
    const header = spec.columns.map((c) => c.header);
    await this.putValues(tab.title, "A1", [header]);

    const sheetId = tab.sheetId;
    const all = { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: spec.columns.length };
    const body = (col: number) => ({ sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 });
    const col = (name: string) => {
      const index = header.indexOf(name);
      if (index === -1) throw new Error(`Table has no column "${name}"`);
      return index;
    };
    const navy = rgb("#1F3864");

    await this.batchUpdate([
      // Clear earlier styling so re-running doesn't stack duplicates.
      ...tab.bandedRangeIds.map((id) => ({ deleteBanding: { bandedRangeId: id } })),
      ...Array.from({ length: tab.conditionalFormatCount }, (_, i) => ({
        deleteConditionalFormatRule: { sheetId, index: tab.conditionalFormatCount - 1 - i },
      })),
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: spec.frozenColumns } },
          fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      {
        repeatCell: {
          range: { ...all, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: navy,
              horizontalAlignment: "LEFT",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              textFormat: { bold: true, fontSize: 10, foregroundColor: rgb("#FFFFFF") },
            },
          },
          fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
        },
      },
      ...spec.columns.map((c, i) => ({
        repeatCell: {
          range: body(i),
          cell: {
            userEnteredFormat: {
              horizontalAlignment: c.align ?? "LEFT",
              verticalAlignment: "TOP",
              wrapStrategy: "WRAP",
              textFormat: { fontSize: c.muted ? 8 : 10, foregroundColor: rgb(c.muted ? "#808080" : "#1F1F1F") },
              ...(c.numberFormat ? { numberFormat: { type: "NUMBER", pattern: c.numberFormat } } : {}),
            },
          },
          // backgroundColor is listed but unset, which clears any fill so the row banding shows.
          fields: `userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat${c.numberFormat ? ",numberFormat" : ""})`,
        },
      })),
      {
        addBanding: {
          bandedRange: {
            range: all,
            rowProperties: { headerColor: navy, firstBandColor: rgb("#FFFFFF"), secondBandColor: rgb("#F3F6FB") },
          },
        },
      },
      ...(spec.pills ?? []).map((p) => ({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [body(col(p.column))],
            booleanRule: {
              condition: { type: p.condition, values: [{ userEnteredValue: p.value }] },
              format: { backgroundColor: rgb(p.bg), textFormat: { bold: true, foregroundColor: rgb(p.fg) } },
            },
          },
        },
      })),
      ...(spec.dropdowns ?? []).map((d) => ({
        setDataValidation: {
          range: body(col(d.column)),
          rule: {
            condition: { type: "ONE_OF_LIST", values: d.options.map((v) => ({ userEnteredValue: v })) },
            showCustomUi: true,
            strict: true,
          },
        },
      })),
      { setBasicFilter: { filter: { range: all } } },
    ]);
    // Column widths and row heights follow the content.
    await this.fitColumns(tab, spec);
  }
}

// ─── RFQs tab ───────────────────────────────────────────────────────────────────────────────

// Widths are maximums: columns shrink to their content, and longer text wraps.
// Status keeps room for its longest option ("Needs attention") and the dropdown arrow.
/** Statuses in the RFQs dropdown, in the order the team sees them. */
export const RFQ_STATUSES = [
  "New",
  "Awaiting confirmation",
  "Quote drafted",
  "Awaiting info",
  "Quoted",
  "Order pending",
  "Negotiating",
  "Needs attention",
  "No response",
  "Won",
  "Lost",
] as const;

/** Statuses the agent may move an RFQ out of. Won and Lost, set by the team, are never overwritten. */
export const OPEN_STATUSES: string[] = RFQ_STATUSES.filter((s) => s !== "Won" && s !== "Lost");

export const RFQ_TABLE: TableSpec = {
  columns: [
    { header: "Received (UTC)", width: 125, align: "CENTER" },
    { header: "Status", width: 140, minWidth: 135, align: "CENTER" },
    { header: "Urgency", width: 95, align: "CENTER" },
    { header: "Vessel", width: 150 },
    { header: "IMO", width: 85, align: "CENTER" },
    { header: "Requester", width: 210 },
    { header: "Port", width: 105 },
    { header: "ETA", width: 95, align: "CENTER" },
    { header: "Required by", width: 95, align: "CENTER" },
    { header: "Equipment", width: 230 },
    { header: "Items requested", width: 360 },
    { header: "Quality", width: 110, align: "CENTER" },
    { header: "Questions blocking quote", width: 320 },
    { header: "Other missing info", width: 280 },
    { header: "Urgency reason", width: 300 },
    { header: "Agent", width: 140 },
    { header: "Subject", width: 260 },
    { header: "Assumptions", width: 480 },
    { header: "Draft reply", width: 90, align: "CENTER" },
    { header: "Message-ID", width: 160, muted: true },
    // Added later; new columns go at the end so existing rows keep their layout.
    { header: "History", width: 420 },
  ],
  frozenColumns: 4, // through Vessel
  pills: [
    { column: "Urgency", condition: "TEXT_EQ", value: "CRITICAL", bg: "#F4CCCC", fg: "#990000" },
    { column: "Urgency", condition: "TEXT_EQ", value: "HIGH", bg: "#FCE5CD", fg: "#B45F06" },
    { column: "Urgency", condition: "TEXT_EQ", value: "NORMAL", bg: "#D9EAD3", fg: "#274E13" },
    { column: "Status", condition: "TEXT_EQ", value: "New", bg: "#CFE2F3", fg: "#1C4587" },
    { column: "Status", condition: "TEXT_EQ", value: "Awaiting confirmation", bg: "#D9D2E9", fg: "#351C75" },
    { column: "Status", condition: "TEXT_EQ", value: "Quote drafted", bg: "#D0E0E3", fg: "#0C343D" },
    { column: "Status", condition: "TEXT_EQ", value: "Order pending", bg: "#FFE599", fg: "#7F6000" },
    { column: "Status", condition: "TEXT_EQ", value: "No response", bg: "#E6B8AF", fg: "#5B0F00" },
    { column: "Status", condition: "TEXT_EQ", value: "Awaiting info", bg: "#FFF2CC", fg: "#7F6000" },
    { column: "Status", condition: "TEXT_EQ", value: "Negotiating", bg: "#FCE5CD", fg: "#B45F06" },
    { column: "Status", condition: "TEXT_EQ", value: "Needs attention", bg: "#F4CCCC", fg: "#990000" },
    { column: "Status", condition: "TEXT_EQ", value: "Quoted", bg: "#D9D2E9", fg: "#351C75" },
    { column: "Status", condition: "TEXT_EQ", value: "Won", bg: "#D9EAD3", fg: "#274E13" },
    { column: "Status", condition: "TEXT_EQ", value: "Lost", bg: "#EFEFEF", fg: "#666666" },
  ],
  // "Awaiting confirmation" (confirmation drafted, customer has not confirmed yet) and "Quote drafted" are set
  // automatically; the team moves it on to "Quoted" once they send the quotation.
  dropdowns: [
    { column: "Status", options: [...RFQ_STATUSES] },
  ],
};

const RFQ_HEADER = RFQ_TABLE.columns.map((c) => c.header);
const MESSAGE_ID_COL = RFQ_HEADER.indexOf("Message-ID");

export const QUALITY_LABELS: Record<string, string> = {
  genuine_oem: "Genuine OEM",
  oem_licensed: "OEM-licensed",
  aftermarket: "Aftermarket",
  any: "Any",
};

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function toRfqRow(email: FetchedEmail, rfq: Rfq): string[] {
  const requesterName = rfq.requester.name || email.fromName || "";
  const requester = [
    [requesterName, rfq.requester.rank_or_title].filter(Boolean).join(" · "),
    rfq.requester.company,
    email.fromAddress,
  ]
    .filter(Boolean)
    .join("\n");

  const equipment = rfq.equipment
    .map((e) => {
      const name = [e.maker, e.model].filter(Boolean).join(" ") || "Unspecified";
      const serial = e.serial_number ? ` (S/N ${e.serial_number})` : "";
      return `${capitalize(e.role || "Equipment")}: ${name}${serial}`;
    })
    .join("\n");

  const items = rfq.items
    .map((i) => {
      const qty = i.quantity !== null ? `${i.quantity} ${i.unit}`.trim() : "Qty ?";
      const pn = i.part_number ? ` (P/N ${i.part_number})` : "";
      const source = i.source ? ` [${i.source}]` : "";
      return `• ${qty} — ${i.normalized_description}${pn}${source}`;
    })
    .join("\n");

  const blocking = rfq.missing_info
    .filter((m) => m.blocks_quote)
    .map((m, i) => `${i + 1}. ${m.field}`)
    .join("\n");
  const other = rfq.missing_info.filter((m) => !m.blocks_quote).map((m) => m.field).join("; ");

  const row: Record<string, string> = {
    "Received (UTC)": email.receivedAt.slice(0, 16).replace("T", " "),
    Status: "New",
    Urgency: rfq.urgency,
    Vessel: rfq.vessel.name,
    IMO: rfq.vessel.imo,
    Requester: requester,
    Port: rfq.delivery.port,
    ETA: rfq.delivery.vessel_eta,
    "Required by": rfq.delivery.required_by_date,
    Equipment: equipment,
    "Items requested": items,
    Quality: rfq.quality_preference ? QUALITY_LABELS[rfq.quality_preference] : "Not stated",
    "Questions blocking quote": blocking || "None",
    "Other missing info": other,
    "Urgency reason": rfq.urgency_reason,
    Agent: rfq.delivery.agent,
    Subject: email.subject,
    Assumptions: [...rfq.assumptions, ...(rfq.internal_notes ?? [])].join(" | "),
    // Rows are only written after the draft step has succeeded.
    "Draft reply": "Yes",
    "Message-ID": email.messageId,
    History: `${email.receivedAt.slice(0, 10)}: RFQ received`,
  };
  // No blank cells: the sales team should see that a value was missing from the email, not wonder.
  return RFQ_HEADER.map((h) => row[h]?.trim() || "Not stated");
}

/** Appends one row per RFQ. Skips the append if the Message-ID is already in the sheet. Returns false if skipped. */
export async function appendRfqRow(config: SheetConfig, email: FetchedEmail, rfq: Rfq): Promise<boolean> {
  const sheet = await SheetClient.connect(config);
  const tab = await sheet.ensureTab(config.tab);

  const headerRow = (await sheet.getValues(tab.title, "A1:1"))[0] ?? [];
  if (headerRow.length === 0) await sheet.applyLayout(tab, RFQ_TABLE);

  const idCol = columnLetter(MESSAGE_ID_COL);
  const ids = (await sheet.getValues(tab.title, `${idCol}2:${idCol}`)).map((r) => r[0]);
  if (ids.includes(email.messageId)) return false;

  const row = toRfqRow(email, rfq);
  await sheet.appendValues(tab.title, [row]);
  await sheet.fitColumns(tab, RFQ_TABLE);
  return true;
}

/**
 * Sets an RFQ row's status, but only when its current status is one of `from` (default: "New"), so
 * a status the team set by hand, or a final Won/Lost, is never overwritten. Optionally appends a
 * dated line to the History column. Does nothing if the row is missing.
 */
export async function setRfqStatus(
  config: SheetConfig,
  messageId: string,
  status: string,
  options: { from?: string[]; history?: string } = {},
): Promise<void> {
  const sheet = await SheetClient.connect(config);
  const idCol = columnLetter(MESSAGE_ID_COL);
  const ids = (await sheet.getValues(config.tab, `${idCol}1:${idCol}`)).map((r) => r[0]);
  const rowIndex = ids.indexOf(messageId);
  if (rowIndex < 1) return;
  const row = rowIndex + 1;

  const statusCell = `${columnLetter(RFQ_HEADER.indexOf("Status"))}${row}`;
  const current = (await sheet.getValues(config.tab, statusCell))[0]?.[0] ?? "";
  if (!current || (options.from ?? ["New"]).includes(current)) await sheet.putValues(config.tab, statusCell, [[status]]);

  if (options.history) {
    const historyCell = `${columnLetter(RFQ_HEADER.indexOf("History"))}${row}`;
    const existing = (await sheet.getValues(config.tab, historyCell))[0]?.[0] ?? "";
    const line = `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)}: ${options.history}`;
    const history = existing && existing !== "Not stated" ? `${existing}\n${line}` : line;
    await sheet.putValues(config.tab, historyCell, [[history]]);
    await sheet.fitColumns(await sheet.ensureTab(config.tab), RFQ_TABLE);
  }
}

/** Current Status of every RFQ row, by Message-ID. */
export async function rfqStatuses(config: SheetConfig): Promise<Map<string, string>> {
  const sheet = await SheetClient.connect(config);
  const idCol = columnLetter(MESSAGE_ID_COL);
  const statusCol = columnLetter(RFQ_HEADER.indexOf("Status"));
  const ids = (await sheet.getValues(config.tab, `${idCol}2:${idCol}`)).map((r) => r[0]);
  const statuses = (await sheet.getValues(config.tab, `${statusCol}2:${statusCol}`)).map((r) => r[0] ?? "");
  return new Map(ids.map((id, i) => [id, statuses[i] ?? ""] as [string, string]).filter(([id]) => Boolean(id)));
}
/** All RFQ Message-IDs in the RFQs tab (used to recognise replies to known RFQs). */
export async function knownRfqIds(config: SheetConfig): Promise<string[]> {
  const sheet = await SheetClient.connect(config);
  const idCol = columnLetter(MESSAGE_ID_COL);
  return (await sheet.getValues(config.tab, `${idCol}2:${idCol}`)).map((r) => r[0]).filter(Boolean);
}

/**
 * Re-applies the table layout to an existing tab. With removeTestRows, first deletes rows whose
 * Subject contains "TEST-RFQ". Refuses to relabel columns if real rows use a different layout.
 */
export async function formatRfqSheet(config: SheetConfig, removeTestRows: boolean): Promise<{ removed: number; remaining: number }> {
  const sheet = await SheetClient.connect(config);
  let tab = await sheet.ensureTab(config.tab);

  const values = await sheet.getValues(tab.title, "A:ZZ");
  const currentHeader = values[0] ?? [];
  let removed = 0;

  if (removeTestRows && values.length > 1) {
    const subjectCol = currentHeader.indexOf("Subject");
    if (subjectCol === -1) throw new Error('No "Subject" column found, so test rows cannot be identified');
    const testRows = values
      .map((row, index) => ({ index, subject: row[subjectCol] ?? "" }))
      .filter((r) => r.index > 0 && r.subject.includes("TEST-RFQ"))
      .map((r) => r.index);
    // Delete bottom-up so earlier row indexes stay valid.
    await sheet.batchUpdate(
      testRows.reverse().map((index) => ({
        deleteDimension: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: index, endIndex: index + 1 } },
      })),
    );
    removed = testRows.length;
  }

  const remaining = Math.max(0, values.length - 1 - removed);
  // Same layout, or the current one plus new columns at the end (existing rows stay aligned).
  const sameLayout = currentHeader.length === 0 || currentHeader.every((h, i) => RFQ_HEADER[i] === h);
  if (remaining > 0 && !sameLayout) {
    throw new Error(`${remaining} existing row(s) use an older column layout; move them before re-formatting`);
  }

  // Old headers may be longer than the new one; clear any leftovers in row 1.
  if (currentHeader.length > RFQ_HEADER.length) {
    await sheet.clearValues(tab.title, `${columnLetter(RFQ_HEADER.length)}1:${columnLetter(currentHeader.length - 1)}1`);
  }

  tab = await sheet.ensureTab(config.tab);
  await sheet.applyLayout(tab, RFQ_TABLE);
  return { removed, remaining };
}
