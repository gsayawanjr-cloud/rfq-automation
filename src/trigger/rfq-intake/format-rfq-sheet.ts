import { logger, task } from "@trigger.dev/sdk";
import { liveConfig } from "./config.js";
import { formatRfqSheet } from "./sheet.js";

/** Manual: re-applies the table layout to the RFQ tab. New tabs get it automatically. */
export const formatRfqSheetTask = task({
  id: "format-rfq-sheet",
  maxDuration: 120,
  run: async (payload: { removeTestRows?: boolean }) => {
    const live = liveConfig();
    const result = await formatRfqSheet(live.sheet, payload.removeTestRows === true);
    logger.info("RFQ sheet formatted", result);
    return result;
  },
});
