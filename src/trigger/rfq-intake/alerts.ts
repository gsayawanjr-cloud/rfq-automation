import { logger } from "@trigger.dev/sdk";
import nodemailer from "nodemailer";
import { liveConfig } from "./config.js";
import { SheetClient } from "./sheet.js";
import { formatHiddenTab } from "./state.js";

export type AlertKind =
  | "credits"
  | "credit-estimate"
  | "anthropic-auth"
  | "mailbox-auth"
  | "sheet"
  | "rate-limit"
  | "stuck-mail"
  | "order"
  | "other"
  | "test";

export type Classified = { kind: AlertKind; title: string; action: string };

/** Turns an error into a plain-English problem and what the owner should do about it. */
export function classifyError(error: unknown): Classified {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;

  if (/credit balance is too low|insufficient[_ ]credit|purchase credits|plans & billing/i.test(message)) {
    return {
      kind: "credits",
      title: "Anthropic credits have run out",
      action: "Add credits at console.anthropic.com (Plans & Billing). Emails wait unprocessed and are picked up automatically once credits are back.",
    };
  }
  if (/authentication_error|invalid x-api-key|permission_error|not scoped to a workspace/i.test(message) || ((status === 401 || status === 403) && /anthropic/i.test(message))) {
    return {
      kind: "anthropic-auth",
      title: "The Anthropic API key was rejected",
      action: "The key may be revoked, deleted or in the wrong workspace. Create a new key at console.anthropic.com and update ANTHROPIC_API_KEY (and ANTHROPIC_WORKSPACE_ID if used) in the environment variables.",
    };
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Microsoft sign-in|Microsoft Graph (401|403)|AADSTS/i.test(message)) {
    return {
      kind: "mailbox-auth",
      title: "The agent can't sign in to the mailbox",
      action: "Gmail: the app password was revoked or 2-Step Verification changed. Microsoft 365: the client secret expired or admin consent / the access policy changed. Fix the credentials in the environment variables.",
    };
  }
  if (/Google Sheets API (401|403|404)|Unable to parse range|PERMISSION_DENIED|invalid_grant|GOOGLE_SERVICE_ACCOUNT_JSON/i.test(message)) {
    return {
      kind: "sheet",
      title: "The agent can't read or write the Google Sheet",
      action: "Check the sheet is still shared (Editor) with the service account, the Sheets API is enabled, and RFQ_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON are correct.",
    };
  }
  if (status === 429 || /rate_limit_error|overloaded_error|\b429\b/i.test(message)) {
    return {
      kind: "rate-limit",
      title: "Claude is rate-limiting or overloaded",
      action: "Usually temporary. If it keeps happening, lower the volume or ask Anthropic for a higher limit.",
    };
  }
  return { kind: "other", title: "A run failed", action: "Open the run in the Trigger.dev dashboard to see the error." };
}

export const ALERTS_TAB = "_alerts";
const HEADER = ["Kind", "Last sent", "Times raised", "Last subject"];
export const ALERTS_WIDTHS = [150, 180, 90, 420];
// One email per kind per cooldown: a broken API key must not send a mail every minute.
const COOLDOWN_MS = 6 * 3600_000;

async function sendMessage(to: string, subject: string, text: string): Promise<void> {
  // A dedicated sender keeps alerts working even when the agent's own mailbox login is the problem.
  const user = process.env.ALERT_GMAIL_USER;
  const pass = process.env.ALERT_GMAIL_APP_PASSWORD;
  if (user && pass) {
    await nodemailer.createTransport({ service: "gmail", auth: { user, pass: pass.replace(/\s/g, "") } }).sendMail({ from: user, to, subject, text });
    return;
  }
  await liveConfig().mail.sendNotice(to, subject, text);
}

/**
 * Emails the owner (ALERT_EMAIL_TO). Returns whether a message was sent; false when alerts aren't
 * configured or the same kind was already sent within the cooldown. Never throws.
 */
export async function sendAlert(alert: { kind: AlertKind; subject: string; body: string; ignoreCooldown?: boolean }): Promise<boolean> {
  try {
    const to = process.env.ALERT_EMAIL_TO;
    if (!to) {
      logger.warn("Alert not sent: ALERT_EMAIL_TO is not set", { kind: alert.kind, subject: alert.subject });
      return false;
    }

    // Cooldown bookkeeping lives in the sheet; if that is itself broken, send the alert anyway.
    let sheet: SheetClient | null = null;
    let rows: string[][] = [];
    try {
      sheet = await SheetClient.connect(liveConfig().sheet);
      await sheet.ensureTab(ALERTS_TAB, { hidden: true });
      rows = await sheet.getValues(ALERTS_TAB, "A2:D");
      if ((await sheet.getValues(ALERTS_TAB, "A1:A1")).length === 0) {
        await sheet.putValues(ALERTS_TAB, "A1", [HEADER]);
        await formatHiddenTab(sheet, ALERTS_TAB, ALERTS_WIDTHS);
      }
    } catch (error) {
      logger.warn("Alert cooldown unavailable; sending anyway", { message: (error as Error).message });
      sheet = null;
    }

    const index = rows.findIndex((r) => r[0] === alert.kind);
    const last = index >= 0 ? Date.parse(rows[index][1]) : NaN;
    if (!alert.ignoreCooldown && Number.isFinite(last) && Date.now() - last < COOLDOWN_MS) {
      logger.info("Alert suppressed (already sent recently)", { kind: alert.kind });
      return false;
    }

    const when = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
    await sendMessage(
      to,
      // No filter keywords (RFQ, quote, ...) in alert subjects: an alert sent to the agent's own inbox must not be picked up as an RFQ.
      `[Agent alert] ${alert.subject}`,
      `${alert.body}\n\nTime: ${when} (Manila)\nYou get at most one email per problem every 6 hours.\n`,
    );

    if (sheet) {
      const count = (index >= 0 ? Number(rows[index][2]) || 0 : 0) + 1;
      const row = [alert.kind, new Date().toISOString(), count, alert.subject];
      try {
        if (index >= 0) await sheet.putValues(ALERTS_TAB, `A${index + 2}`, [row]);
        else await sheet.appendValues(ALERTS_TAB, [row]);
      } catch {
        // Bookkeeping only.
      }
    }
    logger.info("Alert sent", { kind: alert.kind });
    return true;
  } catch (error) {
    logger.error("Could not send alert", { message: (error as Error).message });
    return false;
  }
}

/** Alert for a failed run: says what went wrong, what to do, and what happens to the email. */
export async function alertRunFailure(task: string, error: unknown, context: { emailSubject?: string; runId?: string }): Promise<boolean> {
  const c = classifyError(error);
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  return sendAlert({
    kind: c.kind,
    subject: c.title,
    body: [
      `${c.title}.`,
      "",
      `What to do: ${c.action}`,
      "",
      `Task: ${task}${context.runId ? ` (run ${context.runId})` : ""}`,
      context.emailSubject ? `Email being processed: "${context.emailSubject}" (left unprocessed; it is retried automatically about 30 minutes later)` : "",
      `Error: ${detail}`,
    ]
      .filter((l, i, all) => l !== "" || all[i - 1] !== "")
      .join("\n"),
  });
}
