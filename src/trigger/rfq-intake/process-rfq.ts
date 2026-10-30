import Anthropic from "@anthropic-ai/sdk";
import { logger, retry, task } from "@trigger.dev/sdk";
import { attachmentsToBlocks, withoutPdfs, type AttachmentResult } from "./attachments.js";
import { alertRunFailure } from "./alerts.js";
import { anthropicConfig, liveConfig, TEST_MODELS } from "./config.js";
import { buildConfirmation, renderConfirmation, type Confirmation } from "./confirm.js";
import { extractRfq } from "./extract.js";
import type { FetchedEmail, RawAttachment, ReplyContent } from "./mail.js";
import { readInventory } from "./inventory.js";
import { confirmationPdfName, renderConfirmationPdf, withPdf } from "./pdf.js";
import { quoteNumber } from "./quote.js";
import { handleReply, stripQuoted } from "./reply.js";
import { logUsage } from "./usage.js";
import { appendRfqRow, knownRfqIds, OPEN_STATUSES, setRfqStatus } from "./sheet.js";
import { loadState, saveState } from "./state.js";

export type ProcessRfqPayload = {
  email: FetchedEmail;
  /** Extraction only: no draft, no sheet row, no label. For testing the prompt. */
  dryRun?: boolean;
  /** Dry runs only: attachments supplied directly instead of downloaded from Gmail. */
  attachmentFiles?: { filename: string; contentType: string; base64: string; inline?: boolean }[];
  /** Re-quote an RFQ that was already processed: replace its draft, don't add another RFQ row. */
  requote?: boolean;
  /** Overrides the configured Claude model for this email (testing). */
  model?: string;
};

export const processRfq = task({
  id: "process-rfq",
  // PDFs and long requisitions take longer to read than a one-line email.
  maxDuration: 600,
  // Each step retries itself. Re-running the whole task would pay for extraction again,
  // and an unlabeled email is picked up by a later inbox check anyway.
  retry: { maxAttempts: 1 },
  onFailure: async ({ payload, error, ctx }) => {
    if (payload.dryRun) return;
    await alertRunFailure("process-rfq", error, { emailSubject: payload.email?.subject, runId: ctx.run.id });
  },
  run: async (payload: ProcessRfqPayload) => {
    const live = payload.dryRun ? null : liveConfig();
    const email = payload.email;
    if (!email?.messageId || !email.fromAddress) throw new Error("Payload must include email.messageId and email.fromAddress");
    // Model comparisons: a test email sent from this inbox to itself may pick the model with a
    // "[model:<id>]" subject tag. Customer emails always use the configured model.
    const tag = /\[model:\s*([a-z0-9-]+)\]/i.exec(email.subject)?.[1]?.toLowerCase();
    const testModel = tag && TEST_MODELS.includes(tag) && email.fromAddress.toLowerCase() === live?.mail.address.toLowerCase() ? tag : undefined;
    const anthropic = anthropicConfig(payload.model ?? testModel);
    logger.info("Model", { model: anthropic.model });

    logger.info("Step 1/5: Reading attachments", { subject: email.subject, from: email.fromAddress, dryRun: !!payload.dryRun });
    let raw: RawAttachment[];
    if (live) {
      raw = await retry.onThrow(() => live.mail.fetchAttachments(email.messageId), { maxAttempts: 3 });
    } else {
      raw = (payload.attachmentFiles ?? []).map((f) => {
        const content = Buffer.from(f.base64, "base64");
        return { filename: f.filename, contentType: f.contentType, size: content.length, inline: !!f.inline, content };
      });
    }
    let attachments = await attachmentsToBlocks(raw);
    logger.info("Attachments", { summary: attachments.summary });

    // Our own confirmation, quotation or order acknowledgment, sent from this inbox and arriving back in it (happens
    // when the "customer" is this same address, e.g. in testing). Not a customer reply: just label it.
    const ownAddress = live?.mail.address.toLowerCase();
    // Only the new text counts: a reply that quotes our quotation underneath is still a reply.
    // The attached PDF is the surest sign (its name starts "Quotation Q-"); our headings (upper case, as in
    // our emails) are the fallback. A customer merely mentioning "quotation Q-…" in a reply must not match.
    const ownDocument =
      raw.some((a) => /^quotation q-\d{6}-/i.test(a.filename)) ||
      /(QUOTATION Q-\d{6}-|ORDER ACKNOWLEDGMENT SO-\d{6}-|REQUEST CONFIRMATION CF-\d{6}-)/.test(stripQuoted(email.text));
    if (live && email.fromAddress.toLowerCase() === ownAddress && ownDocument) {
      logger.info("Our own sent quotation/acknowledgment; labeling only");
      await retry.onThrow(() => live.mail.labelProcessed(email.messageId), { maxAttempts: 3 });
      return { isReply: false, ownMessage: true, messageId: email.messageId };
    }

    // A reply in the thread of an RFQ we already quoted is handled as a reply, not as a new RFQ.
    if (live && !payload.requote && email.references.length > 0) {
      const state = await retry.onThrow(() => loadState(live.sheet, email.references), { maxAttempts: 3 });
      if (state) {
        logger.info("Reply to an existing RFQ", { rfq: state.rfqMessageId, stage: state.stage, number: state.stage === "quoted" ? state.quotation.number : state.confirmation.number });
        const result = await handleReply(email, attachments, state, live, anthropic);
        await logUsage(live.sheet, anthropic, email.subject);
        await retry.onThrow(() => live.mail.labelProcessed(email.messageId), { maxAttempts: 3 });
        return { isReply: true, messageId: email.messageId, rfq: state.rfqMessageId, ...result };
      }
      const known = await retry.onThrow(() => knownRfqIds(live.sheet), { maxAttempts: 3 });
      const rfqId = email.references.find((id) => known.includes(id));
      if (rfqId) {
        // Quoted before replies were tracked: no stored quotation to revise, so hand it to the team.
        logger.warn("Reply to an RFQ without a stored quotation", { rfq: rfqId });
        await setRfqStatus(live.sheet, rfqId, "Needs attention", {
          from: OPEN_STATUSES,
          history: `Customer replied ("${email.subject}"); please handle manually`,
        });
        await retry.onThrow(() => live.mail.labelProcessed(email.messageId), { maxAttempts: 3 });
        return { isReply: true, messageId: email.messageId, rfq: rfqId, kind: "manual" };
      }
    }

    logger.info("Step 2/5: Extracting");
    const extract = (a: AttachmentResult) =>
      retry.onThrow(() => extractRfq(email, a, anthropic), { maxAttempts: 2 });
    let rfq;
    try {
      rfq = await extract(attachments);
    } catch (error) {
      // A PDF the API can't open (encrypted, corrupt) fails the whole request; retry without PDFs
      // so the rest of the RFQ is still read and the reply asks for the PDF in another format.
      const hasPdf = attachments.blocks.some((b) => b.type === "document");
      if (!(error instanceof Anthropic.BadRequestError) || !hasPdf) throw error;
      logger.warn("PDF rejected by the API, retrying without PDFs", { message: error.message });
      attachments = withoutPdfs(attachments);
      rfq = await extract(attachments);
    }

    if (!live) return { dryRun: true, attachments: attachments.summary, rfq };

    if (!rfq.is_rfq) {
      logger.info("Not an RFQ, labeling only");
      await logUsage(live.sheet, anthropic, email.subject);
      await retry.onThrow(() => live.mail.labelProcessed(email.messageId), { maxAttempts: 3 });
      return { isRfq: false, messageId: email.messageId, attachments: attachments.summary, rfq };
    }

    // Never quote on a first reading: the customer confirms what we understood first. The quotation
    // is prepared when their confirming reply arrives (see reply.ts).
    if (payload.requote) {
      const existing = await retry.onThrow(() => loadState(live.sheet, [email.messageId]), { maxAttempts: 3 });
      if (existing?.stage === "quoted") {
        logger.info("This RFQ already has a quotation; not sending it back to confirmation", { number: existing.quotation.number });
        return { skipped: "already quoted", messageId: email.messageId, quotation: existing.quotation.number };
      }
    }

    logger.info("Step 3/6: Preparing confirmation");
    let confirmation: Confirmation | null = null;
    const baseNumber = quoteNumber(email);
    let reply: ReplyContent;
    try {
      const inventory = await retry.onThrow(() => readInventory(live.sheet, live.inventoryTab), { maxAttempts: 3 });
      if (inventory.length === 0) throw new Error(`The ${live.inventoryTab} tab has no items`);
      confirmation = await retry.onThrow(() => buildConfirmation(email, rfq, inventory, anthropic, { round: 1, baseQuoteNumber: baseNumber }), {
        maxAttempts: 2,
      });
      const c = confirmation;
      reply = await withPdf(renderConfirmation(c, live.signature), confirmationPdfName(c), () => renderConfirmationPdf(c, live.companyName, live.signature), {
        emailSubject: email.subject,
      });
    } catch (error) {
      // Without a usable inventory the customer still gets a prompt acknowledgment with the questions.
      logger.warn("Confirmation failed, saving acknowledgment instead", { message: (error as Error).message });
      // The run carries on with an acknowledgment, so onFailure never fires; tell the owner here.
      await alertRunFailure("process-rfq (confirmation step)", error, { emailSubject: email.subject, runId: undefined });
      reply = { text: `${rfq.draft_reply_body.trim()}\n\n${live.signature}` };
    }

    logger.info("Step 4/6: Saving reply draft");
    const draftCreated = await retry.onThrow(() => live.mail.saveReplyDraft(email, reply, { replaceExisting: payload.requote }), {
      maxAttempts: 3,
    });

    logger.info("Step 5/6: Updating sheet");
    // A re-run is for an RFQ that already has its row; only its status and stored state change.
    const rowAdded = payload.requote ? false : await retry.onThrow(() => appendRfqRow(live.sheet, email, rfq), { maxAttempts: 3 });
    if (confirmation) {
      const c = confirmation;
      // Remember what we showed the customer, so their reply can be matched to it.
      await retry.onThrow(
        () =>
          saveState(live.sheet, {
            stage: "confirmation",
            rfqMessageId: email.messageId,
            baseNumber,
            round: 1,
            rfq,
            confirmation: c,
            updatedAt: new Date().toISOString(),
          }),
        { maxAttempts: 3 },
      );
      await retry.onThrow(
        () =>
          setRfqStatus(live.sheet, email.messageId, "Awaiting confirmation", {
            history: `${c.number} confirmation drafted (${c.lines.length} items, ${c.questions.length} open point(s)) by ${anthropic.model}`,
          }),
        { maxAttempts: 3 },
      );
    }

    await logUsage(live.sheet, anthropic, email.subject);
    logger.info("Step 6/6: Labeling email");
    await retry.onThrow(() => live.mail.labelProcessed(email.messageId), { maxAttempts: 3 });

    return {
      isRfq: true,
      messageId: email.messageId,
      model: anthropic.model,
      usage: anthropic.usage,
      urgency: rfq.urgency,
      vessel: rfq.vessel.name,
      items: rfq.items.length,
      blockingQuestions: rfq.missing_info.filter((m) => m.blocks_quote).length,
      draftCreated,
      rowAdded,
      attachments: attachments.summary,
      confirmation: confirmation && {
        number: confirmation.number,
        round: confirmation.round,
        lines: confirmation.lines.map((l) => ({
          no: l.no,
          requested: l.requested,
          status: l.status,
          verified: l.verified,
          qty: l.qty,
          matched: l.offers.map((o) => ({ label: o.label, sku: o.sku, partNumber: o.partNumber, quality: o.quality })),
          note: l.note,
        })),
        interpretations: confirmation.interpretations,
        questions: confirmation.questions,
      },
      // Full extraction, so a run can be checked in the dashboard without opening the sheet.
      rfq,
    };
  },
});
