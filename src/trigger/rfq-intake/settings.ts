// Business settings that differ from client to client, read from environment variables. Every default
// reproduces the wording the agent used before these settings existed, so nothing changes until a
// client's value is set. Values are read when used (not at import) except CURRENCY, which also names
// sheet columns: set it before first use.

const clean = (v: string | undefined) => (v ?? "").trim();
const list = (v: string | undefined) =>
  clean(v)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
const number = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const flag = (name: string, fallback: boolean) => {
  const v = clean(process.env[name]).toLowerCase();
  return v === "" ? fallback : v === "true";
};

export function currency(): string {
  return clean(process.env.CURRENCY).toUpperCase() || "USD";
}
/** Currency code for column headers and document text. */
export const CURRENCY = currency();

export type Settings = {
  currency: string;
  validityDays: number;
  priceBasis: string;
  deliveryTerms: string;
  availabilityTerms: string;
  paymentTerms: string;
  extraTerms: string[];
  company: { name: string; address: string; phone: string; email: string; website: string; taxId: string; logoUrl: string };
  bankLines: string[];
  /** A confirmed order waits for a person's approval in the sheet before stock changes. */
  orderApproval: boolean;
  reminders: { confirmationDays: number; quotationDays: number; max: number };
};

export function settings(): Settings {
  const cur = currency();
  return {
    currency: cur,
    validityDays: number("QUOTE_VALIDITY_DAYS", 30),
    priceBasis: clean(process.env.PRICE_BASIS) || "ex-works our warehouse, excluding taxes and duties",
    // Delivery charges differ from one client to the next, so there is no default: without this
    // setting the quotation simply has no delivery line (setup-check warns about it).
    deliveryTerms: clean(process.env.TERMS_DELIVERY),
    availabilityTerms: clean(process.env.TERMS_AVAILABILITY) || "Availability is subject to prior sale. Lead times count from order confirmation.",
    paymentTerms: clean(process.env.PAYMENT_TERMS) || "30 days from invoice date",
    extraTerms: list(process.env.EXTRA_TERMS),
    company: {
      name: clean(process.env.COMPANY_NAME),
      address: clean(process.env.COMPANY_ADDRESS),
      phone: clean(process.env.COMPANY_PHONE),
      email: clean(process.env.COMPANY_EMAIL),
      website: clean(process.env.COMPANY_WEBSITE),
      taxId: clean(process.env.COMPANY_TAX_ID),
      logoUrl: clean(process.env.COMPANY_LOGO_URL),
    },
    bankLines: list(process.env.BANK_DETAILS),
    orderApproval: flag("ORDER_APPROVAL", true),
    reminders: {
      confirmationDays: number("REMINDER_DAYS_CONFIRMATION", 2),
      quotationDays: number("REMINDER_DAYS_QUOTATION", 3),
      max: number("MAX_REMINDERS", 2),
    },
  };
}

/** The terms printed on every quotation (email and PDF). */
export function quoteTerms(s: Settings = settings()): string[] {
  return [
    `Prices in ${s.currency}, ${s.priceBasis}.`,
    ...(s.deliveryTerms ? [s.deliveryTerms] : []),
    s.availabilityTerms,
    `Payment: ${s.paymentTerms}.`,
    `This quotation is valid for ${s.validityDays} days.`,
    ...s.extraTerms,
  ];
}

const logoCache = new Map<string, Buffer | null>();

/** The company logo as PNG/JPEG bytes, or null (not set, unreachable, too big, or not an image). */
export async function fetchLogo(url: string): Promise<Buffer | null> {
  if (!url) return null;
  if (logoCache.has(url)) return logoCache.get(url) ?? null;
  let logo: Buffer | null = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if ((png || jpeg) && bytes.length <= 1_000_000) logo = bytes;
    }
  } catch {
    // Quotations are made without the logo rather than failing.
  }
  logoCache.set(url, logo);
  return logo;
}
