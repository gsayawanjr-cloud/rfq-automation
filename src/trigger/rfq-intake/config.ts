import Anthropic from "@anthropic-ai/sdk";
import { GmailProvider } from "./gmail.js";
import { PROCESSED_LABEL, type MailProvider } from "./mail.js";
import { OutlookProvider } from "./outlook.js";
import type { SheetConfig } from "./sheet.js";

export { PROCESSED_LABEL };
// Gmail only. Always applied, so a custom filter can narrow the search but never reprocess old or labeled mail.
const BASE_QUERY = `in:inbox -label:${PROCESSED_LABEL} newer_than:2d`;
const DEFAULT_FILTER = "-from:me";

export const DEFAULT_MODEL = "claude-opus-5-5";
// Models a test email may ask for with a "[model:<id>]" subject tag (see process-rfq).
export const TEST_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export type AiConfig = {
  apiKey: string;
  workspaceId?: string;
  model: string;
  /** Added up over every Claude call in one run, for cost comparisons. */
  usage: { calls: number; inputTokens: number; outputTokens: number };
};

export function anthropicConfig(model?: string): AiConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  // Optional: only needed when ANTHROPIC_API_KEY is an org-level (not workspace-scoped) key.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID || undefined;
  return {
    apiKey,
    workspaceId,
    model: model || process.env.RFQ_MODEL || DEFAULT_MODEL,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

export function anthropicClient(ai: AiConfig): Anthropic {
  return new Anthropic({ apiKey: ai.apiKey, defaultHeaders: ai.workspaceId ? { "anthropic-workspace-id": ai.workspaceId } : undefined });
}

export function recordUsage(ai: AiConfig, usage: { input_tokens: number; output_tokens: number }): void {
  ai.usage.calls++;
  ai.usage.inputTokens += usage.input_tokens;
  ai.usage.outputTokens += usage.output_tokens;
}

/** True while the agent is switched off (a cloud deployment that has been deployed but not started). */
export function isPaused(): boolean {
  return (process.env.RFQ_PAUSED ?? "").trim().toLowerCase() === "true";
}

const DEFAULT_OUTLOOK_KEYWORDS = "RFQ,quote,quotation,enquiry,inquiry,spares,requisition,viber";

/** The mailbox the agent works in: Gmail (default) or Microsoft 365 / Outlook, chosen by MAIL_PROVIDER. */
export function mailProvider(): MailProvider {
  const provider = (process.env.MAIL_PROVIDER || "gmail").trim().toLowerCase();
  if (provider === "outlook") {
    const need = (name: string) => {
      const value = process.env[name];
      if (!value) throw new Error(`${name} is not set (MAIL_PROVIDER=outlook)`);
      return value;
    };
    return new OutlookProvider({
      tenantId: need("MS_TENANT_ID"),
      clientId: need("MS_CLIENT_ID"),
      clientSecret: need("MS_CLIENT_SECRET"),
      mailbox: need("MS_MAILBOX"),
      subjectKeywords: (process.env.RFQ_OUTLOOK_SUBJECT_KEYWORDS ?? DEFAULT_OUTLOOK_KEYWORDS)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      includeSelf: (process.env.RFQ_OUTLOOK_INCLUDE_SELF ?? "").trim().toLowerCase() === "true",
    });
  }
  if (provider !== "gmail") throw new Error(`MAIL_PROVIDER must be "gmail" or "outlook", not "${provider}"`);
  const user = process.env.RFQ_GMAIL_USER;
  if (!user) throw new Error("RFQ_GMAIL_USER is not set");
  const appPassword = process.env.RFQ_GMAIL_APP_PASSWORD;
  if (!appPassword) throw new Error("RFQ_GMAIL_APP_PASSWORD is not set");
  return new GmailProvider({ user, appPassword, query: `${BASE_QUERY} ${process.env.RFQ_GMAIL_QUERY || DEFAULT_FILTER}` });
}

/** "Best regards," then the rep's name and, if set, their title; the company goes on the last line. */
export function signatureText(name: string, title: string | undefined, company: string): string {
  const t = (title ?? "").trim();
  return t ? `Best regards,\n${name}\n${t}, ${company}` : `Best regards,\n${name}, ${company}`;
}

/** Everything needed to touch the inbox and the sheet. Checked up front so nothing half-runs. */
export function liveConfig() {
  const mail = mailProvider();
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  if (!serviceAccountJson.trim().startsWith("{")) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must be the whole JSON key file, not the service account email");
  }
  const sheetId = process.env.RFQ_SHEET_ID;
  if (!sheetId) throw new Error("RFQ_SHEET_ID is not set");
  const salesRepName = process.env.SALES_REP_NAME?.trim();
  if (!salesRepName) throw new Error("SALES_REP_NAME is not set");
  const companyName = process.env.COMPANY_NAME;
  if (!companyName) throw new Error("COMPANY_NAME is not set");

  const sheet: SheetConfig = { serviceAccountJson, sheetId, tab: process.env.RFQ_SHEET_TAB || "RFQs" };
  return {
    mail,
    sheet,
    inventoryTab: process.env.RFQ_INVENTORY_TAB || "Inventory",
    quotationsTab: process.env.RFQ_QUOTATIONS_TAB || "Quotations",
    ordersTab: process.env.RFQ_ORDERS_TAB || "Orders",
    companyName,
    signature: signatureText(salesRepName, process.env.SALES_REP_TITLE, companyName),
  };
}
