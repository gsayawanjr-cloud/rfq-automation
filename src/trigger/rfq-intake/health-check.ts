import { logger, schedules, task } from "@trigger.dev/sdk";
import { alertRunFailure, sendAlert } from "./alerts.js";
import { anthropicClient, anthropicConfig, isPaused, liveConfig } from "./config.js";
import { SheetClient } from "./sheet.js";
import { spendSince } from "./usage.js";

const STUCK_AFTER_MINUTES = 30;
const CREDIT_WARN_PERCENT = 80;

/**
 * Checks everything the agent depends on and emails the owner about problems. `simulate` is for
 * testing the alert path without breaking anything real.
 */
export async function runHealthCheck(options: { simulate?: "credits" } = {}) {
  const live = liveConfig();
  const problems: string[] = [];
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${name}: ${(error as Error).message.slice(0, 120)}`);
      await alertRunFailure(`health-check (${name})`, error, {});
    }
  };

  if (options.simulate === "credits") {
    await check("Anthropic (simulated)", async () => {
      throw Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
    });
    return { problems };
  }

  await check("mailbox login", () => live.mail.checkLogin());
  await check("Google Sheet", async () => (await SheetClient.connect(live.sheet)).getValues(live.sheet.tab, "A1:A1"));
  await check("Anthropic API", async () => {
    await anthropicClient(anthropicConfig()).models.list({ limit: 1 });
  });

  // Emails that should have been handled by now but weren't (a failing run, or the agent is stuck).
  let stuck = 0;
  try {
    const waiting = await live.mail.fetchUnprocessed(25);
    stuck = waiting.filter((e) => Date.now() - Date.parse(e.receivedAt) > STUCK_AFTER_MINUTES * 60_000).length;
    if (stuck > 0) {
      problems.push(`${stuck} email(s) waiting more than ${STUCK_AFTER_MINUTES} minutes`);
      await sendAlert({
        kind: "stuck-mail",
        subject: `${stuck} customer email(s) are waiting unprocessed`,
        body: `${stuck} email(s) have been in the inbox for more than ${STUCK_AFTER_MINUTES} minutes without being handled.\n\nThe agent may be failing on them, paused, or stopped. Check the latest runs in the Trigger.dev dashboard.`,
      });
    }
  } catch {
    // The mailbox check above already raised this.
  }

  // Early warning from our own spend estimate (Anthropic has no balance API for normal keys).
  let spent: number | null = null;
  const budget = Number(process.env.ANTHROPIC_CREDIT_USD);
  const from = process.env.CREDIT_COUNT_FROM;
  if (budget > 0 && from) {
    spent = await spendSince(live.sheet, from);
    const percent = (spent / budget) * 100;
    if (percent >= CREDIT_WARN_PERCENT) {
      problems.push(`estimated ${percent.toFixed(0)}% of credits used`);
      await sendAlert({
        kind: "credit-estimate",
        subject: `Anthropic credits are about ${percent.toFixed(0)}% used (estimate)`,
        body: `By the agent's own count it has used about USD ${spent.toFixed(2)} of the USD ${budget.toFixed(2)} loaded since ${from}.\n\nThis is an estimate from token counts; the real balance is at console.anthropic.com. Top up before it runs out, or the agent stops quoting.`,
      });
    }
  }
  return { problems, stuck, spentUsd: spent };
}

export const healthCheck = schedules.task({
  id: "health-check",
  // Hourly, on the hour. window "0m": no random delay.
  cron: { pattern: "0 * * * *", window: "0m" },
  queue: { concurrencyLimit: 1 },
  maxDuration: 120,
  run: async () => {
    if (isPaused()) {
      logger.info("Agent is paused; skipping health check");
      return { paused: true };
    }
    return runHealthCheck();
  },
});

/** Manual: runs the health check now. `simulate: "credits"` sends a pretend "credits out" alert. */
export const healthCheckNow = task({
  id: "health-check-now",
  maxDuration: 120,
  run: async (payload: { simulate?: "credits" }) => runHealthCheck({ simulate: payload.simulate }),
});
