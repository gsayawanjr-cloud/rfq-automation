# Setting up the RFQ agent for a new client

Each client gets their own copy: their own mailbox, Google Sheet, API keys and Trigger.dev project. Nothing is shared between clients. Plan about half a day for the first one, less after that.

## 1. What you need from the client first

| Ask for | Why |
|---|---|
| The mailbox that receives RFQs (Gmail or Microsoft 365) and someone who can approve app access | The agent reads it and saves drafts there |
| Company name, address, phone, email, website, tax ID | Printed on the quotation PDF |
| Logo as a PNG or JPEG under 1 MB, at a public web address | Printed on the quotation PDF |
| Bank details for payment | Printed on the quotation PDF |
| Their terms: payment days, how long a quotation is valid, delivery charges, currency | Printed on every quotation |
| Their price list (Excel or Google Sheet) with part numbers, descriptions, makers, prices, stock and quality (genuine, OEM-licensed, aftermarket) | It becomes the Inventory tab |
| Who reviews and sends the drafts, and who approves orders | The agent never sends anything by itself |
| An email address for alerts | Failures and low credits are emailed there |

## 2. Accounts

1. **Anthropic API key.** Create it in the client's own Anthropic account if they pay for usage, or in yours if you bill them. Add credits (about USD 0.06 per RFQ on Sonnet 5.5). Note the credit amount and the date: the agent can warn at 80% used.
2. **Google Sheet and service account.** Create a Google Cloud project, enable the Google Sheets API, create a service account and download its JSON key. Create an empty Google Sheet and share it with the service account's email as Editor.
3. **Mailbox.**
   - Gmail: turn on IMAP, turn on 2-Step Verification, create an app password.
   - Microsoft 365: follow `OUTLOOK_SETUP.md`.
4. **Trigger.dev.** Create a new project for this client. Put its reference in `trigger.config.ts` and its development key in `.env`.

## 3. The project folder

1. Copy the agent folder, give it the client's name, and run `npm install`.
2. Copy `.env.example` to `.env` and fill it in (section 6 lists every setting). After saving `.env`, reload it in your editor without saving again, because a stale editor window can overwrite it.
3. Run `npx tsc --noEmit`. It should print nothing.

## 4. The catalog

The Inventory tab is the single source of truth for prices and stock. Edit it directly whenever prices or stock change.

1. Open the client's price list in Google Sheets (upload the Excel file to Drive and open it with Sheets) and share it with the service account.
2. Run the `import-inventory` task with `{"sourceSheetId": "<id of their sheet>", "sourceTab": "<tab name>"}`. This is a dry run. It shows which column was read for each field, how many rows would be imported, and every row it would skip, with the reason (duplicate SKU, price that is not a number, unknown quality, missing stock).
3. Fix the source sheet and repeat until the report is clean. A missing required column (description, maker, price, stock, quality) stops the import: the agent never guesses a column.
4. Run it again with `"confirm": true`. The old Inventory is copied to a hidden backup tab first.
5. Run `import-inventory` with no payload at any time to check the Inventory tab as it is.

## 5. Check, test, go live

1. Run `setup-check`. Every check should pass. Warnings tell you what is missing from the letterhead, bank details, logo and alerts.
2. **Test run.** Use `RFQ_GMAIL_QUERY=subject:TEST-RFQ` (or, for Outlook, `RFQ_OUTLOOK_INCLUDE_SELF=true`) and start the agent with `npm run dev`. Email an RFQ from another account and walk through the whole journey:
   - a confirmation draft appears (no prices);
   - reply "Confirmed" (with any answers it asked for) and a quotation draft with the PDF appears;
   - reply with an order and a PO number: the order shows as **Pending** in the Orders tab, stock has not changed;
   - set **Approval** to **Approved** in the sheet: within a minute stock drops and the RFQ turns **Won**.
3. Clear the test data with `clear-test-data` (dry run first, then `confirm: true`). It never touches the Inventory tab.
4. Restore the real filter in `.env` (`RFQ_GMAIL_QUERY_PRODUCTION` is what the cloud uses).
5. **Deploy switched off.** Keep `RFQ_PAUSED_PRODUCTION=true`, run `npx trigger.dev deploy`, then deactivate all three schedules (`check-rfq-inbox`, `health-check`, `follow-up-check`) in the Trigger.dev dashboard or through its API.
6. **Start.** Stop any local copy first (two copies on one inbox would handle the same email twice). Set `RFQ_PAUSED` to `false` in the production environment, then activate the three schedules. In the Trigger.dev dashboard, also turn on the failed-run email alert.

## 6. Settings reference

Everything is an environment variable in `.env`. Defaults keep the original wording.

| Setting | What it does | Default |
|---|---|---|
| `MAIL_PROVIDER` | `gmail` or `outlook` | gmail |
| `RFQ_GMAIL_USER`, `RFQ_GMAIL_APP_PASSWORD` | Gmail login | |
| `RFQ_GMAIL_QUERY_PRODUCTION` | Which emails count as RFQs (Gmail search) | subject words like RFQ, quote, spares |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_MAILBOX`, `RFQ_OUTLOOK_SUBJECT_KEYWORDS` | Microsoft 365 login and filter | |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `RFQ_MODEL` | Claude key and model | Opus 5.5 unless `RFQ_MODEL` is set (Sonnet 5.5 recommended) |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `RFQ_SHEET_ID` | The sheet and its key | |
| `SALES_REP_NAME`, `SALES_REP_TITLE`, `COMPANY_NAME` | Signature on every draft (the title is optional) | |
| `ALERT_EMAIL_TO` | Who gets alerts | |
| `ALERT_GMAIL_USER`, `ALERT_GMAIL_APP_PASSWORD` | A separate sender so alerts survive a mailbox login problem | agent mailbox |
| `ANTHROPIC_CREDIT_USD`, `CREDIT_COUNT_FROM` | Early low-credit warning at 80% (an estimate) | off |
| `CURRENCY` | Currency on quotations, orders and sheet headers. **Set before first use.** | USD |
| `QUOTE_VALIDITY_DAYS` | How long a quotation is valid | 30 |
| `PAYMENT_TERMS` | Printed as "Payment: ..." | 30 days from invoice date |
| `PRICE_BASIS` | The part after "Prices in USD, ..." | ex-works our warehouse, excluding taxes and duties |
| `TERMS_DELIVERY` | Delivery line, for example your free-delivery rule | none: the quotation has no delivery line until you set one |
| `TERMS_AVAILABILITY` | Availability line | subject to prior sale, lead times from order confirmation |
| `EXTRA_TERMS` | More lines, separated by `\|` | none |
| `COMPANY_ADDRESS`, `COMPANY_PHONE`, `COMPANY_EMAIL`, `COMPANY_WEBSITE`, `COMPANY_TAX_ID` | PDF letterhead | none |
| `COMPANY_LOGO_URL` | Public PNG or JPEG address (or a `data:` URL) | none |
| `BANK_DETAILS` | Payment details on the PDF, lines separated by `\|` | none |
| `ORDER_APPROVAL` | `true`: a person approves orders before stock changes. `false`: stock drops when the customer confirms | true |
| `REMINDER_DAYS_CONFIRMATION`, `REMINDER_DAYS_QUOTATION`, `MAX_REMINDERS` | When reminder drafts are made | 2, 3, 2 |
| `RFQ_PAUSED_PRODUCTION` | `true` deploys with the agent switched off | required before deploy |

## 7. How the team works with it every day

**The agent only saves drafts.** Nothing reaches a customer until a person sends it.

1. A new RFQ arrives: the agent drafts a **confirmation** email. Review it and send it. Status: *Awaiting confirmation*.
2. The customer confirms: the agent drafts the **quotation** with its PDF. Review and send. Status: *Quote drafted*. Move it to *Quoted* yourself after sending if you like.
3. The customer orders: the order appears in the **Orders** tab as *Pending*, and a draft acknowledgment is saved. Status: *Order pending*. Check stock and prices, then set **Approval** to **Approved** (stock drops once, status *Won*) or **Rejected** (nothing changes, status *Needs attention*).
4. A customer who goes quiet gets a **reminder draft** after a few days, only once your earlier draft has been sent. After the last reminder the status becomes *No response*. A later reply still works.

| Status | Meaning |
|---|---|
| New | Row created, nothing drafted yet |
| Awaiting confirmation | Confirmation drafted; waiting for the customer |
| Quote drafted | Quotation drafted |
| Awaiting info / Negotiating | The customer asked for something the agent hands to you |
| Quoted | Set by you after sending the quotation |
| Order pending | Order received; approve it in the Orders tab |
| Needs attention | The agent could not decide; please read the RFQ's History column |
| No response | Reminders sent, no answer |
| Won / Lost | Finished |

## 8. Tasks you can run by hand (Trigger.dev dashboard, Test tab)

| Task | Use it to |
|---|---|
| `setup-check` | Check the whole setup, nothing is changed |
| `import-inventory` | Check or load the price list (dry run unless `confirm: true`) |
| `health-check-now` | Test mailbox, sheet and API key now (`{"simulate":"credits"}` sends a pretend alert) |
| `follow-ups-now` | See who would get a reminder (`{"dryRun": true}`) |
| `process-order-decisions` | Apply Approved/Rejected decisions right now |
| `format-all-tabs` | Repair the layout of every tab (data is not touched) |
| `clear-test-data` | Remove test mail, drafts and sheet rows (dry run first) |
| `seed-inventory` | Fill the Inventory tab with demo data (demos only) |

## 9. When something looks wrong

- **An alert email arrived.** It says what failed and what to do. The same problem is emailed at most once every 6 hours.
- **"The Anthropic API key was rejected."** The key was revoked or deleted. Create a new one, update `.env` and the production environment.
- **"Anthropic credits have run out."** Add credits. Waiting emails are processed once they are back.
- **A customer email was not picked up.** Check it matches the filter (subject words), is less than 2 days old, and the agent is not paused.
- **Stock looks wrong.** Look at the Orders tab: each order has Stock before, Stock after and Decision on. A "processing" stamp that never finished means a run stopped part way; the agent will not redo it, so check that order's stock by hand.
- **Need to pause the agent.** Deactivate the three schedules, or set `RFQ_PAUSED` to `true` in the production environment.
