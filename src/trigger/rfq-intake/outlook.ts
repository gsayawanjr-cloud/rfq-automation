import {
  PROCESSED_LABEL,
  type FetchedEmail,
  type MailProvider,
  type MailSummary,
  type RawAttachment,
  type ReplyContent,
  type TestMailResult,
} from "./mail.js";
import { buildReplyMime, inReplyToOf, parseAttachments, parseEmail } from "./parse.js";

export type OutlookSettings = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox the agent works in (user principal name / address). */
  mailbox: string;
  /** Only emails whose subject contains one of these (case-insensitive) are picked up. Empty = all. */
  subjectKeywords: string[];
  /** Testing only: also pick up mail from the mailbox itself (production skips it). */
  includeSelf: boolean;
  /** Replaceable in tests. */
  fetchFn?: typeof fetch;
};

type GraphMessage = {
  id: string;
  receivedDateTime?: string;
  subject?: string;
  internetMessageId?: string;
  conversationId?: string;
  categories?: string[];
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
};

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,receivedDateTime,subject,internetMessageId,conversationId,categories,from,toRecipients";
// The inbox check only looks at recent mail, like the Gmail base query (newer_than:2d).
const UNPROCESSED_DAYS = 2;
const MAX_PAGES = 5;

const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Microsoft 365 / Outlook through Microsoft Graph, using an app registration (client credentials),
 * so no mailbox password is stored. Filtering by category / subject / sender is done in code over a
 * small server-side date window: combining those filters on the server is often rejected by Exchange
 * as too complex.
 */
export class OutlookProvider implements MailProvider {
  readonly name = "outlook" as const;
  readonly address: string;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(private s: OutlookSettings) {
    this.address = s.mailbox;
    this.fetchFn = s.fetchFn ?? fetch;
  }

  // ─── Graph plumbing ───────────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(this.s.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.s.clientId,
        client_secret: this.s.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    if (!response.ok) throw new Error(`Microsoft sign-in 401: ${(await response.text()).slice(0, 300)}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private url(path: string): string {
    return path.startsWith("http") ? path : `${GRAPH}/users/${encodeURIComponent(this.s.mailbox)}${path}`;
  }

  private async graph(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchFn(this.url(path), {
      ...init,
      headers: { Authorization: `Bearer ${await this.getToken()}`, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) throw new Error(`Microsoft Graph ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response;
  }

  private async graphJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.graph(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  /** Follows @odata.nextLink for up to MAX_PAGES pages. */
  private async list(path: string): Promise<GraphMessage[]> {
    const out: GraphMessage[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const body: { value: GraphMessage[]; "@odata.nextLink"?: string } = await this.graphJson(next);
      out.push(...body.value);
      next = body["@odata.nextLink"];
    }
    return out;
  }

  private async mime(id: string): Promise<Buffer> {
    const response = await this.graph(`/messages/${encodeURIComponent(id)}/$value`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async findByMessageId(messageId: string): Promise<GraphMessage> {
    const found = await this.list(`/messages?$filter=${encodeURIComponent(`internetMessageId eq ${odataString(messageId)}`)}&$select=${SELECT}&$top=5`);
    if (found.length === 0) throw new Error(`Message ${messageId} not found in the mailbox`);
    return found[0];
  }

  private isFromSelf(m: GraphMessage): boolean {
    return (m.from?.emailAddress?.address ?? "").toLowerCase() === this.s.mailbox.toLowerCase();
  }

  private isProcessed(m: GraphMessage): boolean {
    return (m.categories ?? []).includes(PROCESSED_LABEL);
  }

  private async toEmails(messages: GraphMessage[]): Promise<FetchedEmail[]> {
    const emails: FetchedEmail[] = [];
    for (const m of messages) {
      const email = await parseEmail(await this.mime(m.id), m.receivedDateTime ? new Date(m.receivedDateTime) : null);
      if (email) emails.push(email);
    }
    return emails;
  }

  private recent(days: number, folder = "inbox"): Promise<GraphMessage[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.list(
      `/mailFolders/${folder}/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$orderby=receivedDateTime asc&$select=${SELECT}&$top=100`,
    );
  }

  // ─── MailProvider ─────────────────────────────────────────────────────────────────────────

  async checkLogin(): Promise<void> {
    await this.graphJson("/mailFolders/inbox?$select=id");
  }

  async fetchUnprocessed(limit: number): Promise<FetchedEmail[]> {
    const keywords = this.s.subjectKeywords.map((k) => k.toLowerCase());
    const wanted = (await this.recent(UNPROCESSED_DAYS)).filter(
      (m) =>
        !this.isProcessed(m) &&
        (this.s.includeSelf || !this.isFromSelf(m)) &&
        (keywords.length === 0 || keywords.some((k) => (m.subject ?? "").toLowerCase().includes(k))),
    );
    // Oldest first (the list is ordered by arrival).
    return this.toEmails(wanted.slice(0, limit));
  }

  async fetchProcessed(options: { days: number; messageId?: string; limit: number }): Promise<FetchedEmail[]> {
    if (options.messageId) return this.toEmails([await this.findByMessageId(options.messageId)]);
    const done = (await this.recent(options.days)).filter((m) => this.isProcessed(m));
    return this.toEmails(done.slice(0, options.limit));
  }

  async fetchAttachments(messageId: string): Promise<RawAttachment[]> {
    const message = await this.findByMessageId(messageId);
    return parseAttachments(await this.mime(message.id));
  }

  async labelProcessed(messageId: string): Promise<void> {
    const message = await this.findByMessageId(messageId);
    const categories = [...new Set([...(message.categories ?? []), PROCESSED_LABEL])];
    await this.graphJson(`/messages/${encodeURIComponent(message.id)}`, { method: "PATCH", body: JSON.stringify({ categories }) });
  }

  /** Drafts in this conversation that answer `messageId` (their In-Reply-To is the original's Message-ID). */
  private async draftsAnswering(conversationIds: Set<string>, messageIds: Set<string>): Promise<GraphMessage[]> {
    const drafts = await this.list(`/mailFolders/drafts/messages?$select=${SELECT}&$top=100`);
    const found: GraphMessage[] = [];
    for (const d of drafts) {
      if (!d.conversationId || !conversationIds.has(d.conversationId)) continue;
      if (messageIds.has(await inReplyToOf(await this.mime(d.id)))) found.push(d);
    }
    return found;
  }

  async saveReplyDraft(original: FetchedEmail, content: ReplyContent, options: { replaceExisting?: boolean } = {}): Promise<boolean> {
    const message = await this.findByMessageId(original.messageId);
    const existing = await this.draftsAnswering(new Set([message.conversationId ?? ""]), new Set([original.messageId]));
    if (existing.length > 0) {
      // Drafts only (sent replies are in Sent Items), so replacing never loses a sent message.
      if (!options.replaceExisting) return false;
      for (const d of existing) await this.graph(`/messages/${encodeURIComponent(d.id)}`, { method: "DELETE" });
    }
    const raw = await buildReplyMime(this.address, original, content);
    // "Create message from MIME": the body is the base64 MIME message; the result is a draft.
    await this.graph("/messages", { method: "POST", headers: { "Content-Type": "text/plain" }, body: raw.toString("base64") });
    return true;
  }

  async hasUnsentDraft(original: FetchedEmail): Promise<boolean> {
    const message = await this.findByMessageId(original.messageId);
    const drafts = await this.list(`/mailFolders/drafts/messages?$select=${SELECT}&$top=100`);
    return drafts.some((d) => d.conversationId && d.conversationId === message.conversationId);
  }

  async sendNotice(to: string, subject: string, text: string): Promise<void> {
    await this.graphJson("/sendMail", {
      method: "POST",
      body: JSON.stringify({
        message: { subject, body: { contentType: "Text", content: text }, toRecipients: [{ emailAddress: { address: to } }] },
        saveToSentItems: false,
      }),
    });
  }

  async trashTestMail(options: { dryRun: boolean; testSenders?: string[] }): Promise<TestMailResult> {
    const summary = (m: GraphMessage): MailSummary => ({
      date: m.receivedDateTime ?? "",
      from: m.from?.emailAddress?.address ?? "",
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").join(", "),
      subject: m.subject ?? "",
    });
    const self = this.s.mailbox.toLowerCase();
    const testers = new Set((options.testSenders ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));

    const inbox = await this.recent(30);
    const tests = inbox.filter((m) => {
      const from = (m.from?.emailAddress?.address ?? "").toLowerCase();
      const toSelf = (m.toRecipients ?? []).some((r) => (r.emailAddress?.address ?? "").toLowerCase() === self);
      const selfTest = from === self && toSelf && (this.isProcessed(m) || (m.subject ?? "").includes("TEST-RFQ"));
      return selfTest || (testers.has(from) && this.isProcessed(m));
    });
    const testIds = new Set(tests.map((m) => m.id));
    const customer = inbox.filter((m) => !testIds.has(m.id) && !this.isFromSelf(m) && this.isProcessed(m));

    const drafts = await this.draftsAnswering(
      new Set(tests.map((m) => m.conversationId ?? "")),
      new Set(tests.map((m) => m.internetMessageId ?? "")),
    );

    if (!options.dryRun) {
      for (const m of tests) {
        await this.graphJson(`/messages/${encodeURIComponent(m.id)}/move`, { method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }) });
      }
      for (const d of drafts) await this.graph(`/messages/${encodeURIComponent(d.id)}`, { method: "DELETE" });
    }
    return { trashed: tests.map(summary), draftsDeleted: drafts.map(summary), keptCustomerEmails: customer.map(summary) };
  }
}
