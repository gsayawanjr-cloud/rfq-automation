import { logger, task } from "@trigger.dev/sdk";
import { liveConfig } from "./config.js";
import { INVENTORY_COLUMNS, type InventoryItem, writeInventoryRows } from "./inventory.js";
import { SheetClient, type Cell, type SheetConfig } from "./sheet.js";

// Loads a client's real price list into the Inventory tab, or checks the tab as it is. Nothing is
// invented: a required column that cannot be found stops the import, and a row with a bad value is
// skipped and reported rather than repaired.

type Field = keyof InventoryItem;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Header names clients commonly use, per field (compared without spaces, case or punctuation).
const ALIASES: Record<Field, string[]> = {
  sku: ["sku", "itemcode", "code", "stockcode", "materialno", "materialnumber", "productcode", "itemno", "itemnumber"],
  partNumber: ["partno", "partnumber", "pn", "partnr", "makerpartno", "oempartno", "mfrpartno", "manufacturerpartno"],
  description: ["description", "desc", "itemdescription", "partname", "partdescription", "name", "item", "product"],
  maker: ["maker", "brand", "manufacturer", "make", "oem"],
  fits: ["fits", "fitsmodel", "model", "engine", "enginemodel", "application", "applicablemodel"],
  category: ["category", "group", "itemgroup", "family", "type"],
  quality: ["quality", "grade", "partquality", "oemtype", "genuineaftermarket"],
  specifications: ["specifications", "specification", "specs", "spec", "details", "technicaldata"],
  unit: ["unit", "uom", "unitofmeasure", "um"],
  unitPrice: ["unitprice", "price", "sellingprice", "listprice", "saleprice", "unitsellingprice"],
  stock: ["instock", "stock", "qty", "quantity", "onhand", "qtyonhand", "available", "stockqty", "stockonhand"],
  location: ["location", "warehouse", "wh", "bin", "stockroom", "store"],
  leadTimeDays: ["leadtime", "leadtimedays", "leaddays", "leadtimeifoutofstockdays", "deliverydays"],
  weightKg: ["weight", "weightkg", "kg", "unitweight"],
  origin: ["origin", "countryoforigin", "madein", "country"],
  notes: ["notes", "note", "remarks", "comment", "comments"],
};

const REQUIRED: Field[] = ["description", "maker", "unitPrice", "stock", "quality"];

const QUALITY_WORDS: [RegExp, InventoryItem["quality"]][] = [
  [/^(genuine|genuineoem|oem|original|maker|makeroriginal)$/, "Genuine OEM"],
  [/^(oemlicensed|licensed|licenced|makerapproved|approved|oemapproved)$/, "OEM-licensed"],
  [/^(aftermarket|nonoem|pattern|copy|compatible|replacement|alternative)$/, "Aftermarket"],
];

export type ImportIssue = { row: number | null; problem: string };
export type CatalogReport = {
  headerRow: number;
  /** Which source column each field was read from (header text), so a person can check the mapping. */
  mapping: Record<string, string>;
  rowsRead: number;
  imported: number;
  skipped: number;
  errors: ImportIssue[];
  warnings: string[];
  written: boolean;
  backupTab: string;
  items?: InventoryItem[];
};

/** Finds the header row (catalogs often have a title block above it) and maps columns to fields. */
export function mapHeaders(rows: Cell[][]): { headerRow: number; columns: Partial<Record<Field, number>>; errors: string[]; warnings: string[] } {
  let best = { index: 0, score: -1, columns: {} as Partial<Record<Field, number>> };
  rows.slice(0, 15).forEach((row, index) => {
    const columns: Partial<Record<Field, number>> = {};
    const cells = row.map((c) => norm(String(c ?? "")));
    (Object.keys(ALIASES) as Field[]).forEach((field) => {
      const own = norm(INVENTORY_COLUMNS.find((c) => c.key === field)?.header ?? "");
      const hits = cells.map((c, i) => (c && (ALIASES[field].includes(c) || c === own) ? i : -1)).filter((i) => i >= 0);
      if (hits.length > 0) columns[field] = hits[0];
    });
    const score = Object.keys(columns).length;
    if (score > best.score) best = { index, score, columns };
  });

  const errors: string[] = [];
  const warnings: string[] = [];
  const columns = { ...best.columns };

  // A "price" column when there are several is ambiguous: do not pick one for the client.
  if (columns.unitPrice === undefined) {
    const priceLike = (rows[best.index] ?? []).map((c, i) => [norm(String(c ?? "")), i] as const).filter(([n]) => n.includes("price"));
    if (priceLike.length === 1) columns.unitPrice = priceLike[0][1];
    else if (priceLike.length > 1) errors.push(`More than one price column (${priceLike.map(([, i]) => String(rows[best.index][i])).join(", ")}). Rename the selling price column to "Unit price".`);
  }
  if (columns.sku === undefined && columns.partNumber !== undefined) {
    columns.sku = columns.partNumber;
    warnings.push("No SKU column, so the Part No. is used as the SKU.");
  }
  if (columns.sku === undefined) errors.push('No SKU or Part No. column found. Add a column named "SKU" or "Part No.".');
  for (const field of REQUIRED) {
    if (columns[field] === undefined) {
      const header = INVENTORY_COLUMNS.find((c) => c.key === field)?.header ?? field;
      errors.push(`No "${header}" column found. It is needed and is not guessed.`);
    }
  }
  if (columns.partNumber === undefined) warnings.push("No Part No. column: customers' part numbers cannot be matched exactly.");
  for (const field of ["unit", "location", "leadTimeDays"] as Field[]) {
    if (columns[field] === undefined) warnings.push(`No "${INVENTORY_COLUMNS.find((c) => c.key === field)?.header}" column; those cells stay empty.`);
  }
  return { headerRow: best.index, columns, errors, warnings };
}

const toNumber = (v: Cell | undefined): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/** Source rows to inventory items plus everything wrong with them. Pure, so it can be tested. */
export function parseCatalog(rows: Cell[][]): CatalogReport {
  const { headerRow, columns, errors: headerErrors, warnings } = mapHeaders(rows);
  const header = rows[headerRow] ?? [];
  const mapping = Object.fromEntries(
    (Object.entries(columns) as [Field, number][]).map(([field, index]) => [INVENTORY_COLUMNS.find((c) => c.key === field)?.header ?? field, String(header[index] ?? "")]),
  );
  const report: CatalogReport = {
    headerRow: headerRow + 1,
    mapping,
    rowsRead: 0,
    imported: 0,
    skipped: 0,
    errors: headerErrors.map((problem) => ({ row: null, problem })),
    warnings: [...warnings],
    written: false,
    backupTab: "",
  };
  if (headerErrors.length > 0) return report;

  const text = (row: Cell[], field: Field) => (columns[field] === undefined ? "" : String(row[columns[field]!] ?? "").trim());
  const seen = new Map<string, number>();
  const items: InventoryItem[] = [];
  let missingMaker = 0;
  let missingUnit = 0;

  rows.slice(headerRow + 1).forEach((row, i) => {
    const sheetRow = headerRow + 2 + i;
    if (row.every((c) => String(c ?? "").trim() === "")) return; // blank line
    report.rowsRead++;
    const bad = (problem: string) => {
      report.skipped++;
      report.errors.push({ row: sheetRow, problem });
    };

    const sku = text(row, "sku");
    if (!sku) return bad("no SKU / part number");
    const key = sku.toLowerCase();
    if (seen.has(key)) return bad(`duplicate SKU "${sku}" (first on row ${seen.get(key)})`);
    const description = text(row, "description");
    if (!description) return bad("no description");
    const price = toNumber(row[columns.unitPrice!]);
    if (price === null || price <= 0) return bad(`price "${text(row, "unitPrice")}" is missing or not a positive number`);
    const stock = toNumber(row[columns.stock!]);
    if (stock === null || stock < 0 || !Number.isInteger(stock)) return bad(`stock "${text(row, "stock")}" is missing or not a whole number of 0 or more`);
    const qualityWord = norm(text(row, "quality"));
    const quality = QUALITY_WORDS.find(([re]) => re.test(qualityWord))?.[1];
    if (!quality) return bad(`quality "${text(row, "quality")}" is not Genuine OEM, OEM-licensed or Aftermarket`);
    const lead = toNumber(row[columns.leadTimeDays ?? -1]);
    const weight = toNumber(row[columns.weightKg ?? -1]);
    if (!text(row, "maker")) missingMaker++;
    if (!text(row, "unit")) missingUnit++;

    seen.set(key, sheetRow);
    items.push({
      sku,
      partNumber: text(row, "partNumber"),
      description,
      maker: text(row, "maker"),
      fits: text(row, "fits"),
      category: text(row, "category"),
      quality,
      specifications: text(row, "specifications"),
      unit: text(row, "unit"),
      unitPrice: price,
      stock,
      location: text(row, "location"),
      leadTimeDays: lead !== null && lead > 0 ? lead : 0,
      weightKg: weight !== null && weight > 0 ? weight : 0,
      origin: text(row, "origin"),
      notes: text(row, "notes"),
    });
  });

  report.imported = items.length;
  if (missingMaker > 0) report.warnings.push(`${missingMaker} row(s) have no maker.`);
  if (missingUnit > 0) report.warnings.push(`${missingUnit} row(s) have no unit.`);
  if (items.length > 0 && items.every((i) => i.fits === "")) report.warnings.push("No row says which engine model it fits, so matching can only use part numbers.");
  report.items = items;
  return report;
}

/**
 * Checks a price list and, with `confirm`, writes it into the Inventory tab. Without `sourceTab` it
 * checks the Inventory tab as it is. The old Inventory is copied to a hidden backup tab first.
 */
export async function importCatalog(
  config: SheetConfig,
  options: { sourceSheetId?: string; sourceTab?: string; targetTab: string; confirm: boolean },
): Promise<CatalogReport> {
  const sourceTab = options.sourceTab ?? options.targetTab;
  const source = await SheetClient.connect({ ...config, sheetId: options.sourceSheetId ?? config.sheetId });
  const rows = await source.getRawValues(sourceTab, "A1:AZ");
  const report = parseCatalog(rows);

  const inPlace = !options.sourceTab && !options.sourceSheetId;
  if (!options.confirm || inPlace || report.errors.some((e) => e.row === null) || report.imported === 0) {
    delete report.items;
    return report;
  }

  const target = await SheetClient.connect(config);
  const existing = await target.getRawValues(options.targetTab, "A1:Z").catch(() => [] as Cell[][]);
  if (existing.length > 0) {
    report.backupTab = `_inventory_backup_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    await target.ensureTab(report.backupTab, { hidden: true });
    await target.putValues(report.backupTab, "A1", existing);
  }
  await target.ensureTab(options.targetTab);
  await target.clearValues(options.targetTab, "A:Z");
  await writeInventoryRows(target, options.targetTab, report.items!);
  report.written = true;
  delete report.items;
  return report;
}

/**
 * Manual. Without `sourceTab`: checks the current Inventory tab and reports problems. With
 * `sourceTab` (and optionally `sourceSheetId`, a Google Sheet shared with the service account): reads
 * a client's price list and reports what would be imported. Add `confirm: true` to write it.
 */
export const importInventory = task({
  id: "import-inventory",
  maxDuration: 300,
  run: async (payload: { sourceSheetId?: string; sourceTab?: string; targetTab?: string; confirm?: boolean }) => {
    const live = liveConfig();
    const report = await importCatalog(live.sheet, {
      sourceSheetId: payload.sourceSheetId,
      sourceTab: payload.sourceTab,
      targetTab: payload.targetTab ?? live.inventoryTab,
      confirm: payload.confirm === true,
    });
    logger.info("Catalog checked", { imported: report.imported, skipped: report.skipped, written: report.written });
    return { ...report, errors: report.errors.slice(0, 60), note: report.errors.length > 60 ? `${report.errors.length - 60} more problems not shown` : "" };
  },
});
