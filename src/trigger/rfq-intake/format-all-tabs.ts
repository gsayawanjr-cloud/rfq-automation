import { logger, task } from "@trigger.dev/sdk";
import { liveConfig } from "./config.js";
import { INVENTORY_TABLE } from "./inventory.js";
import { ORDERS_TABLE } from "./orders.js";
import { QUOTATIONS_TABLE } from "./quote.js";
import { RFQ_TABLE, SheetClient } from "./sheet.js";
import { formatHiddenTab, formatStateTab, STATE_TAB } from "./state.js";
import { USAGE_TAB, USAGE_WIDTHS } from "./usage.js";
import { ALERTS_TAB, ALERTS_WIDTHS } from "./alerts.js";

/**
 * Manual: re-applies the layout to every tab without changing data — wrapped text, columns sized
 * to their content, row heights to match. The hidden state tab gets its compact format instead.
 * Tabs that don't exist yet are skipped (they get the layout automatically when first created).
 */
export const formatAllTabs = task({
  id: "format-all-tabs",
  maxDuration: 300,
  run: async () => {
    const live = liveConfig();
    const sheet = await SheetClient.connect(live.sheet);
    const existing = await sheet.listTabs();
    const tables = [
      { title: live.sheet.tab, spec: RFQ_TABLE },
      { title: live.inventoryTab, spec: INVENTORY_TABLE },
      { title: live.quotationsTab, spec: QUOTATIONS_TABLE },
      { title: live.ordersTab, spec: ORDERS_TABLE },
    ];
    const formatted: string[] = [];
    for (const t of tables) {
      if (!existing.includes(t.title)) continue;
      const header = (await sheet.getValues(t.title, "A1:1"))[0] ?? [];
      // Only relabel when the tab's header matches the table (or the table adds columns at the end).
      if (!header.every((h, i) => t.spec.columns[i]?.header === h)) {
        throw new Error(`The ${t.title} tab's columns don't match the expected layout; not reformatting it`);
      }
      await sheet.applyLayout(await sheet.ensureTab(t.title), t.spec);
      formatted.push(t.title);
    }
    if (existing.includes(STATE_TAB)) {
      await formatStateTab(sheet);
      formatted.push(`${STATE_TAB} (hidden, compact)`);
    }
    for (const [title, widths] of [[USAGE_TAB, USAGE_WIDTHS], [ALERTS_TAB, ALERTS_WIDTHS]] as const) {
      if (!existing.includes(title)) continue;
      await formatHiddenTab(sheet, title, [...widths]);
      formatted.push(`${title} (hidden, compact)`);
    }
    logger.info("Tabs formatted", { formatted });
    return { formatted };
  },
});
