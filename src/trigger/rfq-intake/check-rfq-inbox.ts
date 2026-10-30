import { idempotencyKeys, logger, schedules } from "@trigger.dev/sdk";
import { alertRunFailure } from "./alerts.js";
import { isPaused, liveConfig } from "./config.js";
import { hasPendingDecisions } from "./orders.js";
import { processOrderDecisions } from "./order-decisions.js";
import { processRfq } from "./process-rfq.js";

// Caps Claude spend if the inbox suddenly fills up; the rest are picked up on the next check.
const MAX_EMAILS_PER_RUN = 25;

export const checkRfqInbox = schedules.task({
  id: "check-rfq-inbox",
  // Every minute, so a new RFQ starts processing within about a minute of arriving.
  // window "0m" turns off Trigger.dev's default random delay after each scheduled time.
  cron: { pattern: "* * * * *", window: "0m" },
  // One check at a time: a slow IMAP connection must not let two checks overlap.
  queue: { concurrencyLimit: 1 },
  maxDuration: 120,
  // After the last retry: tell the owner (de-duplicated, so a persistent problem is one email, not 60 an hour).
  onFailure: async ({ error, ctx }) => {
    await alertRunFailure("check-rfq-inbox", error, { runId: ctx.run.id });
  },
  run: async () => {
    // A cloud deployment that is deployed but not started: do nothing, touch no mailbox.
    if (isPaused()) {
      logger.info("Agent is paused (RFQ_PAUSED=true); not checking the inbox");
      return { paused: true };
    }
    const live = liveConfig();

    // A decision a person made in the Orders tab (Approved / Rejected) is applied by its own task, one at a
    // time. This is only a cheap look; the task re-reads the sheet before changing anything.
    try {
      if (await hasPendingDecisions(live.sheet, live.ordersTab)) await processOrderDecisions.trigger();
    } catch (error) {
      // Never let this stop new RFQs from being picked up.
      logger.warn("Could not check order decisions", { message: (error as Error).message });
    }
    const emails = await live.mail.fetchUnprocessed(MAX_EMAILS_PER_RUN);

    logger.info("Inbox checked", { provider: live.mail.name, found: emails.length });
    if (emails.length === 0) return { found: 0 };

    // Fire-and-forget: each email is processed in its own run. While an email is still being
    // processed (it is labeled only at the end; attachments take over a minute), later checks see
    // it again; the idempotency key turns those into no-ops. The key must be "global": a plain
    // string inside a task is scoped to this check run, so the next check would not match it.
    // A failed email stays unlabeled and is retried once the key expires.
    const items = await Promise.all(
      emails.map(async (email) => ({
        payload: { email },
        options: {
          idempotencyKey: await idempotencyKeys.create(`rfq-${email.messageId}`, { scope: "global" }),
          idempotencyKeyTTL: "30m",
        },
      })),
    );
    await processRfq.batchTrigger(items);

    return { found: emails.length, subjects: emails.map((e) => e.subject) };
  },
});
