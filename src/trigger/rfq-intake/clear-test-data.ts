import { logger, task } from "@trigger.dev/sdk";
import { liveConfig } from "./config.js";
import { ORDERS_TABLE } from "./orders.js";
import { QUOTATIONS_TABLE } from "./quote.js";
import { RFQ_TABLE, SheetClient, type TableSpec } from "./sheet.js";
import { formatHiddenTab, formatStateTab, STATE_TAB } from "./state.js";
import { USAGE_TAB, USAGE_WIDTHS } from "./usage.js";
import { ALERTS_TAB, ALERTS_WIDTHS } from "./alerts.js";

const ROW_HEIGHT = 21;

/**
 * Manual: wipes test data. Test emails (sent from this inbox to itself) go to Gmail Trash and their
 * drafts are deleted; the RFQs, Quotations, Orders and hidden state tabs keep only their header.
 * The Inventory tab is never touched. Without `confirm: true` it only lists what it would remove.
 * `testSenders` adds other addresses used for testing (their processed emails are removed too).
 * `includeUsage` also empties the hidden usage log (test spend) so cost tracking starts fresh.
 */
export const clearTestData = task({
  id: "clear-test-data",
  maxDuration: 300,
  run: async (payload: { confirm?: boolean; testSenders?: string[]; includeUsage?: boolean }) => {
    const dryRun = payload.confirm !== true;
    const live = liveConfig();

    const mail = await live.mail.trashTestMail({ dryRun, testSenders: payload.testSenders });

    const sheet = await SheetClient.connect(live.sheet);
    const existing = await sheet.listTabs();
    const tabs: { title: string; spec?: TableSpec; hiddenWidths?: number[] }[] = [
      { title: live.sheet.tab, spec: RFQ_TABLE },
      { title: live.quotationsTab, spec: QUOTATIONS_TABLE },
      { title: live.ordersTab, spec: ORDERS_TABLE },
      { title: STATE_TAB },
      { title: ALERTS_TAB, hiddenWidths: ALERTS_WIDTHS },
      ...(payload.includeUsage ? [{ title: USAGE_TAB, hiddenWidths: USAGE_WIDTHS }] : []),
    ];
    const rows: Record<string, number> = {};
    for (const t of tabs) {
      if (!existing.includes(t.title)) continue;
      rows[t.title] = Math.max(0, (await sheet.getValues(t.title, "A:A")).length - 1);
      if (dryRun || rows[t.title] === 0) continue;
      await sheet.clearValues(t.title, "A2:ZZ");
      const tab = await sheet.ensureTab(t.title);
      // Cleared rows keep their old heights; reset them, then let the layout size the header again.
      await sheet.batchUpdate([
        {
          updateDimensionProperties: {
            range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 1 },
            properties: { pixelSize: ROW_HEIGHT },
            fields: "pixelSize",
          },
        },
      ]);
      if (t.spec) await sheet.applyLayout(tab, t.spec);
      else if (t.hiddenWidths) await formatHiddenTab(sheet, t.title, t.hiddenWidths);
      else await formatStateTab(sheet);
    }

    const result = {
      dryRun,
      emailsToTrash: mail.trashed.length,
      draftsToDelete: mail.draftsDeleted.length,
      sheetRowsToClear: rows,
      emails: mail.trashed,
      drafts: mail.draftsDeleted,
      // Customer emails are never removed; listed so nothing real is mistaken for test data.
      keptCustomerEmails: mail.keptCustomerEmails,
    };
    logger.info(dryRun ? "Dry run: nothing removed" : "Test data cleared", { ...result, emails: undefined, drafts: undefined });
    return result;
  },
});
