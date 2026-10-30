import { logger, task } from "@trigger.dev/sdk";
import { liveConfig } from "./config.js";
import { addMissingInventory, seedInventory } from "./inventory.js";

/** Manual: adds catalog items that are missing from the Inventory tab, keeping current prices and stock. */
export const addMissingInventoryTask = task({
  id: "add-missing-inventory",
  maxDuration: 120,
  run: async () => {
    const live = liveConfig();
    const result = await addMissingInventory(live.sheet, live.inventoryTab);
    logger.info("Inventory items added", result);
    return result;
  },
});

/** Manual: fills the Inventory tab with the mock catalog. Use overwrite: true to replace an existing one. */
export const seedInventoryTask = task({
  id: "seed-inventory",
  maxDuration: 120,
  run: async (payload: { overwrite?: boolean }) => {
    const live = liveConfig();
    const result = await seedInventory(live.sheet, live.inventoryTab, payload.overwrite === true);
    logger.info("Inventory seeded", result);
    return result;
  },
});
