#!/usr/bin/env node
/**
 * NOSIH live-write launcher.
 *
 * `hardhat run` rejects unknown CLI params (HH305), so `npm run deploy:amoy
 * -- --yes` never reached the script's own --yes guard. This wrapper consumes
 * --yes and the positional wallet/institution args itself, then hands Hardhat
 * a clean command line and passes confirmation + args through the environment:
 *   NOSIH_LIVE_WRITE=yes  NOSIH_ARG_WALLET  NOSIH_ARG_INSTITUTION
 *
 * Operator commands are unchanged:
 *   npm run deploy:amoy   -- --yes
 *   npm run issuer:add    -- --yes [0xWallet] [INST-XXXXXXXX]
 *   npm run issuer:remove -- --yes [0xWallet]
 *
 * Without --yes this refuses before Hardhat (and any network call) starts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [script, ...rest] = process.argv.slice(2);

if (!script || !/^[A-Za-z0-9_.-]+\.js$/.test(script)) {
  console.error("usage: node scripts/hardhat-live.mjs <script.js> [--yes] [0xWallet] [INST-XXXXXXXX]");
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "scripts", script))) {
  console.error(`scripts/${script} does not exist.`);
  process.exit(1);
}

const positionals = rest.filter((a) => !a.startsWith("--"));
if (!rest.includes("--yes")) {
  console.error("This writes to the LIVE Polygon Amoy ledger and spends POL.");
  console.error("Re-run with --yes once the wallet is funded and you approve the write:");
  console.error(`  npm run ${script === "deploy.js" ? "deploy:amoy" : script === "addIssuer.js" ? "issuer:add" : "issuer:remove"} -- --yes`);
  process.exit(1);
}

const env = {
  ...process.env,
  NOSIH_LIVE_WRITE: "yes",
  HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
};
if (positionals[0]) env.NOSIH_ARG_WALLET = positionals[0];
if (positionals[1]) env.NOSIH_ARG_INSTITUTION = positionals[1];

// Run Hardhat's CLI entry directly with this Node binary — no npx/shell
// quoting differences between Windows and POSIX.
const cli = path.join(root, "node_modules", "hardhat", "internal", "cli", "cli.js");
if (!fs.existsSync(cli)) {
  console.error("Hardhat is not installed — run npm install at the repo root first.");
  process.exit(1);
}
const result = spawnSync(process.execPath, [cli, "run", `scripts/${script}`, "--network", "amoy"], {
  cwd: root,
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);