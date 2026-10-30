// Dates and units as they are written to customers. Stored values (sheet, state) stay ISO / as given.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-15" as "15 November 2026" (anything else is returned as it is). */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

const UNIT_ALIASES: Record<string, string> = {
  pc: "pc", pcs: "pc", pce: "pc", pces: "pc", piece: "pc", pieces: "pc", no: "pc", nos: "pc", ea: "pc", each: "pc",
  set: "set", sets: "set",
  kit: "kit", kits: "kit",
  pair: "pair", pairs: "pair", prs: "pair", pr: "pair",
  roll: "roll", rolls: "roll",
  box: "box", boxes: "box",
  ltr: "litre", ltrs: "litre", liter: "litre", liters: "litre", litre: "litre", litres: "litre", l: "litre",
  drum: "drum", drums: "drum",
  length: "length", lengths: "length",
  mtr: "m", mtrs: "m", meter: "m", meters: "m", metre: "m", metres: "m", m: "m",
};

/** "PCS" / "PC" / "KIT" as a person would write it for this quantity: "pcs", "pc", "kit", "kits". */
export function unitLabel(unit: string, qty: number | null): string {
  const raw = (unit ?? "").trim();
  if (!raw) return "";
  const base = UNIT_ALIASES[raw.toLowerCase().replace(/\.$/, "")];
  if (!base) return raw; // an unfamiliar unit is shown exactly as written
  const plural = qty !== null && qty !== 1;
  switch (base) {
    case "pc":
      return plural ? "pcs" : "pc";
    case "m":
      return "m";
    case "litre":
      return plural ? "litres" : "litre";
    case "box":
      return plural ? "boxes" : "box";
    default:
      return plural ? `${base}s` : base;
  }
}
