import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import {
  PROCESSED_LABEL,
  type FetchedEmail,
  type MailProvider,
  type MailSummary,
  type RawAttachment,
  type ReplyContent,
  type TestMailResult,
} from "./mail.js";
import { buildReplyMime, parseAttachments, parseEmail } from "./parse.js";

export type GmailSettings = {
  user: string;
  appPassword: string;
  /** Full Gmail search for emails still to handle (base query + the custom filter). */
  query: string;
};

function gmailMessageIdQuery(messageId: string): string {
  return `rfc822msgid:${messageId.replace(/^<|>$/g, "")}`;
}

/** Gmail over IMAP (app password). Searches use Gmail's own search syntax (X-GM-RAW). */
export class GmailProvider implements MailProvider {
  readonly name = "gmail" as const;
  readonly address: string;

  constructor(private settings: GmailSettings) {
    this.address = settings.user;
  }

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: this.settings.user, pass: this.settings.appPassword.replace(/\s/g, "") },
      logger: false,
    });
    await client.connect();
    return client;
  }

  async checkLogin(): Promise<void> {
    const client = await this.connect();
    await client.logout();
  }

  fetchUnprocessed(limit: number): Promise<FetchedEmail[]> {
    return this.search(this.settings.query, limit);
  }

  fetchProcessed(options: { days: number; messageId?: string; limit: number }): Promise<FetchedEmail[]> {
    const only = options.messageId ? ` ${gmailMessageIdQuery(options.messageId)}` : "";
    return this.search(`in:inbox label:${PROCESSED_LABEL} newer_than:${options.days}d${only}`, options.limit);
  }

  private async search(query: string, limit: number): Promise<FetchedEmail[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ gmraw: query }, { uid: true })) || [];
        // Oldest first, so a backlog is worked through in arrival order.
        const batch = uids.slice(0, limit);
        if (batch.length === 0) return [];

        const messages = await client.fetchAll(batch, { source: true, internalDate: true }, { uid: true });
        const emails: FetchedEmail[] = [];
        for (const message of messages) {
          if (!message.source) continue;
          const email = await parseEmail(message.source, message.internalDate ? new Date(message.internalDate) : null);
          if (email) emails.push(email);
        }
        return emails;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  /** Saves the reply as a Gmail draft threaded to the original. Returns false if one already exists. */
  async saveReplyDraft(original: FetchedEmail, content: ReplyContent, options: { replaceExisting?: boolean } = {}): Promise<boolean> {
    const client = await this.connect();
    try {
      const mailboxes = await client.list();
      const draftsPath = mailboxes.find((m) => m.specialUse === "\\Drafts")?.path ?? "[Gmail]/Drafts";

      const lock = await client.getMailboxLock(draftsPath);
      try {
        const existing = (await client.search({ header: { "in-reply-to": original.messageId } }, { uid: true })) || [];
        if (existing.length > 0) {
          // Unsent drafts only (sent replies live in Sent, not Drafts), so replacing never loses a sent message.
          if (!options.replaceExisting) return false;
          await client.messageDelete(existing, { uid: true });
        }
      } finally {
        lock.release();
      }

      const raw = await buildReplyMime(this.settings.user, original, content);
      await client.append(draftsPath, raw, ["\\Draft", "\\Seen"]);
      return true;
    } finally {
      await client.logout();
    }
  }

  async hasUnsentDraft(original: FetchedEmail): Promise<boolean> {
    const client = await this.connect();
    try {
      const mailboxes = await client.list();
      const draftsPath = mailboxes.find((m) => m.specialUse === "\\Drafts")?.path ?? "[Gmail]/Drafts";
      const lock = await client.getMailboxLock(draftsPath);
      try {
        // Our drafts reply to the RFQ (In-Reply-To) or to a later message in its thread (References).
        const replies = (await client.search({ header: { "in-reply-to": original.messageId } }, { uid: true })) || [];
        const inThread = (await client.search({ header: { references: original.messageId } }, { uid: true })) || [];
        return replies.length + inThread.length > 0;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  /**
   * Downloads an email's attachments. Done in the processing run rather than the inbox check so
   * large files never travel through task payloads.
   */
  async fetchAttachments(messageId: string): Promise<RawAttachment[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ gmraw: gmailMessageIdQuery(messageId) }, { uid: true })) || [];
        if (uids.length === 0) throw new Error(`Message ${messageId} not found in INBOX`);
        const message = await client.fetchOne(String(uids[0]), { source: true }, { uid: true });
        if (!message || !message.source) throw new Error(`Could not download message ${messageId}`);
        return await parseAttachments(message.source);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  /** Adds the Gmail label to the original message so the next inbox check skips it. */
  async labelProcessed(messageId: string): Promise<void> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ gmraw: gmailMessageIdQuery(messageId) }, { uid: true })) || [];
        if (uids.length === 0) throw new Error(`Message ${messageId} not found in INBOX`);
        await client.messageFlagsAdd(uids, [PROCESSED_LABEL], { uid: true, useLabels: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async sendNotice(to: string, subject: string, text: string): Promise<void> {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: this.settings.user, pass: this.settings.appPassword.replace(/\s/g, "") },
    });
    await transporter.sendMail({ from: this.settings.user, to, subject, text });
  }

  /**
   * Test cleanup: moves test emails (sent from this inbox to itself) to Trash and deletes the drafts
   * that reply to them. Customer emails are never touched, only listed. Trash keeps mail for 30 days.
   * `testSenders`: other addresses the user tests from; their processed emails count as tests too.
   */
  async trashTestMail(options: { dryRun: boolean; testSenders?: string[] }): Promise<TestMailResult> {
    const client = await this.connect();
    try {
      const mailboxes = await client.list();
      const allMail = mailboxes.find((m) => m.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";
      const trash = mailboxes.find((m) => m.specialUse === "\\Trash")?.path ?? "[Gmail]/Trash";
      const drafts = mailboxes.find((m) => m.specialUse === "\\Drafts")?.path ?? "[Gmail]/Drafts";

      const summarize = async (uids: number[]) => {
        const out: (MailSummary & { uid: number; messageId: string; inReplyTo: string })[] = [];
        if (uids.length === 0) return out;
        for (const m of await client.fetchAll(uids, { envelope: true, uid: true }, { uid: true })) {
          const e = m.envelope;
          out.push({
            uid: m.uid,
            messageId: e?.messageId ?? "",
            inReplyTo: e?.inReplyTo ?? "",
            date: e?.date ? new Date(e.date).toISOString() : "",
            from: e?.from?.map((a) => a.address).join(", ") ?? "",
            to: e?.to?.map((a) => a.address).join(", ") ?? "",
            subject: e?.subject ?? "",
          });
        }
        return out;
      };
      const strip = <T extends MailSummary>(list: T[]): MailSummary[] => list.map(({ date, from, to, subject }) => ({ date, from, to, subject }));

      // Test emails and our own drafts both live in All Mail; drafts are handled from the Drafts folder.
      let testMail: Awaited<ReturnType<typeof summarize>>;
      let customer: Awaited<ReturnType<typeof summarize>>;
      let lock = await client.getMailboxLock(allMail);
      try {
        const senders = (options.testSenders ?? []).map((s) => s.trim()).filter((s) => /^[^\s@()]+@[^\s@()]+$/.test(s));
        const fromTesters = senders.length > 0 ? ` OR (from:(${senders.join(" OR ")}) label:${PROCESSED_LABEL})` : "";
        const testQuery = `((from:me to:me (label:${PROCESSED_LABEL} OR subject:TEST-RFQ))${fromTesters}) -in:drafts`;
        testMail = await summarize((await client.search({ gmraw: testQuery }, { uid: true })) || []);
        const testUids = new Set(testMail.map((m) => m.uid));
        customer = (await summarize((await client.search({ gmraw: `-from:me label:${PROCESSED_LABEL}` }, { uid: true })) || [])).filter(
          (m) => !testUids.has(m.uid),
        );
        if (!options.dryRun && testMail.length > 0) await client.messageMove(testMail.map((m) => m.uid), trash, { uid: true });
      } finally {
        lock.release();
      }

      // Drafts that answer a test email (the agent's quotations and acknowledgments).
      const testIds = new Set(testMail.map((m) => m.messageId));
      lock = await client.getMailboxLock(drafts);
      let agentDrafts: Awaited<ReturnType<typeof summarize>>;
      try {
        const all = await summarize((await client.search({ all: true }, { uid: true })) || []);
        agentDrafts = all.filter((d) => testIds.has(d.inReplyTo));
        if (!options.dryRun && agentDrafts.length > 0) await client.messageDelete(agentDrafts.map((d) => d.uid), { uid: true });
      } finally {
        lock.release();
      }
      return { trashed: strip(testMail), draftsDeleted: strip(agentDrafts), keptCustomerEmails: strip(customer) };
    } finally {
      await client.logout();
    }
  }
}
