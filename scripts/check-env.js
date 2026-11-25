/**
 * NOSIH environment diagnostic (read-only — no chain writes, no DB writes).
 *
 *   node scripts/check-env.js
 *
 * Validates the root .env against the backend's boot audit, derives the
 * deployer/revoker addresses, checks the frontend build-time config, and
 * probes the Amoy RPC + wallet balances so funding problems are visible
 * BEFORE any live deployment.
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const root = path.resolve(__dirname, "..");
const HEX64 = /^[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

let failures = 0;
const ok = (label, detail = "") => console.log(`PASS  ${label}${detail ? " — " + detail : ""}`);
const bad = (label, detail = "") => {
  failures += 1;
  console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`);
};
const warn = (label, detail = "") => console.log(`WARN  ${label}${detail ? " — " + detail : ""}`);

function readEnvFile(file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return {};
  const out = {};
  for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

async function main() {
  const { ethers } = require(path.join(root, "backend", "node_modules", "ethers"));

  // ── Backend boot audit (the exact gate server.js uses) ──
  const { auditEnv } = await import(require("url").pathToFileURL(path.join(root, "backend", "envCheck.js")).href);
  const audit = auditEnv(process.env);
  if (audit.ok) ok("backend REQUIRED_ENV audit (Supabase, JWT, enc key, pepper)");
  else for (const p of audit.problems) bad(`${p.name}: ${p.reason}`, p.hint);

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (serviceKey.startsWith("sb_publishable_")) {
    bad("SUPABASE_SERVICE_ROLE_KEY is the PUBLISHABLE key", "paste the service_role secret from Project Settings → API");
  }

  // ── Chain keys → addresses ──
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || "";
  if (HEX64.test(deployerKey.replace(/^0x/, ""))) {
    const deployer = new ethers.Wallet(deployerKey.startsWith("0x") ? deployerKey : `0x${deployerKey}`);
    ok("DEPLOYER_PRIVATE_KEY well-formed", `deployer ${deployer.address}`);
    process.env._DEPLOYER_ADDRESS = deployer.address;
  } else bad("DEPLOYER_PRIVATE_KEY missing/malformed", "64 hex chars, without 0x");

  const revokeKey = process.env.REVOKE_PRIVATE_KEY || "";
  if (HEX64.test(revokeKey.replace(/^0x/, ""))) {
    const revoker = new ethers.Wallet(revokeKey.startsWith("0x") ? revokeKey : `0x${revokeKey}`);
    ok("REVOKE_PRIVATE_KEY well-formed", `revoker ${revoker.address}`);
    process.env._REVOKER_ADDRESS = revoker.address;
  } else bad("REVOKE_PRIVATE_KEY missing/malformed", "revocation answers 503 until it is set");

  const issuerAddress = process.env.ISSUER_ADDRESS || "";
  if (ADDRESS.test(issuerAddress)) ok("ISSUER_ADDRESS well-formed", issuerAddress);
  else warn("ISSUER_ADDRESS not set", "needed for npm run issuer:add (or pass the address as an argument)");

  if (process.env.ISSUER_PRIVATE_KEY) {
    bad("ISSUER_PRIVATE_KEY present in .env", "NOSIH never signs issuance server-side — remove it; the key belongs in MetaMask");
  }

  // ── Contract address (pending until deploy) ──
  const contract = process.env.CONTRACT_ADDRESS || "";
  if (ADDRESS.test(contract)) ok("CONTRACT_ADDRESS set", contract);
  else warn("CONTRACT_ADDRESS not set yet", "run npm run deploy:amoy -- --yes (live write, needs approval + POL)");

  // ── Frontend build-time config ──
  const fe = readEnvFile(path.join("frontend", ".env.local"));
  if (fe.REACT_APP_API_URL) ok("REACT_APP_API_URL", fe.REACT_APP_API_URL);
  else bad("REACT_APP_API_URL missing in frontend/.env.local");
  if ((fe.REACT_APP_CHAIN_ID || "80002") === (process.env.CHAIN_ID || "80002")) ok("frontend/backend chain ids agree");
  else bad("REACT_APP_CHAIN_ID != CHAIN_ID", `${fe.REACT_APP_CHAIN_ID} vs ${process.env.CHAIN_ID}`);
  if (contract && fe.REACT_APP_CONTRACT_ADDRESS && fe.REACT_APP_CONTRACT_ADDRESS.toLowerCase() !== contract.toLowerCase()) {
    bad("REACT_APP_CONTRACT_ADDRESS != CONTRACT_ADDRESS", "rebuild the frontend after deploy");
  }
  for (const [k, v] of Object.entries(fe)) {
    if (/alchemy|secret|private|jwt|sb_secret/i.test(v) || /KEY|SECRET|JWT/.test(k.replace("REACT_APP_", ""))) {
      bad(`frontend env looks secret: ${k}`, "REACT_APP_* values are public in the bundle");
    }
  }
  ok("frontend env carries no secret material");

  // ── Amoy RPC + balances (read-only) ──
  const rpc = process.env.ALCHEMY_AMOY_URL || process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
  try {
    const probe = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await probe.json();
    const chainId = Number(BigInt(json.result));
    if (chainId === 80002) ok("Amoy RPC reachable", `${rpc.replace(/\/v2\/.*/, "/v2/…")} → chain ${chainId}`);
    else bad("RPC answered a different chain", String(chainId));

    const provider = new ethers.JsonRpcProvider(rpc, 80002, { staticNetwork: true });
    for (const [label, address] of [
      ["deployer", process.env._DEPLOYER_ADDRESS],
      ["revoker", process.env._REVOKER_ADDRESS],
      ["issuer (MetaMask)", issuerAddress],
    ]) {
      if (!ADDRESS.test(address || "")) continue;
      const bal = await provider.getBalance(address);
      const pol = Number(ethers.formatEther(bal));
      if (pol > 0) ok(`${label} balance`, `${pol.toFixed(4)} POL`);
      else warn(`${label} has 0 POL`, `${address} — fund it before live writes`);
    }
  } catch (err) {
    bad("Amoy RPC probe failed", err.message);
  }

  console.log("");
  if (failures) {
    console.log(`check:env — ${failures} problem(s). Fix them before deploying.`);
    process.exit(1);
  }
  console.log("check:env — PASS (warnings above are the pending live-deploy items)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});