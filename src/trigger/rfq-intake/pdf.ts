import { logger } from "@trigger.dev/sdk";
import PDFDocument from "pdfkit";
import { alertRunFailure } from "./alerts.js";
import { confirmationInstruction, lineStatusText, type Confirmation } from "./confirm.js";
import { longDate, unitLabel } from "./dates.js";
import type { ReplyContent } from "./mail.js";
import type { Order } from "./orders.js";
import { manilaDate, type Quotation, type QuoteLine } from "./quote.js";
import { CURRENCY, fetchLogo, quoteTerms, settings } from "./settings.js";

// A4 portrait, in points. Built-in Helvetica covers the characters we print (·, °, µ, –, ×, Ø).
const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - PAGE.margin - 28; // leave room for the footer

const NAVY = "#1F3864";
const GREEN = "#274E13";
const BAND = "#F3F6FB";
const RULE = "#E3E8F0";
const GREY = "#5F6B7A";
const ORANGE = "#B45F06";
const TEXT = "#1F1F1F";
const QUALITY_COLORS: Record<string, [string, string]> = {
  "Genuine OEM": ["#D9EAD3", "#274E13"],
  "OEM-licensed": ["#CFE2F3", "#1C4587"],
  Aftermarket: ["#FFF2CC", "#7F6000"],
};

type Col = { x: number; w: number };
type Align = "left" | "right" | "center";

// Quotation and order tables: x offset and width within the content area.
// Availability is wide enough for "In stock, Manila WH-A" on one line.
const COLS = {
  item: { x: 0, w: 235 },
  qty: { x: 235, w: 40 },
  price: { x: 275, w: 65 },
  amount: { x: 340, w: 70 },
  avail: { x: 410, w: CONTENT_WIDTH - 410 },
};
// Confirmation table (no prices).
const CF_COLS = {
  no: { x: 0, w: 24 },
  asked: { x: 24, w: 150 },
  matched: { x: 174, w: 226 },
  status: { x: 400, w: CONTENT_WIDTH - 400 },
};
const PAD = 5;

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_TEXT: Record<QuoteLine["status"], string> = {
  quoted: "",
  choose: "Please choose one option",
  not_stocked: "Not available from stock",
  needs_info: "More information needed to quote",
};

// ─── Shared layout ──────────────────────────────────────────────────────────────────────────

/** One A4 document being drawn top to bottom; `y` is where the next thing goes. */
class Layout {
  readonly doc: PDFKit.PDFDocument;
  readonly done: Promise<Buffer>;
  readonly L = PAGE.margin;
  y = PAGE.margin;

  constructor(info: { title: string; author: string; subject: string }) {
    this.doc = new PDFDocument({
      size: "A4",
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      bufferPages: true, // so page numbers ("Page 1 of 3") can be added at the end
      info: { Title: info.title, Author: info.author, Subject: info.subject },
    });
    const chunks: Buffer[] = [];
    this.doc.on("data", (c: Buffer) => chunks.push(c));
    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on("end", () => resolve(Buffer.concat(chunks)));
      this.doc.on("error", reject);
    });
  }

  textHeight(text: string, width: number, font: string, size: number): number {
    this.doc.font(font).fontSize(size);
    return this.doc.heightOfString(text, { width });
  }

  write(text: string, x: number, top: number, width: number, font = "Helvetica", size = 9, color = TEXT, align: Align = "left") {
    this.doc.font(font).fontSize(size).fillColor(color).text(text, x, top, { width, align, lineGap: 1 });
  }

  /** Starts a new page when `needed` points don't fit; `onNewPage` redraws a table header there. */
  ensure(needed: number, onNewPage?: () => void) {
    if (this.y + needed <= BOTTOM) return;
    this.doc.addPage();
    this.y = PAGE.margin;
    onNewPage?.();
  }

  rule(width = 0.5, color = RULE) {
    this.doc.moveTo(this.L, this.y).lineTo(this.L + CONTENT_WIDTH, this.y).lineWidth(width).strokeColor(color).stroke();
  }

  /** Logo on the left, company details on the right (only what is set). */
  async letterhead() {
    const c = settings().company;
    const logo = await fetchLogo(c.logoUrl);
    const details = [c.address, [c.phone, c.email].filter(Boolean).join(" · "), c.website, c.taxId ? `Tax ID ${c.taxId}` : ""].filter(Boolean);
    if (!logo && details.length === 0) return;
    const detailsText = details.join("\n");
    const detailsW = 240;
    const logoMax = { w: 150, h: 42 };
    if (logo) this.doc.image(logo, this.L, this.y, { fit: [logoMax.w, logoMax.h] });
    if (details.length > 0) this.write(detailsText, this.L + CONTENT_WIDTH - detailsW, this.y, detailsW, "Helvetica", 8, GREY, "right");
    this.y += Math.max(logo ? logoMax.h : 0, details.length > 0 ? this.textHeight(detailsText, detailsW, "Helvetica", 8) : 0) + 10;
  }

  titleBand(title: string, company: string, color: string) {
    this.doc.rect(this.L, this.y, CONTENT_WIDTH, 44).fill(color);
    this.write(title, this.L + 14, this.y + 13, 300, "Helvetica-Bold", 18, "#FFFFFF");
    this.write(company, this.L + CONTENT_WIDTH - 214, this.y + 17, 200, "Helvetica-Bold", 11, "#FFFFFF", "right");
    this.y += 44;
  }

  /** Two columns of "Label: value" on a light band. */
  details(left: [string, string][], right: [string, string][]) {
    const colW = CONTENT_WIDTH / 2 - 14;
    const blockLines = (pairs: [string, string][]) => pairs.reduce((h, [k, v]) => h + this.textHeight(`${k}: ${v}`, colW, "Helvetica", 9) + 3, 0);
    const blockH = Math.max(blockLines(left), blockLines(right)) + 16;
    this.doc.rect(this.L, this.y, CONTENT_WIDTH, blockH).fill(BAND);
    const drawPairs = (pairs: [string, string][], x: number) => {
      let yy = this.y + 8;
      for (const [k, v] of pairs) {
        this.doc.font("Helvetica-Bold").fontSize(9).fillColor(TEXT).text(`${k}: `, x, yy, { width: colW, continued: true, lineGap: 1 });
        this.doc.font("Helvetica").text(v, { lineGap: 1 });
        yy = this.doc.y + 3;
      }
    };
    drawPairs(left, this.L + 10);
    drawPairs(right, this.L + CONTENT_WIDTH / 2 + 4);
    this.y += blockH + 14;
  }

  /** Navy header row of a table. */
  tableHeader(cols: [string, Col, Align][]) {
    const h = Math.max(...cols.map(([t, c]) => this.textHeight(t, c.w - PAD * 2, "Helvetica-Bold", 8))) + 12;
    this.doc.rect(this.L, this.y, CONTENT_WIDTH, h).fill(NAVY);
    for (const [t, c, align] of cols) this.write(t, this.L + c.x + PAD, this.y + 6, c.w - PAD * 2, "Helvetica-Bold", 8, "#FFFFFF", align);
    this.y += h;
  }

  numberedList(title: string, items: string[]) {
    if (items.length === 0) return;
    this.ensure(40);
    this.write(title, this.L, this.y, CONTENT_WIDTH, "Helvetica-Bold", 10);
    this.y = this.doc.y + 4;
    items.forEach((item, i) => {
      const h = this.textHeight(item, CONTENT_WIDTH - 16, "Helvetica", 9.5) + 3;
      this.ensure(h);
      this.write(`${i + 1}.`, this.L, this.y, 14, "Helvetica", 9.5);
      this.write(item, this.L + 16, this.y, CONTENT_WIDTH - 16, "Helvetica", 9.5);
      this.y = this.doc.y + 3;
    });
    this.y += 10;
  }

  /** "Total" line under the amount column. */
  total(label: string, amount: number) {
    this.ensure(30);
    this.y += 6;
    this.doc.moveTo(this.L + COLS.amount.x, this.y).lineTo(this.L + COLS.amount.x + COLS.amount.w, this.y).lineWidth(1.5).strokeColor(NAVY).stroke();
    this.write(label, this.L, this.y + 6, COLS.amount.x - PAD, "Helvetica-Bold", 10, TEXT, "right");
    this.write(`${CURRENCY} ${money(amount)}`, this.L + COLS.amount.x, this.y + 6, COLS.amount.w + 40, "Helvetica-Bold", 10, TEXT, "left");
    this.y += 30;
  }

  signOff(closing: string, preparedBy: string) {
    this.ensure(this.textHeight(`${closing}\n\n${preparedBy}`, CONTENT_WIDTH, "Helvetica", 10) + 20);
    if (closing) {
      this.write(closing, this.L, this.y, CONTENT_WIDTH, "Helvetica", 10);
      this.y = this.doc.y + 10;
    }
    this.write(preparedBy, this.L, this.y, CONTENT_WIDTH, "Helvetica", 10);
  }

  /** Footer on every page, then the finished file. */
  finish(label: string): Promise<Buffer> {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const fy = PAGE.height - PAGE.margin - 12;
      this.doc.moveTo(this.L, fy - 6).lineTo(this.L + CONTENT_WIDTH, fy - 6).lineWidth(0.5).strokeColor(RULE).stroke();
      // Writing below the bottom margin would make pdfkit add a page; lift the margin while drawing it.
      const bottomMargin = this.doc.page.margins.bottom;
      this.doc.page.margins.bottom = 0;
      this.write(label, this.L, fy, CONTENT_WIDTH / 2, "Helvetica", 7.5, GREY);
      this.write(`Page ${i - range.start + 1} of ${range.count}`, this.L + CONTENT_WIDTH / 2, fy, CONTENT_WIDTH / 2, "Helvetica", 7.5, GREY, "right");
      this.doc.page.margins.bottom = bottomMargin;
    }
    this.doc.end();
    return this.done;
  }
}

function qualityBadge(p: Layout, quality: string, x: number, y: number) {
  const [bg, fg] = QUALITY_COLORS[quality] ?? ["#EEEEEE", "#333333"];
  p.doc.font("Helvetica-Bold").fontSize(7);
  const badgeW = p.doc.widthOfString(quality) + 10;
  p.doc.roundedRect(x, y, badgeW, 10, 4).fill(bg);
  p.write(quality, x + 5, y + 2, badgeW, "Helvetica-Bold", 7, fg);
}

const vesselText = (vessel: string, imo = "") => [vessel, imo ? `IMO ${imo}` : ""].filter(Boolean).join(" · ") || "Not stated";

// ─── Quotation ──────────────────────────────────────────────────────────────────────────────

/** Renders the quotation as a formal A4 PDF. */
export async function renderQuotationPdf(q: Quotation, company: string, preparedBy: string): Promise<Buffer> {
  const s = settings();
  const p = new Layout({ title: `Quotation ${q.number}`, author: company, subject: q.subject });
  const L = p.L;

  await p.letterhead();
  p.titleBand("QUOTATION", company, NAVY);
  p.details(
    [
      ["Quotation no.", q.number],
      ["Date", longDate(q.date)],
      ["Valid until", longDate(q.validUntil)],
    ],
    [
      ["Customer", q.customer],
      ["Vessel", vesselText(q.vessel, q.imo)],
      ["Delivery", [q.port, q.eta ? `ETA ${longDate(q.eta)}` : "", q.requiredBy ? `required by ${longDate(q.requiredBy)}` : ""].filter(Boolean).join(" · ") || "Not stated"],
      ["Your reference", q.subject],
    ],
  );

  // ── Intro ──
  p.write(q.greeting, L, p.y, CONTENT_WIDTH, "Helvetica", 10);
  p.y = p.doc.y + 4;
  p.write(q.intro, L, p.y, CONTENT_WIDTH, "Helvetica", 10);
  p.y = p.doc.y + 12;

  // ── Table ──
  const header = () =>
    p.tableHeader([
      ["Item / our offer", COLS.item, "left"],
      ["Qty", COLS.qty, "center"],
      [`Unit price (${CURRENCY})`, COLS.price, "right"],
      [`Amount (${CURRENCY})`, COLS.amount, "right"],
      ["Availability", COLS.avail, "left"],
    ]);
  header();

  const offerHeight = (o: QuoteLine["offers"][number]) => {
    const w = COLS.item.w - PAD * 2;
    const itemH =
      p.textHeight(o.label, w, "Helvetica", 7) +
      p.textHeight(o.item.description, w, "Helvetica-Bold", 9) +
      p.textHeight(`${o.item.maker} · P/N ${o.item.partNumber}`, w, "Helvetica", 8) +
      13 + // quality badge
      p.textHeight(o.item.specifications, w, "Helvetica", 7.5);
    const availH = p.textHeight(o.availability, COLS.avail.w - PAD * 2, "Helvetica", 8.5);
    return Math.max(itemH, availH, o.inTotal || o.amount === null ? 12 : 22) + 12;
  };

  for (const line of q.lines) {
    // Line heading (what the customer asked for).
    const heading = `${line.no}. ${line.requested}${line.status !== "quoted" ? `  — ${STATUS_TEXT[line.status]}` : ""}`;
    const headH = p.textHeight(heading, CONTENT_WIDTH - PAD * 2, "Helvetica-Bold", 9) + 10;
    // Keep the heading on the same page as its first offer, so it never sits alone at the bottom.
    p.ensure(headH + (line.offers[0] ? offerHeight(line.offers[0]) : 20), header);
    p.doc.rect(L, p.y, CONTENT_WIDTH, headH).fill(BAND);
    p.write(heading, L + PAD, p.y + 5, CONTENT_WIDTH - PAD * 2, "Helvetica-Bold", 9, line.status === "quoted" ? TEXT : ORANGE);
    p.y += headH;

    for (const o of line.offers) {
      const w = COLS.item.w - PAD * 2;
      const rowH = offerHeight(o);
      p.ensure(rowH, header);

      let yy = p.y + 6;
      const x = L + COLS.item.x + PAD;
      p.write(o.label, x, yy, w, "Helvetica", 7, GREY);
      yy = p.doc.y;
      p.write(o.item.description, x, yy, w, "Helvetica-Bold", 9);
      yy = p.doc.y;
      p.write(`${o.item.maker} · P/N ${o.item.partNumber}`, x, yy, w, "Helvetica", 8);
      yy = p.doc.y + 2;
      qualityBadge(p, o.item.quality, x, yy);
      yy += 13;
      p.write(o.item.specifications, x, yy, w, "Helvetica", 7.5, GREY);

      const cell = (t: string, c: Col, align: Align, font = "Helvetica", color = TEXT) => p.write(t, L + c.x + PAD, p.y + 6, c.w - PAD * 2, font, 8.5, color, align);
      cell(`${o.qty ?? "?"} ${unitLabel(o.item.unit, o.qty)}`, COLS.qty, "center");
      cell(money(o.item.unitPrice), COLS.price, "right");
      if (o.amount === null) cell("qty to confirm", COLS.amount, "right", "Helvetica", GREY);
      else if (o.inTotal) cell(money(o.amount), COLS.amount, "right", "Helvetica-Bold");
      else {
        cell(money(o.amount), COLS.amount, "right", "Helvetica", GREY);
        p.write("not in total", L + COLS.amount.x + PAD, p.y + 18, COLS.amount.w - PAD * 2, "Helvetica", 7, GREY, "right");
      }
      cell(o.availability, COLS.avail, "left");

      p.y += rowH;
      p.rule();
    }

    if (line.note) {
      const noteText = `Note: ${line.note}`;
      const noteH = p.textHeight(noteText, CONTENT_WIDTH - PAD * 2, "Helvetica-Oblique", 8) + 10;
      p.ensure(noteH, header);
      p.write(noteText, L + PAD, p.y + 5, CONTENT_WIDTH - PAD * 2, "Helvetica-Oblique", 8, GREY);
      p.y += noteH;
      p.rule();
    }
  }

  p.total("TOTAL", q.subtotal);
  p.numberedList("To finalize the quotation, please confirm:", q.questions);

  // ── Terms and sign-off ──
  // Payment details (when the company has set them) come before the terms.
  if (s.bankLines.length > 0) {
    const bank = s.bankLines.join("\n");
    p.ensure(p.textHeight(bank, CONTENT_WIDTH, "Helvetica", 8) + 30);
    p.write("Payment details", L, p.y, CONTENT_WIDTH, "Helvetica-Bold", 9);
    p.y = p.doc.y + 3;
    p.write(bank, L, p.y, CONTENT_WIDTH, "Helvetica", 8, GREY);
    p.y = p.doc.y + 12;
  }
  const terms = quoteTerms(s).map((t) => `• ${t}`).join("\n");
  p.ensure(p.textHeight(terms, CONTENT_WIDTH, "Helvetica", 8) + 70);
  p.write("Terms and conditions", L, p.y, CONTENT_WIDTH, "Helvetica-Bold", 9);
  p.y = p.doc.y + 3;
  p.write(terms, L, p.y, CONTENT_WIDTH, "Helvetica", 8, GREY);
  p.y = p.doc.y + 16;
  p.signOff(q.closing, preparedBy);

  return p.finish(`${company} · Quotation ${q.number}`);
}

// ─── Request confirmation (no prices) ───────────────────────────────────────────────────────

export async function renderConfirmationPdf(c: Confirmation, company: string, preparedBy: string): Promise<Buffer> {
  const p = new Layout({ title: `Request confirmation ${c.number}`, author: company, subject: c.subject });
  const L = p.L;

  await p.letterhead();
  p.titleBand("REQUEST CONFIRMATION", company, GREEN);
  p.details(
    [
      ["Confirmation no.", c.number],
      ["Date", longDate(manilaDate())],
    ],
    [
      ["Vessel", vesselText(c.vessel)],
      ["Your reference", c.subject],
    ],
  );

  const header = () =>
    p.tableHeader([
      ["#", CF_COLS.no, "center"],
      ["You asked for", CF_COLS.asked, "left"],
      ["What we matched", CF_COLS.matched, "left"],
      ["Status", CF_COLS.status, "left"],
    ]);
  header();

  const mw = CF_COLS.matched.w - PAD * 2;
  // Each piece of the "What we matched" cell: text, font, size, colour.
  const matchedParts = (l: Confirmation["lines"][number]): [string, string, number, string][] => {
    const parts: [string, string, number, string][] = [];
    if (l.offers.length === 0) parts.push([lineStatusText(l), "Helvetica", 8.5, ORANGE]);
    l.offers.forEach((o, i) => {
      if (l.status === "choose") parts.push([o.label, "Helvetica", 7, GREY]);
      parts.push([o.description, "Helvetica-Bold", 9, TEXT]);
      parts.push([`${o.maker} · P/N ${o.partNumber} · ${o.quality}`, "Helvetica", 8, TEXT]);
      if (o.specifications) parts.push([o.specifications, "Helvetica", 7.5, GREY]);
      if (i < l.offers.length - 1) parts.push([" ", "Helvetica", 4, TEXT]);
    });
    if (l.note) parts.push([`Note: ${l.note}`, "Helvetica-Oblique", 8, GREY]);
    return parts;
  };

  for (const l of c.lines) {
    const parts = matchedParts(l);
    const status = lineStatusText(l);
    const rowH =
      Math.max(
        p.textHeight(l.requested, CF_COLS.asked.w - PAD * 2, "Helvetica", 8.5),
        parts.reduce((h, [t, f, s]) => h + p.textHeight(t, mw, f, s) + 1, 0), // +1: the line gap write() adds
        p.textHeight(status, CF_COLS.status.w - PAD * 2, "Helvetica", 8.5),
      ) + 12;
    p.ensure(rowH, header);

    const cell = (t: string, col: Col, align: Align = "left", color = TEXT) => p.write(t, L + col.x + PAD, p.y + 6, col.w - PAD * 2, "Helvetica", 8.5, color, align);
    cell(String(l.no), CF_COLS.no, "center");
    cell(l.requested, CF_COLS.asked);
    let yy = p.y + 6;
    for (const [t, f, s, color] of parts) {
      p.write(t, L + CF_COLS.matched.x + PAD, yy, mw, f, s, color);
      yy = p.doc.y;
    }
    cell(status, CF_COLS.status, "left", l.status === "quoted" && l.verified ? TEXT : ORANGE);

    p.y += rowH;
    p.rule();
  }
  p.y += 14;

  p.numberedList("A few things we need from you:", c.questions);
  const instruction = confirmationInstruction(c);
  p.ensure(p.textHeight(instruction, CONTENT_WIDTH, "Helvetica-Bold", 10) + 16);
  p.write(instruction, L, p.y, CONTENT_WIDTH, "Helvetica-Bold", 10);
  p.y = p.doc.y + 16;
  p.signOff(c.closing, preparedBy);

  return p.finish(`${company} · Request confirmation ${c.number}`);
}

// ─── Order acknowledgment ───────────────────────────────────────────────────────────────────

export async function renderOrderAckPdf(order: Order, company: string, preparedBy: string): Promise<Buffer> {
  const p = new Layout({ title: `Order acknowledgment ${order.number}`, author: company, subject: order.quoteNumber });
  const L = p.L;

  await p.letterhead();
  p.titleBand("ORDER ACKNOWLEDGMENT", company, GREEN);
  p.details(
    [
      ["Order no.", order.number],
      ["Date", longDate(order.date)],
      ["Your PO", order.customerPo || "Not stated"],
    ],
    [
      ["Customer", order.customer],
      ["Quotation", order.quoteNumber],
      ["Vessel", vesselText(order.vessel)],
      ["Delivery", [order.port, order.eta ? `ETA ${longDate(order.eta)}` : ""].filter(Boolean).join(" · ") || "To be advised"],
    ],
  );

  const header = () =>
    p.tableHeader([
      ["Item", COLS.item, "left"],
      ["Qty", COLS.qty, "center"],
      [`Unit price (${CURRENCY})`, COLS.price, "right"],
      [`Amount (${CURRENCY})`, COLS.amount, "right"],
      ["Delivery", COLS.avail, "left"],
    ]);
  header();

  const w = COLS.item.w - PAD * 2;
  for (const l of order.lines) {
    const sub = [`P/N ${l.partNumber}`, l.maker, l.quality].filter(Boolean).join(" · ");
    const rowH =
      Math.max(
        p.textHeight(l.description, w, "Helvetica-Bold", 9) + p.textHeight(sub, w, "Helvetica", 8),
        p.textHeight(l.delivery, COLS.avail.w - PAD * 2, "Helvetica", 8.5),
      ) + 12;
    p.ensure(rowH, header);

    const x = L + COLS.item.x + PAD;
    p.write(l.description, x, p.y + 6, w, "Helvetica-Bold", 9);
    p.write(sub, x, p.doc.y, w, "Helvetica", 8, GREY);
    const cell = (t: string, c: Col, align: Align, font = "Helvetica") => p.write(t, L + c.x + PAD, p.y + 6, c.w - PAD * 2, font, 8.5, TEXT, align);
    cell(`${l.qty} ${unitLabel(l.unit, l.qty)}`, COLS.qty, "center");
    cell(money(l.unitPrice), COLS.price, "right");
    cell(money(l.amount), COLS.amount, "right", "Helvetica-Bold");
    cell(l.delivery, COLS.avail, "left");

    p.y += rowH;
    p.rule();
  }

  p.total("ORDER TOTAL", order.total);
  p.signOff("", preparedBy);

  return p.finish(`${company} · Order ${order.number}`);
}

// ─── File names and attaching ───────────────────────────────────────────────────────────────

const safe = (vessel: string) => vessel.replace(/[^\p{L}\p{N} .-]/gu, "").trim();
const fileName = (kind: string, number: string, vessel: string) => `${kind} ${number}${safe(vessel) ? ` ${safe(vessel)}` : ""}.pdf`;

/** File name like "Quotation Q-261015-B0D5 MV Bukidnon Star.pdf", safe for every mail client. */
export const quotationPdfName = (q: Quotation) => fileName("Quotation", q.number, q.vessel);
export const confirmationPdfName = (c: Confirmation) => fileName("Request Confirmation", c.number, c.vessel);
export const orderAckPdfName = (o: Order) => fileName("Order Acknowledgment", o.number, o.vessel);

/**
 * Attaches a generated PDF to a draft. The draft body only refers to the PDF, so if it can't be made
 * the owner is alerted to add it by hand; the draft is still saved.
 */
export async function withPdf(reply: ReplyContent, filename: string, make: () => Promise<Buffer>, context: { emailSubject?: string } = {}): Promise<ReplyContent> {
  try {
    const content = await make();
    return { ...reply, attachments: [...(reply.attachments ?? []), { filename, content, contentType: "application/pdf" }] };
  } catch (error) {
    logger.warn("PDF generation failed", { filename, message: (error as Error).message });
    await alertRunFailure(`PDF "${filename}" (draft saved without it)`, error, context);
    return reply;
  }
}
