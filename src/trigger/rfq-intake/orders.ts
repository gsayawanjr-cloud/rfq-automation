import { deductStock, peekStock, readInventory } from "./inventory.js";
import { CURRENCY } from "./settings.js";
import type { Quotation } from "./quote.js";
import { columnLetter, OPEN_STATUSES, setRfqStatus, SheetClient, type Cell, type SheetAccess, type SheetConfig, type TableSpec } from "./sheet.js";

export type OrderLine = {
  quoteLineNo: number;
  sku: string;
  partNumber: string;
  description: string;
  maker: string;
  quality: string;
  unit: string;
  qty: number;
  unitPrice: number;
  amount: number;
  stockBefore: number;
  backorder: number;
  leadTimeDays: number;
  delivery: string;
};

export type Order = {
  number: string;
  date: string;
  quoteNumber: string;
  customerPo: string;
  vessel: string;
  customer: string;
  port: string;
  eta: string;
  rfqMessageId: string;
  lines: OrderLine[];
  total: number;
  /** Waiting for a person's approval in the Orders tab; stock has not been changed yet. */
  pending: boolean;
};

export const ORDERS_TABLE: TableSpec = {
  columns: [
    { header: "Order No.", width: 120 },
    { header: "Date", width: 95, align: "CENTER" },
    { header: "Quote No.", width: 140 },
    { header: "Customer PO", width: 130 },
    { header: "Vessel", width: 150 },
    { header: "Customer", width: 190 },
    { header: "Quote line", width: 60, align: "CENTER" },
    { header: "SKU", width: 130 },
    { header: "Part No.", width: 120 },
    { header: "Description", width: 240 },
    { header: "Quality", width: 110, align: "CENTER" },
    { header: "Qty", width: 55, align: "CENTER" },
    { header: "Unit", width: 55, align: "CENTER" },
    { header: `Unit price (${CURRENCY})`, width: 105, align: "RIGHT", numberFormat: "#,##0.00" },
    { header: `Amount (${CURRENCY})`, width: 105, align: "RIGHT", numberFormat: "#,##0.00" },
    { header: "Stock before", width: 80, align: "CENTER", numberFormat: "0" },
    { header: "Stock after", width: 80, align: "CENTER", numberFormat: "0" },
    { header: "Backorder", width: 80, align: "CENTER", numberFormat: "0" },
    { header: "Delivery", width: 190 },
    { header: "RFQ Message-ID", width: 160, muted: true },
    // Added later, so they sit at the end: older Orders tabs gain them without moving any column.
    { header: "Approval", width: 100, align: "CENTER" },
    { header: "Decision on", width: 130, align: "CENTER" },
  ],
  frozenColumns: 2,
  pills: [
    { column: "Backorder", condition: "NUMBER_EQ", value: "0", bg: "#D9EAD3", fg: "#274E13" },
    { column: "Approval", condition: "TEXT_EQ", value: "Pending", bg: "#FFE599", fg: "#7F6000" },
    { column: "Approval", condition: "TEXT_EQ", value: "Approved", bg: "#D9EAD3", fg: "#274E13" },
    { column: "Approval", condition: "TEXT_EQ", value: "Rejected", bg: "#F4CCCC", fg: "#990000" },
  ],
  // A person sets Approved or Rejected here; the agent then deducts stock (see applyOrderDecisions).
  dropdowns: [{ column: "Approval", options: ["Pending", "Approved", "Rejected"] }],
};

const col = (index: number) => columnLetter(index);

function delivery(stockBefore: number, qty: number, leadTimeDays: number): string {
  const lead = leadTimeDays > 0 ? `${leadTimeDays} days` : "lead time to be confirmed";
  if (stockBefore >= qty) return "Ready ex stock";
  if (stockBefore > 0) return `${stockBefore} ready ex stock, balance ${qty - stockBefore} in ${lead}`;
  return leadTimeDays > 0 ? `Not in stock, ${lead} lead time` : "Not in stock, lead time to be confirmed";
}

export function orderNumber(quoteBaseNumber: string): string {
  return quoteBaseNumber.replace(/^Q-/, "SO-");
}

/**
 * Records a confirmed order and takes it out of stock — exactly once per order number. If the
 * order is already in the Orders tab (e.g. the confirmation email is processed again), stock is
 * left alone and the recorded order is returned.
 */
export async function placeOrder(
  access: SheetAccess,
  tabs: { inventory: string; orders: string },
  quotation: Quotation,
  baseNumber: string,
  customerPo: string,
  confirmed: { lineNo: number; sku: string; qty: number }[],
  /** True: record the order as Pending and leave stock alone until a person approves it. */
  needsApproval = false,
): Promise<{ order: Order; alreadyRecorded: boolean }> {
  const sheet = await SheetClient.connect(access);
  let tab = await sheet.ensureTab(tabs.orders);
  const header = (await sheet.getValues(tabs.orders, "A1:1"))[0] ?? [];
  if (header.length === 0) {
    await sheet.applyLayout(tab, ORDERS_TABLE);
    tab = await sheet.ensureTab(tabs.orders);
  }

  const number = orderNumber(baseNumber);
  const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const base = {
    number,
    date,
    quoteNumber: quotation.number,
    customerPo,
    vessel: quotation.vessel,
    customer: quotation.customer,
    port: quotation.port,
    eta: quotation.eta,
    rfqMessageId: quotation.messageId,
  };

  // Already recorded? Rebuild it from the Orders tab instead of deducting stock again.
  const existing = (await sheet.getRawValues(tabs.orders, "A2:V")).filter((r) => r[0] === number);
  if (existing.length > 0) {
    const lines: OrderLine[] = existing.map((r) => ({
      quoteLineNo: Number(r[6]),
      sku: String(r[7]),
      partNumber: String(r[8]),
      description: String(r[9]),
      maker: "",
      quality: String(r[10]),
      qty: Number(r[11]),
      unit: String(r[12]),
      unitPrice: Number(r[13]),
      amount: Number(r[14]),
      stockBefore: Number(r[15]),
      backorder: Number(r[17]),
      leadTimeDays: 0,
      delivery: String(r[18]),
    }));
    const pending = String(existing[0][20] ?? "").toLowerCase() === "pending";
    return { order: { ...base, quoteNumber: String(existing[0][2]), customerPo: String(existing[0][3]), lines, total: sum(lines), pending }, alreadyRecorded: true };
  }

  // Prices come from the quotation the customer accepted, not from today's inventory.
  const offers = quotation.lines.flatMap((l) => l.offers.map((o) => ({ lineNo: l.no, ...o })));
  const priced = confirmed.map((c) => {
    const offer = offers.find((o) => o.lineNo === c.lineNo && o.item.sku === c.sku) ?? offers.find((o) => o.item.sku === c.sku);
    if (!offer) throw new Error(`Confirmed SKU ${c.sku} (line ${c.lineNo}) is not in quotation ${quotation.number}`);
    return { c, offer };
  });

  // Waiting for approval: only look at the stock (for the delivery wording); a person's approval deducts it.
  const stockLines = priced.map(({ c }) => ({ sku: c.sku, qty: c.qty }));
  const stock = needsApproval ? await peekStock(access, tabs.inventory, stockLines) : await deductStock(access, tabs.inventory, stockLines);
  const lines: OrderLine[] = priced.map(({ c, offer }, i) => ({
    quoteLineNo: c.lineNo,
    sku: offer.item.sku,
    partNumber: offer.item.partNumber,
    description: offer.item.description,
    maker: offer.item.maker,
    quality: offer.item.quality,
    unit: offer.item.unit,
    qty: c.qty,
    unitPrice: offer.item.unitPrice,
    amount: Math.round(offer.item.unitPrice * c.qty * 100) / 100,
    stockBefore: stock[i].before,
    backorder: stock[i].backorder,
    leadTimeDays: offer.item.leadTimeDays,
    delivery: delivery(stock[i].before, c.qty, offer.item.leadTimeDays),
  }));

  const rows: Cell[][] = lines.map((l, i) => [
    number,
    date,
    quotation.number,
    customerPo || "Not stated",
    quotation.vessel || "Not stated",
    quotation.customer,
    l.quoteLineNo,
    l.sku,
    l.partNumber,
    l.description,
    l.quality,
    l.qty,
    l.unit,
    l.unitPrice,
    l.amount,
    stock[i].before,
    needsApproval ? "" : stock[i].after,
    l.backorder,
    l.delivery,
    quotation.messageId,
    needsApproval ? "Pending" : "Approved",
    needsApproval ? "" : new Date().toISOString(),
  ]);
  await sheet.appendValues(tabs.orders, rows);
  await sheet.fitColumns(tab, ORDERS_TABLE);
  return { order: { ...base, lines, total: sum(lines), pending: needsApproval }, alreadyRecorded: false };
}

export type OrderDecisionResult = {
  approved: { order: string; backorders: string[] }[];
  rejected: { order: string }[];
  failed: { order: string; reason: string }[];
};

/**
 * Applies the decisions a person made in the Orders tab. Approved: stock is deducted once and the
 * order's stock/backorder/delivery cells are filled. Rejected: nothing changes in stock. Either way
 * "Decision on" is stamped, which is what makes this safe to run every minute. Orders with no
 * Approval value (placed before approvals existed) are ignored.
 */
export async function applyOrderDecisions(config: SheetConfig, tabs: { inventory: string; orders: string }): Promise<OrderDecisionResult> {
  const result: OrderDecisionResult = { approved: [], rejected: [], failed: [] };
  const sheet = await SheetClient.connect(config);
  let values: Cell[][];
  try {
    values = await sheet.getRawValues(tabs.orders, "A1:Z");
  } catch {
    return result; // no Orders tab yet
  }
  const header = (values[0] ?? []).map(String);
  const at = (name: string) => header.indexOf(name);
  const [numberCol, skuCol, qtyCol, beforeCol, afterCol, backCol, deliveryCol, rfqCol, approvalCol, decisionCol] = [
    "Order No.", "SKU", "Qty", "Stock before", "Stock after", "Backorder", "Delivery", "RFQ Message-ID", "Approval", "Decision on",
  ].map(at);
  if ([numberCol, skuCol, qtyCol, approvalCol, decisionCol].includes(-1)) return result;

  // Rows (1-based sheet rows) of each order with a decision that has not been applied yet.
  const byOrder = new Map<string, { decision: "Approved" | "Rejected"; rows: number[] }>();
  values.forEach((row, i) => {
    if (i === 0) return;
    const decision = String(row[approvalCol] ?? "").trim().toLowerCase();
    if (decision !== "approved" && decision !== "rejected") return;
    const stamp = String(row[decisionCol] ?? "").trim();
    // A "processing" stamp older than 10 minutes means an earlier run died mid-way: report, never redo.
    if (stamp.startsWith("processing") && Date.now() - Date.parse(stamp.replace("processing ", "")) > 600_000) {
      result.failed.push({ order: String(row[numberCol]), reason: "an earlier run stopped part-way; check the stock for this order by hand, then clear or fill Decision on" });
      return;
    }
    if (stamp !== "") return;
    const number = String(row[numberCol]);
    const entry = byOrder.get(number) ?? { decision: decision === "approved" ? "Approved" : "Rejected", rows: [] };
    entry.rows.push(i);
    byOrder.set(number, entry);
  });
  if (byOrder.size === 0) return result;

  const catalog = await readInventory(config, tabs.inventory);
  const now = new Date().toISOString();
  for (const [order, { decision, rows }] of byOrder) {
    const rfqId = String(values[rows[0]][rfqCol] ?? "");
    try {
      if (decision === "Rejected") {
        for (const i of rows) await sheet.putValues(tabs.orders, `${col(decisionCol)}${i + 1}`, [[now]]);
        result.rejected.push({ order });
        if (rfqId) await setRfqStatus(config, rfqId, "Needs attention", { from: OPEN_STATUSES, history: `Order ${order} was rejected; stock not changed` });
        continue;
      }
      const lines = rows.map((i) => ({ sku: String(values[i][skuCol]), qty: Number(values[i][qtyCol]) || 0 }));
      // Claim the order first. If this run dies before finishing, the "processing" stamp stays visible and
      // the order is never deducted a second time (a person checks it), which is safer than a double deduction.
      for (const i of rows) await sheet.putValues(tabs.orders, `${col(decisionCol)}${i + 1}`, [[`processing ${now}`]]);
      const stock = await deductStock(config, tabs.inventory, lines);
      for (const [n, i] of rows.entries()) {
        const lead = catalog.find((c) => c.sku === lines[n].sku)?.leadTimeDays ?? 0;
        await sheet.putValues(tabs.orders, `${col(beforeCol)}${i + 1}`, [
          [stock[n].before, stock[n].after, stock[n].backorder, delivery(stock[n].before, lines[n].qty, lead)],
        ]);
        await sheet.putValues(tabs.orders, `${col(decisionCol)}${i + 1}`, [[now]]);
      }
      const backorders = stock.map((s, n) => (s.backorder > 0 ? `${lines[n].sku} ×${s.backorder}` : "")).filter(Boolean);
      result.approved.push({ order, backorders });
      if (rfqId) {
        await setRfqStatus(config, rfqId, "Won", {
          from: OPEN_STATUSES,
          history: `Order ${order} approved; stock deducted${backorders.length ? `; backorder ${backorders.join(", ")}` : ""}`,
        });
      }
    } catch (error) {
      result.failed.push({ order, reason: (error as Error).message });
    }
  }
  await sheet.fitColumns(await sheet.ensureTab(tabs.orders), ORDERS_TABLE);
  return result;
}

function sum(lines: OrderLine[]): number {
  return Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
}

// ─── Order acknowledgment email ─────────────────────────────────────────────────────────────

/** The email body; the ordered items and total are in the attached PDF (renderOrderAckPdf). */
export function renderOrderAck(
  order: Order,
  texts: { greeting: string; message: string; closing: string; openPoints: string[] },
  signature: string,
): { text: string } {
  const text = [
    texts.greeting,
    "",
    texts.message,
    "",
    `Our order acknowledgment ${order.number} is attached.`,
    "",
    ...(texts.openPoints.length > 0 ? ["To arrange delivery, please send:", ...texts.openPoints.map((p, i) => `${i + 1}. ${p}`), ""] : []),
    texts.closing,
    "",
    signature,
  ].join("\n");
  return { text };
}

/** Is there an Approved or Rejected order whose decision has not been applied yet? A cheap read, no changes. */
export async function hasPendingDecisions(config: SheetConfig, ordersTab: string): Promise<boolean> {
  const sheet = await SheetClient.connect(config);
  let values: Cell[][];
  try {
    values = await sheet.getRawValues(ordersTab, "A1:Z");
  } catch {
    return false;
  }
  const header = (values[0] ?? []).map(String);
  const approvalCol = header.indexOf("Approval");
  const decisionCol = header.indexOf("Decision on");
  if (approvalCol === -1 || decisionCol === -1) return false;
  return values.slice(1).some((r) => ["approved", "rejected"].includes(String(r[approvalCol] ?? "").trim().toLowerCase()) && String(r[decisionCol] ?? "").trim() === "");
}