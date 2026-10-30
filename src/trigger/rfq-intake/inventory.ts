import { MOCK_INVENTORY } from "./mock-inventory.js";
import { CURRENCY } from "./settings.js";
import { SheetClient, type Cell, type SheetAccess, type TableSpec } from "./sheet.js";

export type InventoryItem = {
  sku: string;
  partNumber: string;
  description: string;
  maker: string;
  fits: string;
  category: string;
  quality: "Genuine OEM" | "OEM-licensed" | "Aftermarket";
  specifications: string;
  unit: string;
  unitPrice: number;
  stock: number;
  location: string;
  leadTimeDays: number;
  weightKg: number;
  origin: string;
  notes: string;
};

// Column order is the sheet layout; `key` maps each column to an InventoryItem field.
export const INVENTORY_COLUMNS: (TableSpec["columns"][number] & { key: keyof InventoryItem })[] = [
  { key: "sku", header: "SKU", width: 130 },
  { key: "partNumber", header: "Part No.", width: 130 },
  { key: "description", header: "Description", width: 260 },
  { key: "maker", header: "Maker", width: 120 },
  { key: "fits", header: "Fits / Model", width: 200 },
  { key: "category", header: "Category", width: 170 },
  { key: "quality", header: "Quality", width: 110, align: "CENTER" },
  { key: "specifications", header: "Specifications", width: 340 },
  { key: "unit", header: "Unit", width: 60, align: "CENTER" },
  { key: "unitPrice", header: `Unit price (${CURRENCY})`, width: 110, align: "RIGHT", numberFormat: "#,##0.00" },
  { key: "stock", header: "In stock", width: 80, align: "CENTER", numberFormat: "0" },
  { key: "location", header: "Location", width: 120 },
  { key: "leadTimeDays", header: "Lead time if out of stock (days)", width: 150, align: "CENTER", numberFormat: "0" },
  { key: "weightKg", header: "Weight (kg)", width: 85, align: "RIGHT", numberFormat: "0.0#" },
  { key: "origin", header: "Origin", width: 100 },
  { key: "notes", header: "Notes", width: 240 },
];

export const INVENTORY_TABLE: TableSpec = {
  columns: INVENTORY_COLUMNS,
  frozenColumns: 3, // through Description
  pills: [
    { column: "In stock", condition: "NUMBER_EQ", value: "0", bg: "#F4CCCC", fg: "#990000" },
    { column: "Quality", condition: "TEXT_EQ", value: "Genuine OEM", bg: "#D9EAD3", fg: "#274E13" },
    { column: "Quality", condition: "TEXT_EQ", value: "OEM-licensed", bg: "#CFE2F3", fg: "#1C4587" },
    { column: "Quality", condition: "TEXT_EQ", value: "Aftermarket", bg: "#FFF2CC", fg: "#7F6000" },
  ],
  dropdowns: [{ column: "Quality", options: ["Genuine OEM", "OEM-licensed", "Aftermarket"] }],
};

function toRow(item: InventoryItem): Cell[] {
  // A lead time or weight of 0 means the client did not give one: leave the cell empty rather than show a made-up 0.
  return INVENTORY_COLUMNS.map((c) => ((c.key === "leadTimeDays" || c.key === "weightKg") && item[c.key] === 0 ? "" : item[c.key]));
}

/**
 * Writes the mock inventory into the tab and formats it. Refuses to overwrite a tab that already
 * has items unless `overwrite` is set, since the sheet becomes the source of truth after seeding.
 */
export async function seedInventory(access: SheetAccess, tabTitle: string, overwrite: boolean): Promise<{ items: number }> {
  const sheet = await SheetClient.connect(access);
  let tab = await sheet.ensureTab(tabTitle);
  const existing = await sheet.getValues(tabTitle, "A2:A");
  if (existing.length > 0 && !overwrite) {
    throw new Error(`The ${tabTitle} tab already has ${existing.length} items. Run with overwrite: true to replace them with the mock data.`);
  }
  await sheet.clearValues(tabTitle, "A:Z");
  tab = await writeInventoryRows(sheet, tabTitle, MOCK_INVENTORY);
  return { items: MOCK_INVENTORY.length };
}

/** Writes items under the header, applies the layout, and sizes the columns. The tab must be empty. */
export async function writeInventoryRows(sheet: SheetClient, tabTitle: string, items: InventoryItem[]) {
  await sheet.putValues(tabTitle, "A2", items.map(toRow));
  const tab = await sheet.ensureTab(tabTitle);
  await sheet.applyLayout(tab, INVENTORY_TABLE);
  return tab;
}

/**
 * Appends mock catalog items whose SKU isn't in the tab yet. Existing rows (edited prices, current
 * stock) are left alone, unlike seedInventory.
 */
export async function addMissingInventory(access: SheetAccess, tabTitle: string): Promise<{ added: string[] }> {
  const sheet = await SheetClient.connect(access);
  const have = new Set((await sheet.getValues(tabTitle, "A2:A")).map((r) => (r[0] ?? "").trim()));
  const missing = MOCK_INVENTORY.filter((i) => !have.has(i.sku));
  if (missing.length > 0) {
    await sheet.appendValues(tabTitle, missing.map(toRow));
    await sheet.fitColumns(await sheet.ensureTab(tabTitle), INVENTORY_TABLE);
  }
  return { added: missing.map((i) => i.sku) };
}

/**
 * Takes ordered quantities out of stock. Stock never goes below zero; whatever can't be supplied
 * from stock is returned as a backorder. Callers must make sure an order is only deducted once.
 */
export async function deductStock(access: SheetAccess, tabTitle: string, lines: { sku: string; qty: number }[]): Promise<StockResult[]> {
  return planStock(access, tabTitle, lines, true);
}

export type StockResult = { sku: string; before: number; after: number; backorder: number };

/** What deductStock would do, without changing anything (for orders waiting for approval). */
export function peekStock(access: SheetAccess, tabTitle: string, lines: { sku: string; qty: number }[]): Promise<StockResult[]> {
  return planStock(access, tabTitle, lines, false);
}

async function planStock(access: SheetAccess, tabTitle: string, lines: { sku: string; qty: number }[], write: boolean): Promise<StockResult[]> {
  const sheet = await SheetClient.connect(access);
  const values = await sheet.getRawValues(tabTitle, "A1:Z");
  const header = (values[0] ?? []).map(String);
  const skuCol = header.indexOf("SKU");
  const stockCol = header.indexOf("In stock");
  if (skuCol === -1 || stockCol === -1) throw new Error(`${tabTitle} tab needs "SKU" and "In stock" columns`);

  const results: StockResult[] = [];
  const updates: { row: number; value: number }[] = [];
  for (const line of lines) {
    const index = values.findIndex((r, i) => i > 0 && String(r[skuCol] ?? "").trim() === line.sku);
    if (index === -1) throw new Error(`SKU ${line.sku} is not in the ${tabTitle} tab`);
    // The same SKU on two order lines: take from what's left after the first.
    const pending = updates.find((u) => u.row === index + 1);
    const before = pending ? pending.value : Number(values[index][stockCol]) || 0;
    const after = Math.max(0, before - line.qty);
    if (pending) pending.value = after;
    else updates.push({ row: index + 1, value: after });
    results.push({ sku: line.sku, before, after, backorder: Math.max(0, line.qty - before) });
  }
  if (write) {
    const col = String.fromCharCode(65 + stockCol);
    for (const u of updates) await sheet.putValues(tabTitle, `${col}${u.row}`, [[u.value]]);
  }
  return results;
}

/** Reads the live inventory from the sheet (so edited prices and stock are used). */
export async function readInventory(access: SheetAccess, tabTitle: string): Promise<InventoryItem[]> {
  const sheet = await SheetClient.connect(access);
  const values = await sheet.getRawValues(tabTitle, "A1:Z");
  const header = (values[0] ?? []).map(String);
  const index = Object.fromEntries(INVENTORY_COLUMNS.map((c) => [c.key, header.indexOf(c.header)])) as Record<keyof InventoryItem, number>;
  const missing = INVENTORY_COLUMNS.filter((c) => index[c.key] === -1).map((c) => c.header);
  if (missing.length > 0) throw new Error(`Inventory tab is missing columns: ${missing.join(", ")}`);

  const text = (row: Cell[], key: keyof InventoryItem) => String(row[index[key]] ?? "").trim();
  const num = (row: Cell[], key: keyof InventoryItem) => {
    const n = Number(row[index[key]]);
    return Number.isFinite(n) ? n : 0;
  };
  return values
    .slice(1)
    .filter((row) => text(row, "sku"))
    .map((row) => ({
      sku: text(row, "sku"),
      partNumber: text(row, "partNumber"),
      description: text(row, "description"),
      maker: text(row, "maker"),
      fits: text(row, "fits"),
      category: text(row, "category"),
      quality: text(row, "quality") as InventoryItem["quality"],
      specifications: text(row, "specifications"),
      unit: text(row, "unit"),
      unitPrice: num(row, "unitPrice"),
      stock: num(row, "stock"),
      location: text(row, "location"),
      leadTimeDays: num(row, "leadTimeDays"),
      weightKg: num(row, "weightKg"),
      origin: text(row, "origin"),
      notes: text(row, "notes"),
    }));
}
