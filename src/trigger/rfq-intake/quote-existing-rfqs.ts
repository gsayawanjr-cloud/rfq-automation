import { logger, task } from "@trigger.dev/sdk";
import { liveConfig } from "./config.js";
import { processRfq } from "./process-rfq.js";
import { knownRfqIds } from "./sheet.js";

/**
 * Manual: re-processes RFQs that were already handled (labeled): each gets a fresh confirmation draft
 * (round 1), replacing its earlier draft; no quotation is made until the customer confirms. RFQs that
 * already have a quotation are skipped. Their RFQ rows are kept.
 */
export const quoteExistingRfqs = task({
  id: "quote-existing-rfqs",
  maxDuration: 300,
  run: async (payload: { days?: number; limit?: number; messageId?: string }) => {
    const live = liveConfig();
    const days = payload.days ?? 7;
    // With messageId, only that RFQ is re-quoted (e.g. to redo one draft).
    const labeled = await live.mail.fetchProcessed({ days, messageId: payload.messageId, limit: payload.limit ?? 25 });
    // Only real RFQs (rows in the RFQs tab), never replies or our own sent quotations that also carry the label.
    const known = await knownRfqIds(live.sheet);
    const emails = labeled.filter((e) => known.includes(e.messageId));
    logger.info("Already-processed RFQs found", { days, found: emails.length, subjects: emails.map((e) => e.subject) });
    if (emails.length === 0) return { found: 0 };

    await processRfq.batchTrigger(emails.map((email) => ({ payload: { email, requote: true } })));
    return { found: emails.length, subjects: emails.map((e) => e.subject) };
  },
});
