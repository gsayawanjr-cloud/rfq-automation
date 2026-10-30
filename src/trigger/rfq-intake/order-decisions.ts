import { logger, task } from "@trigger.dev/sdk";
import { alertRunFailure, sendAlert } from "./alerts.js";
import { liveConfig } from "./config.js";
import { applyOrderDecisions } from "./orders.js";

/**
 * Applies Approved / Rejected decisions made in the Orders tab. The inbox check starts it when it sees
 * one, and it can be run by hand. The queue lets only one run at a time, so two runs can never apply
 * the same decision twice (that is how stock would be deducted twice).
 */
export const processOrderDecisions = task({
  id: "process-order-decisions",
  queue: { concurrencyLimit: 1 },
  maxDuration: 120,
  onFailure: async ({ error, ctx }) => {
    await alertRunFailure("process-order-decisions", error, { runId: ctx.run.id });
  },
  run: async () => {
    const live = liveConfig();
    const result = await applyOrderDecisions(live.sheet, { inventory: live.inventoryTab, orders: live.ordersTab });
    logger.info("Order decisions", result);
    if (result.failed.length > 0) {
      await sendAlert({
        kind: "order",
        subject: `${result.failed.length} order(s) could not be processed`,
        body: `These orders have a decision in the Orders tab that could not be applied:\n${result.failed.map((f) => `- ${f.order}: ${f.reason}`).join("\n")}\n\nCheck that every SKU on the order is still in the Inventory tab and look at the order's Decision on cell. Nothing is deducted twice.`,
      });
    }
    return result;
  },
});
