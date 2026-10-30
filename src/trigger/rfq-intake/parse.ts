import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type { FetchedEmail, RawAttachment } from "./mail.js";

// Long emails are mostly quoted history and signatures; the RFQ itself is near the top.
const MAX_BODY_CHARS = 20000;

/** Raw MIME message to the shape the agent works with. Same for every mail provider. */
export async function parseEmail(source: Buffer, receivedAt?: Date | null): Promise<FetchedEmail | null> {
  const parsed = await simpleParser(source);
  const from = parsed.from?.value[0];
  if (!parsed.messageId || !from?.address) return null;

  // In-Reply-To as well as References, so a reply can be traced back to the RFQ it answers.
  const references = [
    ...(parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []),
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
  ].filter((id, i, all) => all.indexOf(id) === i);

  return {
    messageId: parsed.messageId,
    receivedAt: (receivedAt ?? parsed.date ?? new Date()).toISOString(),
    fromName: from.name || null,
    fromAddress: from.address,
    replyTo: parsed.replyTo?.value[0]?.address ?? from.address,
    subject: parsed.subject ?? "",
    text: (parsed.text ?? "").slice(0, MAX_BODY_CHARS),
    attachments: parsed.attachments.filter((a) => a.contentDisposition !== "inline").map((a) => a.filename ?? "(unnamed attachment)"),
    references,
  };
}

export async function parseAttachments(source: Buffer): Promise<RawAttachment[]> {
  const parsed = await simpleParser(source);
  return parsed.attachments.map((a) => ({
    filename: a.filename ?? "(unnamed attachment)",
    contentType: a.contentType,
    size: a.size,
    inline: a.contentDisposition === "inline" || a.related === true,
    content: a.content,
  }));
}

/** The Message-ID this message replies to (to find our own drafts for an email). */
export async function inReplyToOf(source: Buffer): Promise<string> {
  return (await simpleParser(source)).inReplyTo ?? "";
}

/** Builds the reply MIME message: threaded with In-Reply-To / References, original subject with "Re:". */
export async function buildReplyMime(
  from: string,
  original: FetchedEmail,
  content: { text: string; html?: string; attachments?: { filename: string; content: Buffer; contentType: string }[] },
): Promise<Buffer> {
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  return new MailComposer({
    from,
    to: original.replyTo,
    subject,
    text: content.text,
    html: content.html,
    attachments: content.attachments,
    inReplyTo: original.messageId,
    references: [...original.references, original.messageId],
  })
    .compile()
    .build();
}
