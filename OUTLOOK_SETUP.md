# Connecting a Microsoft 365 (Outlook) mailbox

The agent reads and drafts in a Microsoft 365 work mailbox through Microsoft Graph. No mailbox password is stored: a small "app registration" in the company's Microsoft Entra (Azure AD) signs in for the agent. A company admin has to approve it once.

You need: a Microsoft 365 work or school mailbox for the agent (for example `rfq@company.com`) and someone who can act as **Global Administrator** or **Application Administrator** in that tenant.

## 1. Register the app (Azure portal)

1. Go to https://entra.microsoft.com and sign in as the admin.
2. **Identity -> Applications -> App registrations -> New registration.**
3. Name: `RFQ Agent`. Supported account types: **Accounts in this organizational directory only**. Leave Redirect URI empty. Click **Register**.
4. On the overview page, copy:
   - **Application (client) ID** -> `MS_CLIENT_ID`
   - **Directory (tenant) ID** -> `MS_TENANT_ID`

## 2. Give it permission to use mail

1. **API permissions -> Add a permission -> Microsoft Graph -> Application permissions.**
2. Add **Mail.ReadWrite** (read mail, create drafts, set the `rfq-processed` category) and **Mail.Send** (only used for alert emails to the owner; skip it if alerts go through a separate Gmail sender).
3. Click **Grant admin consent for <company>** and confirm. The status column should show a green tick for both.

## 3. Create a client secret

1. **Certificates & secrets -> New client secret.** Description `rfq-agent`, choose the longest expiry offered (24 months at most).
2. Copy the secret **Value** immediately (it is shown only once) -> `MS_CLIENT_SECRET`.
3. Write the expiry date in your calendar. When it expires the agent loses access; the health check then emails "The agent can't sign in to the mailbox".

## 4. Limit the app to that one mailbox (strongly recommended)

By default an app with `Mail.ReadWrite` can reach **every** mailbox in the company. The admin should restrict it to the agent's mailbox with an Exchange Application Access Policy. In PowerShell, connected with `Connect-ExchangeOnline`:

```powershell
New-DistributionGroup -Name "RFQ Agent Mailboxes" -Type Security -Members rfq@company.com
New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -PolicyScopeGroupId "RFQ Agent Mailboxes" -AccessRight RestrictAccess -Description "RFQ agent: agent mailbox only"
Test-ApplicationAccessPolicy -Identity rfq@company.com -AppId <MS_CLIENT_ID>   # AccessCheckResult: Granted
Test-ApplicationAccessPolicy -Identity someone.else@company.com -AppId <MS_CLIENT_ID>   # AccessCheckResult: Denied
```

The policy can take up to an hour to apply.

## 5. Set the environment variables

In the agent's `.env` (and so in the cloud on deploy):

```
MAIL_PROVIDER=outlook
MS_TENANT_ID=<directory (tenant) id>
MS_CLIENT_ID=<application (client) id>
MS_CLIENT_SECRET=<secret value>
MS_MAILBOX=rfq@company.com
# Only emails whose subject contains one of these are picked up (case-insensitive):
RFQ_OUTLOOK_SUBJECT_KEYWORDS=RFQ,quote,quotation,enquiry,inquiry,spares,requisition,viber
```

The Gmail variables (`RFQ_GMAIL_USER`, `RFQ_GMAIL_APP_PASSWORD`, `RFQ_GMAIL_QUERY*`) are not used with Outlook.

For testing with mail sent from the mailbox to itself, add `RFQ_OUTLOOK_INCLUDE_SELF=true` locally. It is never uploaded to production.

## What differs from Gmail

- **Label** = an Outlook **category** named `rfq-processed` (visible on the message).
- **Drafts** appear in the mailbox's Drafts folder, threaded to the customer's email.
- Only mail from the last 2 days is checked, like Gmail.
- Alerts: with `ALERT_EMAIL_TO` set, alert emails are sent from the agent mailbox through Graph. For alerts that still work when the mailbox login itself breaks, set a separate Gmail sender (`ALERT_GMAIL_USER`, `ALERT_GMAIL_APP_PASSWORD`).

## Checklist before going live

- [ ] Admin consent granted (green ticks), access policy tested (granted for the agent mailbox, denied for others)
- [ ] Client secret expiry date noted
- [ ] A test email with "RFQ" in the subject produces a draft reply and a sheet row
- [ ] The processed email shows the `rfq-processed` category
- [ ] Health check passes (`health-check-now` task)
