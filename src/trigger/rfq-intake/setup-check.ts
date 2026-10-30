import { task } from "@trigger.dev/sdk";
import { parseCatalog } from "./catalog-import.js";
import { anthropicClient, anthropicConfig, isPaused, liveConfig } from "./config.js";
import { fetchLogo, quoteTerms, settings } from "./settings.js";
import { SheetClient } from "./sheet.js";

type Check = { name: string; ok: boolean; detail: string };

/**
 * Manual: one pass/fail list for a new client's setup. Nothing is changed or sent. Secrets are never
 * shown, only whether they are set. Run it before the first real email and again after any change.
 */
export const setupCheck = task({
  id: "setup-check",
  maxDuration: 120,
  run: async () => {
    const checks: Check[] = [];
    const warnings: string[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const attempt = async (name: string, fn: () => Promise<string>) => {
      try {
        add(name, true, await fn());
      } catch (error) {
        add(name, false, (error as Error).message.slice(0, 200));
      }
    };

    // Settings that must be present (names only).
    const provider = (process.env.MAIL_PROVIDER || "gmail").toLowerCase();
    const needed = [
      "ANTHROPIC_API_KEY",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "RFQ_SHEET_ID",
      "SALES_REP_NAME",
      "COMPANY_NAME",
      "ALERT_EMAIL_TO",
      ...(provider === "outlook" ? ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_MAILBOX"] : ["RFQ_GMAIL_USER", "RFQ_GMAIL_APP_PASSWORD"]),
    ];
    const missing = needed.filter((n) => !(process.env[n] ?? "").trim());
    add("Required settings", missing.length === 0, missing.length === 0 ? `all set (mail provider: ${provider})` : `missing: ${missing.join(", ")}`);
    if (missing.length > 0) return { ok: false, checks, warnings, summary: `Stopped: missing ${missing.join(", ")}` };

    const live = liveConfig();
    await attempt("Mailbox login", async () => {
      await live.mail.checkLogin();
      return `signed in as ${live.mail.address}`;
    });
    await attempt("Anthropic API", async () => {
      await anthropicClient(anthropicConfig()).models.list({ limit: 1 });
      return `key accepted, model ${anthropicConfig().model}`;
    });
    await attempt("Google Sheet", async () => {
      const tabs = await (await SheetClient.connect(live.sheet)).listTabs();
      const visible = [live.sheet.tab, live.inventoryTab, live.quotationsTab, live.ordersTab];
      const absent = visible.filter((t) => !tabs.includes(t));
      return absent.length === 0 ? "all tabs present" : `reachable; tabs not created yet (made automatically when first needed): ${absent.join(", ")}`;
    });
    await attempt("Catalog (Inventory tab)", async () => {
      const rows = await (await SheetClient.connect(live.sheet)).getRawValues(live.inventoryTab, "A1:AZ");
      const report = parseCatalog(rows);
      if (report.errors.some((e) => e.row === null)) throw new Error(report.errors.filter((e) => e.row === null).map((e) => e.problem).join(" "));
      if (report.imported === 0) throw new Error("no usable items in the Inventory tab");
      if (report.skipped > 0) warnings.push(`${report.skipped} Inventory row(s) have problems (run import-inventory for the list).`);
      warnings.push(...report.warnings);
      return `${report.imported} usable item(s), ${report.skipped} with problems`;
    });

    // Business details a client will want on every quotation (warnings, not failures).
    const s = settings();
    const company = s.company;
    if (!company.address && !company.phone && !company.email) warnings.push("No company address, phone or email: the quotation PDF has no letterhead (COMPANY_ADDRESS, COMPANY_PHONE, COMPANY_EMAIL).");
    if (s.bankLines.length === 0) warnings.push("No bank details (BANK_DETAILS): the quotation PDF has no payment details.");
    if (!company.logoUrl) warnings.push("No logo (COMPANY_LOGO_URL).");
    else if (!(await fetchLogo(company.logoUrl))) warnings.push("The logo could not be loaded (COMPANY_LOGO_URL must be a public PNG or JPEG under 1 MB).");
    if (!s.deliveryTerms) warnings.push("No delivery terms: quotations have no delivery line. Set TERMS_DELIVERY to this client's delivery charges.");
    if (/^(rfq agent|agent|test|demo|company)$/i.test(company.name)) warnings.push(`COMPANY_NAME is "${company.name}": use the client's real company name, it is printed in every signature and on the PDF.`);
    if (!(process.env.SALES_REP_TITLE ?? "").trim()) warnings.push("No SALES_REP_TITLE: the signature shows the name and company only (for example Sales Manager).");
    if (!(process.env.ALERT_GMAIL_USER ?? "").trim()) warnings.push("Alerts are sent through the agent's own mailbox; set ALERT_GMAIL_USER and ALERT_GMAIL_APP_PASSWORD so they still arrive if that login breaks.");
    if (!(process.env.ANTHROPIC_CREDIT_USD ?? "").trim()) warnings.push("No early low-credit warning (ANTHROPIC_CREDIT_USD and CREDIT_COUNT_FROM).");

    const ok = checks.every((c) => c.ok);
    return {
      ok,
      checks,
      warnings: [...new Set(warnings)],
      behaviour: {
        paused: isPaused(),
        orderApproval: s.orderApproval,
        reminders: s.reminders,
        currency: s.currency,
        validityDays: s.validityDays,
        terms: quoteTerms(s),
      },
      summary: ok ? `All ${checks.length} checks passed${warnings.length ? `, ${new Set(warnings).size} warning(s)` : ""}` : `${checks.filter((c) => !c.ok).length} check(s) failed`,
    };
  },
});
