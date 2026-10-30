# RFQ Automation

An email agent for a marine spare-parts supplier. It reads requests for quotation (RFQs) in whatever form customers send them, confirms the details, drafts a priced quotation with a PDF, and records orders. A person approves the orders. Every email it writes is a draft that a person reviews and sends.

Built with TypeScript on [Trigger.dev](https://trigger.dev), Claude, Gmail or Microsoft 365, and Google Sheets.

## How it works

1. **Watch the inbox.** `check-rfq-inbox` checks every minute for new emails that look like RFQs (Gmail search or Microsoft Graph). Each email is processed once.
2. **Read messy input.** Claude reads plain email text and also:
   - PDFs, including scanned ones
   - photos and screenshots
   - Excel and CSV requisitions
   - Word files
   - forwarded Viber chats (where the original sender is the real requester)

   Unreadable characters are flagged with `?` instead of being guessed.
3. **Confirm before quoting.** The first reply is a **confirmation** draft that restates the items and asks open questions about anything unclear. It contains no prices. Up to three rounds are allowed before it asks a person.
4. **Quote.** Once the customer confirms, Claude matches each item to a catalog SKU. It never sees prices. Code then verifies every match, prices it from the **Inventory** tab, works out the totals and renders a PDF quotation attached to the draft.
5. **Handle replies.** A reply can become a revised quotation (R1, R2…), an order, a negotiation, a request for more information, or a lost deal.
6. **Orders need a person.** A new order shows as *Pending* in the **Orders** tab. When someone sets it to *Approved*, stock is deducted exactly once and the RFQ becomes *Won*.
7. **Follow up.** If a customer goes quiet after a draft was sent, reminder drafts are created (at most two), then the status becomes *No response*.
8. **Watch itself.** An hourly health check tests the mailbox, sheet and API key. It also tracks API usage and emails an alert before credits run out.

## Design choices

- **Never assume.** No quotation is drafted until the customer has confirmed the request. Questions are open, never leading.
- **The model never touches money.** Prices, totals and stock come only from the Inventory tab and are calculated in code.
- **Strict matching.** A part number with a `?` is never matched. Different quality grades (genuine, OEM-licensed, aftermarket) are never swapped.
- **Safe stock changes.** Order decisions run one at a time with a processing claim, so a double click can't deduct stock twice.
- **Per-client settings.** Currency, payment terms, validity, letterhead, logo, bank details and reminder timing are all settings, with no code changes needed.
- **Deploys switched off.** The deploy refuses to run unless a pause setting is chosen, so a copy is never accidentally live.

## Samples

`samples/` holds real-world style inputs with expected results in `manifest.json`: a scanned PDF requisition, an Excel requisition and a Viber screenshot.

## Project layout

```
src/trigger/rfq-intake/
  check-rfq-inbox.ts    finds new RFQs and replies
  process-rfq.ts        one email through the whole pipeline
  attachments.ts        PDF, image, Excel, CSV, Word → model input
  extract.ts            Claude: RFQ → structured items
  confirm.ts            confirmation drafts
  quote.ts, pdf.ts      SKU matching, pricing, PDF quotation
  reply.ts, orders.ts   customer replies, orders, stock
  followups.ts          reminder drafts
  health-check.ts       hourly self-check and alerts
  gmail.ts, outlook.ts  mail providers
```

## Running it

[CLIENT_SETUP.md](CLIENT_SETUP.md) walks through setting it up for a new client: accounts, catalog import (with a dry run), a full test journey and going live. Microsoft 365 setup is in [OUTLOOK_SETUP.md](OUTLOOK_SETUP.md).
