import { existsSync, readFileSync } from "node:fs";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

// Values that must never be shown in the dashboard after upload.
const SECRET_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "RFQ_GMAIL_APP_PASSWORD",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "MS_CLIENT_SECRET",
  "ALERT_GMAIL_APP_PASSWORD",
]);

/**
 * On a production deploy, uploads the local .env to the production environment so the two never
 * drift. TRIGGER_SECRET_KEY is dev-only, and RFQ_GMAIL_QUERY_PRODUCTION replaces RFQ_GMAIL_QUERY
 * (locally that stays a test-only filter). Without a local .env (e.g. CI), nothing is synced.
 */
function productionEnvVars() {
  if (!existsSync(".env")) return undefined;
  const env = Object.fromEntries(
    readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
  if (!env.RFQ_GMAIL_QUERY_PRODUCTION) throw new Error("Set RFQ_GMAIL_QUERY_PRODUCTION in .env before deploying");
  env.RFQ_GMAIL_QUERY = env.RFQ_GMAIL_QUERY_PRODUCTION;
  delete env.RFQ_GMAIL_QUERY_PRODUCTION;
  // RFQ_PAUSED_PRODUCTION=true deploys the agent switched off: the schedules do nothing until it is
  // set to false in the production environment. Required, so a deploy is never accidentally live.
  if (!["true", "false"].includes((env.RFQ_PAUSED_PRODUCTION ?? "").toLowerCase())) {
    throw new Error("Set RFQ_PAUSED_PRODUCTION=true (deploy switched off) or false (deploy live) in .env before deploying");
  }
  env.RFQ_PAUSED = env.RFQ_PAUSED_PRODUCTION;
  delete env.RFQ_PAUSED_PRODUCTION;
  delete env.RFQ_PAUSED_LOCAL;
  // Local-only test switch; production never includes the agent's own mail.
  delete env.RFQ_OUTLOOK_INCLUDE_SELF;
  delete env.TRIGGER_SECRET_KEY;

  return Object.entries(env)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ({ name, value, isSecret: SECRET_VARS.has(name) }));
}

export default defineConfig({
  // Your project ref from cloud.trigger.dev → Project settings (looks like "proj_abc123").
  // Use a separate Trigger.dev project from newsletter-demo: deploying replaces every task in a project.
  project: "proj_cwbmziltuzprhlsbafsc",
  dirs: ["./src/trigger"],
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    // pdfkit reads its built-in font files from its own package folder at runtime, which bundling breaks.
    external: ["pdfkit"],
    extensions: [syncEnvVars(({ environment }) => (environment === "prod" ? productionEnvVars() : undefined))],
  },
});
