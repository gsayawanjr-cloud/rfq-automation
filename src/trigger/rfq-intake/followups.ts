import { logger, schedules, task } from "@trigger.dev/sdk";
import { alertRunFailure } from "./alerts.js";
import { isPaused, liveConfig } from "./config.js";
import { longDate } from "./dates.js";
import { rfqStatuses, setRfqStatus } from "./sheet.js";
import { settings, type Settings } from "./settings.js";
import { listStates, markReminder, type QuoteState } from "./state.js";

// Polite reminders for customers who have not answered. They are saved as DRAFTS in the same thread
// (nothing is sent), and only when the earlier email has actually been sent: while our own draft is
// still waiting in Drafts, a reminder would make no sense.

export type FollowUp = {
  rfqMessageId: string;
  kind: "confirmation" | "quotation";
  number: string;
  greeting: string;
  vessel: string;
  validUntil: string;
  status: string;
  /** When the customer was last asked something (the state's last update, or the last reminder). */
  lastActivity: Date;
  reminders: number;
};

const WAITING_STATUSES = { confirmation: ["Awaiting confirmation"], quotation: ["Quote drafted", "Quoted"] } as const;

export function toFollowUp(state: QuoteState, status: string, reminders: number, lastReminderAt: string): FollowUp | null {
  const kind = state.stage === "confirmation" ? "confirmation" : "quotation";
  if (!(WAITING_STATUSES[kind] as readonly string[]).includes(status)) return null;
  const updated = new Date(state.updatedAt);
  const reminded = lastReminderAt ? new Date(lastReminderAt) : null;
  return {
    rfqMessageId: state.rfqMessageId,
    kind,
    number: state.stage === "confirmation" ? state.confirmation.number : state.quotation.number,
    greeting: state.stage === "confirmation" ? state.confirmation.greeting : state.quotation.greeting,
    vessel: state.stage === "confirmation" ? state.confirmation.vessel : state.quotation.vessel,
    validUntil: state.stage === "quoted" ? state.quotation.validUntil : "",
    status,
    lastActivity: reminded && reminded > updated ? reminded : updated,
    reminders,
  };
}

/** What to do with this RFQ now: draft a reminder, give up (mark "No response"), or nothing. */
export function nextStep(f: FollowUp, now: Date, rules: Settings["reminders"], overrideDays?: number): "remind" | "give up" | null {
  const days = (now.getTime() - f.lastActivity.getTime()) / 86_400_000;
  const wait = overrideDays ?? (f.kind === "confirmation" ? rules.confirmationDays : rules.quotationDays);
  if (days < wait) return null;
  return f.reminders >= rules.max ? "give up" : "remind";
}

/** The reminder text. Short, friendly, no pressure; the number tells it apart from a first reminder. */
export function reminderText(f: FollowUp, signature: string): { text: string } {
  const about = f.vessel ? `your request for ${f.vessel}` : "your request";
  const second = f.reminders >= 1;
  const validUntil = longDate(f.validUntil);
  const body =
    f.kind === "confirmation"
      ? second
        ? [
            `Sorry to chase again about ${about}. We still need your confirmation before we can prepare the quotation.`,
            `If the details in our email are right, a quick "Confirmed" is enough. If anything needs changing, tell us what and we'll update it. And if you no longer need these parts, just say so and we'll close it off.`,
          ]
        : [
            `Just checking in on ${about}. We can only prepare the quotation once you've confirmed the details in our last email, so we're holding off until we hear from you.`,
            `If everything in it was right, a quick "Confirmed" is all we need. If something needs changing, tell us what and we'll update it.`,
          ]
      : second
        ? [
            `One more nudge on quotation ${f.number} for ${f.vessel || "your order"}. Our prices are held until ${validUntil}.`,
            `If you no longer need these parts, just let us know and we'll close it off. If you'd like to go ahead, reply with your PO number and delivery details.`,
          ]
        : [
            `Checking in on our quotation ${f.number} for ${f.vessel || "your order"}. It's valid until ${validUntil}.`,
            `If you have any questions or want something changed, let us know. If you'd like to go ahead, reply with your PO number and delivery details and we'll take it from there.`,
          ];
  return { text: [f.greeting, "", ...body.flatMap((p) => [p, ""]), signature].join("\n") };
}

export type FollowUpReport = {
  reminded: { rfq: string; kind: string; number: string; reminders: number }[];
  gaveUp: { rfq: string; number: string }[];
  skipped: { rfq: string; reason: string }[];
  dryRun: boolean;
};

/** One pass over all open RFQs. `minDays` and `dryRun` are for testing. */
export async function runFollowUps(options: { dryRun?: boolean; minDays?: number } = {}): Promise<FollowUpReport> {
  const live = liveConfig();
  const rules = settings().reminders;
  const report: FollowUpReport = { reminded: [], gaveUp: [], skipped: [], dryRun: options.dryRun === true };
  const now = new Date();

  const [states, statuses] = await Promise.all([listStates(live.sheet), rfqStatuses(live.sheet)]);
  for (const { state, reminders, lastReminderAt } of states) {
    const f = toFollowUp(state, statuses.get(state.rfqMessageId) ?? "", reminders, lastReminderAt);
    if (!f) continue;
    const step = nextStep(f, now, rules, options.minDays);
    if (!step) continue;

    const [original] = await live.mail.fetchProcessed({ days: 90, messageId: f.rfqMessageId, limit: 1 });
    if (!original) {
      report.skipped.push({ rfq: f.rfqMessageId, reason: "the original email was not found in the last 90 days" });
      continue;
    }
    // While our own last draft is still unsent, the customer has not been asked anything yet.
    if (await live.mail.hasUnsentDraft(original)) {
      report.skipped.push({ rfq: f.rfqMessageId, reason: "our earlier draft has not been sent yet" });
      continue;
    }

    if (step === "give up") {
      if (!report.dryRun) {
        await setRfqStatus(live.sheet, f.rfqMessageId, "No response", {
          from: [...WAITING_STATUSES[f.kind]],
          history: `No answer to ${f.number} after ${f.reminders} reminder(s); closing it off for now`,
        });
      }
      report.gaveUp.push({ rfq: f.rfqMessageId, number: f.number });
      continue;
    }
    if (!report.dryRun) {
      const saved = await live.mail.saveReplyDraft(original, reminderText(f, live.signature));
      if (!saved) {
        report.skipped.push({ rfq: f.rfqMessageId, reason: "a draft already exists" });
        continue;
      }
      await markReminder(live.sheet, f.rfqMessageId, f.reminders + 1);
      await setRfqStatus(live.sheet, f.rfqMessageId, f.status, {
        from: [f.status],
        history: `Reminder ${f.reminders + 1} drafted for ${f.number} (no answer yet)`,
      });
    }
    report.reminded.push({ rfq: f.rfqMessageId, kind: f.kind, number: f.number, reminders: f.reminders + 1 });
  }
  logger.info("Follow-ups checked", { reminded: report.reminded.length, gaveUp: report.gaveUp.length, skipped: report.skipped.length, dryRun: report.dryRun });
  return report;
}

export const followUpCheck = schedules.task({
  id: "follow-up-check",
  // Every morning at 09:00 Manila time.
  cron: { pattern: "0 9 * * *", timezone: "Asia/Manila" },
  queue: { concurrencyLimit: 1 },
  maxDuration: 300,
  onFailure: async ({ error, ctx }) => {
    await alertRunFailure("follow-up-check", error, { runId: ctx.run.id });
  },
  run: async () => {
    if (isPaused()) {
      logger.info("Agent is paused; skipping follow-ups");
      return { paused: true };
    }
    return runFollowUps();
  },
});

/** Manual: run the follow-up pass now. `dryRun` only lists; `minDays` overrides the waiting time (0 = now). */
export const followUpsNow = task({
  id: "follow-ups-now",
  maxDuration: 300,
  run: async (payload: { dryRun?: boolean; minDays?: number }) => runFollowUps(payload),
});
