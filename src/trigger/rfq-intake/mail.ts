import type { InboundEmail } from "./extract.js";

/** Applied to an email (Gmail label / Outlook category) once it has been handled. */
export const PROCESSED_LABEL = "rfq-processed";

export type FetchedEmail = InboundEmail & {
  replyTo: string;
  references: string[];
};

export type RawAttachment = {
  filename: string;
  contentType: string;
  size: number;
  /** Embedded in the body (pasted screenshot, signature logo) rather than attached. */
  inline: boolean;
  content: Buffer;
};

export type ReplyContent = {
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};

export type MailSummary = { date: string; from: string; to: string; subject: string };

export type TestMailResult = {
  trashed: MailSummary[];
  draftsDeleted: MailSummary[];
  keptCustomerEmails: MailSummary[];
};

/**
 * Everything the agent needs from a mailbox. Gmail (IMAP) and Outlook / Microsoft 365 (Graph)
 * implement it, so no task knows which one it is talking to.
 */
export interface MailProvider {
  readonly name: "gmail" | "outlook";
  /** The mailbox's own address (to recognise our own messages). */
  readonly address: string;
  /** Unhandled inbox emails that match the filter, oldest first. */
  fetchUnprocessed(limit: number): Promise<FetchedEmail[]>;
  /** Emails already handled (labeled), optionally just one by Message-ID. */
  fetchProcessed(options: { days: number; messageId?: string; limit: number }): Promise<FetchedEmail[]>;
  /** Downloads an email's attachments (done in the processing run, not the inbox check). */
  fetchAttachments(messageId: string): Promise<RawAttachment[]>;
  /** Saves a reply draft threaded to the original. False if one already exists (unless replacing). */
  saveReplyDraft(original: FetchedEmail, content: ReplyContent, options?: { replaceExisting?: boolean }): Promise<boolean>;
  /** Is there still an unsent draft in the thread of this email (so a person has not sent our last reply yet)? */
  hasUnsentDraft(original: FetchedEmail): Promise<boolean>;
  /** Marks the email handled so the next check skips it. */
  labelProcessed(messageId: string): Promise<void>;
  /** Test cleanup: self-sent test mail to the trash plus the drafts answering it. */
  trashTestMail(options: { dryRun: boolean; testSenders?: string[] }): Promise<TestMailResult>;
  /** Sends a plain notification email (alerts). Not a customer reply. */
  sendNotice(to: string, subject: string, text: string): Promise<void>;
  /** Throws if the mailbox can't be reached or the login is rejected. */
  checkLogin(): Promise<void>;
}
