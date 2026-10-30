import type { AiConfig } from "./config.js";
import { SheetClient, type SheetAccess } from "./sheet.js";
import { formatHiddenTab } from "./state.js";

export const USAGE_TAB = "_usage";
const HEADER = ["Date", "Model", "Claude calls", "Input tokens", "Output tokens", "Estimated cost (USD)", "Email subject"];
export const USAGE_WIDTHS = [160, 150, 90, 100, 100, 130, 360];

// USD per million tokens. From third-party price trackers, not Anthropic's pricing page: check them
// there, and set CLAUDE_PRICE_IN_PER_MTOK / CLAUDE_PRICE_OUT_PER_MTOK to override. Unknown models are
// priced like Opus, so the estimate errs on the high side.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
};
const FALLBACK = PRICES["claude-opus-5-5"];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const override = { in: Number(process.env.CLAUDE_PRICE_IN_PER_MTOK), out: Number(process.env.CLAUDE_PRICE_OUT_PER_MTOK) };
  const price = override.in > 0 && override.out > 0 ? override : PRICES[model] ?? FALLBACK;
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}

/** One row per run that called Claude, in the hidden usage tab. Never throws: tracking must not break a run. */
export async function logUsage(access: SheetAccess, ai: AiConfig, subject: string): Promise<void> {
  if (ai.usage.calls === 0) return;
  try {
    const sheet = await SheetClient.connect(access);
    await sheet.ensureTab(USAGE_TAB, { hidden: true });
    if ((await sheet.getValues(USAGE_TAB, "A1:A1")).length === 0) {
      await sheet.putValues(USAGE_TAB, "A1", [HEADER]);
      await formatHiddenTab(sheet, USAGE_TAB, USAGE_WIDTHS);
    }
    const cost = estimateCostUsd(ai.model, ai.usage.inputTokens, ai.usage.outputTokens);
    await sheet.appendValues(USAGE_TAB, [
      [new Date().toISOString(), ai.model, ai.usage.calls, ai.usage.inputTokens, ai.usage.outputTokens, Math.round(cost * 10000) / 10000, subject.slice(0, 200)],
    ]);
  } catch {
    // Best effort.
  }
}

/** Estimated spend since `fromDate` (YYYY-MM-DD), from the usage tab. */
export async function spendSince(access: SheetAccess, fromDate: string): Promise<number> {
  const sheet = await SheetClient.connect(access);
  let rows: string[][];
  try {
    rows = await sheet.getValues(USAGE_TAB, "A2:F");
  } catch {
    return 0;
  }
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  return rows.filter((r) => Date.parse(r[0]) >= from).reduce((sum, r) => sum + (Number(r[5]) || 0), 0);
}
