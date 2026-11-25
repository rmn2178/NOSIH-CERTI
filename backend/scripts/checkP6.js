/**
 * P6 offline gate — issuance handshake wiring, NO live services.
 *
 * Proves:
 *  - the Express app boots with the certificates router mounted and the
 *    legacy land routes retired (404) and the P7 public verify mounted
 *  - every issuance endpoint demands authentication (401 before any work)
 *  - a valid JWT passes protect and surfaces the DB outage as 500 (never a
 *    simulated success)
 *  - source-level security invariants: no server-side issuance signing,
 *    tx persisted BEFORE verification, idempotent confirm, recovery payload,
 *    fail-fast contract config, browser-only signing in the frontend
 *  - the frontend wallet/contract services load and expose the right surface
 *
 * The real chain behavior is proven by test/IssuanceHandshake.test.js (32/32).
 * The LIVE DB handshake (double-confirm, reconciliation) runs with credentials
 * (task #16). Run: node backend/scripts/checkP6.js
 */

import crypto from "crypto";
// Format-valid Supabase values so the env audit passes; a fetch-level stand-in
// below refuses every Supabase request, so the gate stays fully offline and
// the DB outage is deterministic (no external network is touched).
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://offline-gate.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "offline-gate-" + crypto.randomBytes(24).toString("hex");
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(24).toString("hex");
process.env.DOCUMENT_ENC_KEY = process.env.DOCUMENT_ENC_KEY || crypto.randomBytes(32).toString("hex");
process.env.HASH_PEPPER = process.env.HASH_PEPPER || crypto.randomBytes(32).toString("hex");
process.env.VERCEL = "1"; // skip auto-listen; we bind an ephemeral port ourselves
delete process.env.CONTRACT_ADDRESS;

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(typeof input === "string" ? input : input?.url ?? "");
  if (/\.supabase\.co/.test(url)) {
    return Promise.reject(new TypeError("fetch failed (offline gate stand-in — Supabase is not configured)"));
  }
  return realFetch(input, init);
};

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import jwt from "jsonwebtoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(backendDir, "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");

const { default: app } = await import("../server.js");
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, route, { token, body, headers } = {}) => {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
};

// ── 1. Boot + route wiring ────────────────────────────────
console.log("\n[1] Boot and route wiring");

await check("health answers with config ok and database degraded (no fake success)", async () => {
  const { status, json } = await api("GET", "/api/health");
  assert(status === 503, `expected 503, got ${status}`);
  assert(json.config.ok === true, "dev env should audit clean");
  assert(json.database.ok === false, "refused DB must be reported, not hidden");
});

await check("legacy /api/land is retired (404)", async () => {
  const { status } = await api("GET", "/api/land/LAND-0000000000");
  assert(status === 404, `expected 404, got ${status}`);
});

await check("P7 verify is mounted, public, and legacy land-verify path is gone", async () => {
  // Old land route must not exist under the new public verify router.
  const legacy = await api("GET", "/api/verify/land/LAND-0000000000");
  assert(legacy.status === 404, `expected 404 for legacy path, got ${legacy.status}`);
  // New certificate verify answers publicly (no auth); without chain config
  // in this gate it must be 503 indeterminate — never a fake verdict.
  const modern = await api("GET", "/api/verify/CERT-8A91F203");
  assert(modern.status === 503, `expected 503 indeterminate, got ${modern.status}`);
});

await check("routes/land.js is deleted", () => {
  assert(!fs.existsSync(path.join(backendDir, "routes", "land.js")), "land.js still present");
});

// ── 2. Authentication gates ───────────────────────────────
console.log("\n[2] Authentication gates");

const issuerToken = jwt.sign(
  { id: crypto.randomUUID(), role: "issuer", email: "issuer@example.test", institutionId: crypto.randomUUID() },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
);

const unauthRoutes = [
  ["POST", "/api/certificates/extract"],
  ["POST", "/api/certificates/issue/prepare"],
  ["POST", "/api/certificates/issue/confirm"],
  ["GET", "/api/certificates/issue/intents/CERT-8A91F203"],
  ["GET", "/api/certificates"],
  ["GET", "/api/certificates/meta/templates"],
  ["GET", "/api/certificates/CERT-8A91F203"],
  ["GET", "/api/certificates/CERT-8A91F203/document"],
  ["GET", "/api/certificates/CERT-8A91F203/qr"],
];
for (const [method, route] of unauthRoutes) {
  await check(`${method} ${route} requires a token (401)`, async () => {
    const { status } = await api(method, route);
    assert(status === 401, `expected 401, got ${status}`);
  });
}

await check("an invalid token is rejected (401)", async () => {
  const { status } = await api("GET", "/api/certificates", { token: "not-a-jwt" });
  assert(status === 401, `expected 401, got ${status}`);
});

await check("a valid JWT passes protect; the DB outage surfaces as 500", async () => {
  const { status, json } = await api("GET", "/api/certificates", { token: issuerToken });
  assert(status === 500, `expected 500 (DB down), got ${status}`);
  assert(typeof json.error === "string" && json.error.length > 0, "error must be readable JSON");
});

await check("confirm validates its body shape only after auth (401 first)", async () => {
  const { status } = await api("POST", "/api/certificates/issue/confirm", { body: { garbage: true } });
  assert(status === 401, `expected 401, got ${status}`);
});

// ── 3. Source-level security invariants ───────────────────
console.log("\n[3] Source-level security invariants");

const routeSrc = read("backend/routes/certificates.js");
const chainSrc = read("backend/services/blockchain.js");
const serverSrc = read("backend/server.js");
const walletSrc = read("frontend/src/services/wallet.js");
const contractSrc = read("frontend/src/services/contract.js");

await check("the backend never signs issuance (no wallet/key in route or chain service)", () => {
  for (const [name, src] of [["certificates.js", routeSrc], ["blockchain.js", chainSrc]]) {
    assert(!/new ethers\.Wallet/.test(src) || name === "blockchain.js", `${name} constructs a wallet`);
    assert(!/ISSUER_PRIVATE_KEY/.test(src), `${name} references ISSUER_PRIVATE_KEY`);
    assert(!/\.issueCertificate\(/.test(src), `${name} calls issueCertificate (browser-only)`);
  }
  // blockchain.js may construct a Wallet ONLY for the revocation signer.
  const walletUses = chainSrc.match(/new ethers\.Wallet/g) ?? [];
  assert(walletUses.length === 1, "blockchain.js must have exactly one wallet: the revocation signer");
  assert(/REVOKE_PRIVATE_KEY/.test(chainSrc), "revocation must demand the dedicated key");
});

await check("confirm persists the claimed tx BEFORE verifying the receipt", () => {
  const confirmSection = routeSrc.slice(routeSrc.indexOf('"/issue/confirm"'));
  const persistIdx = confirmSection.indexOf('update({ tx_hash: txHash, status: "submitted" })');
  const verifyIdx = confirmSection.indexOf("verifyIssuanceReceipt({");
  assert(persistIdx > 0 && verifyIdx > 0 && persistIdx < verifyIdx, "tx must be persisted before verification");
});

await check("confirm is idempotent and reconciles post-chain DB failures", () => {
  assert(/alreadyConfirmed/.test(routeSrc), "missing idempotent confirmed path");
  assert(/isUniqueViolation\(insertErr\)/.test(routeSrc), "missing concurrent-insert handling");
  assert(/recovery/.test(routeSrc) && /Retry confirm/.test(routeSrc), "missing recovery payload");
  assert(/intent stays 'submitted'/.test(routeSrc), "missing reconciliation comment/behavior");
});

await check("prepare fails fast on missing CONTRACT_ADDRESS before any upload", () => {
  const prepareSection = routeSrc.slice(routeSrc.indexOf('"/issue/prepare"'), routeSrc.indexOf('"/issue/confirm"'));
  const configIdx = prepareSection.indexOf("getContractAddress()");
  const uploadIdx = prepareSection.indexOf("uploadToIPFS(");
  assert(configIdx > 0 && uploadIdx > 0 && configIdx < uploadIdx, "config check must precede uploads");
});

await check("prepare pins hashes and guards duplicates before creating the intent", () => {
  const prepareSection = routeSrc.slice(routeSrc.indexOf('"/issue/prepare"'), routeSrc.indexOf('"/issue/confirm"'));
  for (const needle of ["computeDocumentHash", "computeMetadataHash", "computeHolderIdentityHash", "document_hash", "certificate_number", "encryptCertificate"]) {
    assert(prepareSection.includes(needle), `prepare missing ${needle}`);
  }
  const encryptIdx = prepareSection.indexOf("encryptCertificate(");
  const uploadIdx = prepareSection.indexOf("uploadToIPFS(");
  assert(encryptIdx < uploadIdx, "plaintext must never be uploaded");
});

await check("server mounts certificates, not land", () => {
  assert(serverSrc.includes('app.use("/api/certificates"'), "certificates not mounted");
  assert(!/app\.use\("\/api\/land"/.test(serverSrc), "land still mounted");
});

await check("frontend wallet service signs only via MetaMask, handles rejections", () => {
  assert(!/privateKey/i.test(walletSrc), "wallet service must never touch private keys");
  for (const needle of ["eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain", "4001", "ACCOUNT_MISMATCH", "80002"]) {
    assert(walletSrc.includes(needle), `wallet.js missing ${needle}`);
  }
});

await check("frontend contract service issues but never revokes", () => {
  assert(/contract\.issueCertificate\(issueArgs\)/.test(contractSrc), "issue call missing");
  assert(!/revokeCertificate/.test(contractSrc), "revocation must stay server-side");
});

await check("generated ABI exposes issueCertificate + CertificateIssued on both sides", () => {
  for (const rel of ["backend/services/certificateRegistryABI.js", "frontend/src/utils/contractABI.js"]) {
    const src = read(rel);
    assert(src.includes("issueCertificate") && src.includes("CertificateIssued"), `${rel} incomplete`);
  }
});

// ── 4. Frontend services load ─────────────────────────────
console.log("\n[4] Frontend services load (syntax + resolution)");

await check("wallet.js imports cleanly and exposes the connect/sign surface", async () => {
  const wallet = await import(pathToFileURL(path.join(rootDir, "frontend/src/services/wallet.js")).href);
  for (const fn of ["connectWallet", "ensureAmoyChain", "connectAuthorizedIssuer", "classifyWalletError", "onWalletChange"]) {
    assert(typeof wallet[fn] === "function", `wallet.js missing ${fn}`);
  }
  assert(wallet.AMOY_CHAIN_ID === 80002, "default chain must be Amoy 80002");
  const rejected = wallet.classifyWalletError({ code: 4001, message: "User rejected the request." });
  assert(rejected.code === "USER_REJECTED", "4001 must map to USER_REJECTED");
});

await check("contract.js imports cleanly and exposes issue/read only", async () => {
  const contract = await import(pathToFileURL(path.join(rootDir, "frontend/src/services/contract.js")).href);
  assert(typeof contract.issueCertificate === "function", "issueCertificate missing");
  assert(typeof contract.readCertificate === "function", "readCertificate missing");
  assert(contract.explorerTxUrl("0xabc").includes("amoy.polygonscan.com"), "explorer link wrong");
  let missing = null;
  try { contract.getContractAddress(); } catch (err) { missing = err; }
  assert(missing?.code === "CONTRACT_MISSING", "missing address must raise CONTRACT_MISSING");
});

// ── Result ────────────────────────────────────────────────
server.close();
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
console.log("P6 offline gate: PASS");
process.exit(0);