import nodemailer from "nodemailer";
import { logger, task } from "@trigger.dev/sdk";

const SAMPLE_BODY = `Dear Sir,
Pls quote for MV Pacific Star, arriving Singapore this Friday.
ME: MAN B&W 6S50MC-C
- Fuel injector x 6
- O-ring for fuel injector, part no. 90910-123, 12 pcs
AE: Yanmar 6EY18ALW
- Cylinder head gasket set x 2, see attached list
Agent details to follow.
Need price and delivery time asap.
Rgds
J. Reyes
C/E MV Pacific Star`;

type TestAttachment = { filename: string; contentType: string; base64: string; inline?: boolean };

/** Manual test helper: emails a sample RFQ from the RFQ inbox to itself. Never sends anywhere else. */
export const sendTestRfq = task({
  id: "send-test-rfq",
  // Sending a multi-MB scan over SMTP can take over a minute.
  maxDuration: 300,
  run: async (payload: {
    subject?: string;
    body?: string;
    attachments?: TestAttachment[];
    /** To simulate a customer's reply: the thread headers a real reply would carry. */
    inReplyTo?: string;
    references?: string[];
  }) => {
    const user = process.env.RFQ_GMAIL_USER;
    if (!user) throw new Error("RFQ_GMAIL_USER is not set");
    const appPassword = process.env.RFQ_GMAIL_APP_PASSWORD;
    if (!appPassword) throw new Error("RFQ_GMAIL_APP_PASSWORD is not set");

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: appPassword.replace(/\s/g, "") },
    });

    const subject = payload.subject ?? "TEST-RFQ URGENT - ME fuel injectors + AE gaskets";
    const attachments = (payload.attachments ?? []).map((a, i) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.base64, "base64"),
      // Inline images (pasted screenshots) need a Content-ID and a reference in the HTML body.
      ...(a.inline ? { cid: `inline-${i}`, contentDisposition: "inline" as const } : {}),
    }));
    const text = payload.body ?? SAMPLE_BODY;
    const inlineImages = attachments.filter((a) => a.cid).map((a) => `<p><img src="cid:${a.cid}" alt="${a.filename}"></p>`);
    const html = inlineImages.length > 0 ? `<pre style="font-family:inherit">${escapeHtml(text)}</pre>${inlineImages.join("")}` : undefined;

    const info = await transporter.sendMail({
      from: user,
      to: user,
      subject,
      text,
      html,
      attachments,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
    });
    logger.info("Test RFQ sent", { subject, attachments: attachments.length });
    return { messageId: info.messageId, subject };
  },
});

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
