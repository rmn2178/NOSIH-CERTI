/**
 * P7 offline gate — verification routes, rate limiting, revoke/reissue authz.
 * NO live services: Supabase is a deterministic fetch stand-in, the chain is
 * unconfigured (which must surface as 503, never a fake verdict).
 *
 * The chain-side truth (all 10 verdicts, both tamper modes, revoked-on-match,
 * expiry mirror, audit events) is proven against a real in-memory chain by
 * test/Verification.test.js. Run: node backend/scripts/checkP7.js
 */

import crypto from "crypto";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://offline-gate.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "offline-gate-" + crypto.randomBytes(24).toString("hex");
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(24).toString("hex");
process.env.DOCUMENT_ENC_KEY = process.env.DOCUMENT_ENC_KEY || crypto.randomBytes(32).toString("hex");
process.env.HASH_PEPPER = process.env.HASH_PEPPER || crypto.randomBytes(32).toString("hex");
process.env.VERIFY_RATE_LIMIT_PER_MIN = "10"; // small window so the 429 gate is fast
process.env.VERCEL = "1";
delete process.env.CONTRACT_ADDRESS;
delete process.env.REVOKE_PRIVATE_KEY;

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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

// ── Deterministic Supabase stand-in ──────────────────────
const USER_ID = crypto.randomUUID();
const INST_ID = crypto.randomUUID();
let standInUser = null; // set per test to exercise role gates

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const standIn = async (url, init) => {
  const method = (init?.method || "GET").toUpperCase();
  const p = url.pathname;
  if (p.startsWith("/rest/v1/users") && method === "GET") {
    let accept = "";
    try { accept = new Headers(init?.headers || {}).get("accept") || ""; } catch { /* plain object */ }
    if (accept.includes("vnd.pgrst.object")) {
      return standInUser ? json(standInUser) : json({ code: "PGRST116", message: "no rows", details: "The result contains 0 rows" }, 406);
    }
    return json(standInUser ? [standInUser] : []);
  }
  if (p.startsWith("/rest/v1/certificates") && method === "GET") {
    // maybeSingle in this postgrest-js version expects an array; [] → null row.
    return json([]);
  }
  if (p.startsWith("/rest/v1/")) return json([]);
  return json({ error: "unhandled" }, 404);
};

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input?.url ?? "");
  if (url.hostname.endsWith(".supabase.co")) return standIn(url, init);
  return realFetch(input, init);
};

const { default: app } = await import("../server.js");
const verification = await import("../services/verification.js");
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const tokenFor = (role, institutionId = null) =>
  jwt.sign({ id: USER_ID, role, email: "gate@example.test", institutionId }, process.env.JWT_SECRET, { expiresIn: "1h" });

const api = async (method, route, { token, body, headers } = {}) => {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  let jsonBody = null;
  try { jsonBody = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json: jsonBody, headers: res.headers };
};

const setUser = (role, institutionId = null) => {
  standInUser = {
    id: USER_ID,
    email: "gate@example.test",
    role,
    active: true,
    wallet_address: "0x" + "ab".repeat(20),
    institution_id: institutionId,
    institutions: institutionId
      ? { id: institutionId, institution_id: "INST-AAAAAAAA", name: "Gate University", verification_status: "approved" }
      : null,
  };
};

// ── 1. Public verify surface ─────────────────────────────
console.log("\n[1] Public verify surface (no auth, chain unconfigured → 503)");

await check("GET /api/verify/:id is public and answers 503 indeterminate without chain config", async () => {
  const { status, json: body } = await api("GET", "/api/verify/CERT-8A91F203");
  assert(status === 503, `expected 503, got ${status}`);
  assert(typeof body.error === "string", "error must be readable JSON");
});

await check("malformed certificate id is rejected with 400", async () => {
  const { status } = await api("GET", "/api/verify/LAND-0000000000");
  assert(status === 400, `expected 400, got ${status}`);
});

await check("Mode B rejects a non-PDF upload BEFORE any chain work (magic bytes)", async () => {
  const form = new FormData();
  form.append("document", new Blob([Buffer.from("definitely not a pdf")], { type: "application/pdf" }), "fake.pdf");
  const { status, json: body } = await api("POST", "/api/verify/CERT-8A91F203/tamper-check", { body: form });
  assert(status === 400, `expected 400, got ${status}`);
  assert(/magic bytes|not a PDF/i.test(body.error), body.error);
});

await check("Mode A (no file) routes to stored-document integrity (503 without chain config)", async () => {
  const { status } = await api("POST", "/api/verify/CERT-8A91F203/tamper-check");
  assert(status === 503, `expected 503, got ${status}`);
});

await check("public QR endpoint serves a PNG without chain or auth", async () => {
  const res = await fetch(base + "/api/verify/CERT-8A91F203/qr");
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(res.headers.get("content-type") === "image/png", "wrong content type");
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "not a PNG");
});

// ── 2. Rate limiting ─────────────────────────────────────
console.log("\n[2] Rate limiting (VERIFY_RATE_LIMIT_PER_MIN=10)");

await check("public verify is rate-limited: quota exhausts then 429", async () => {
  // 5 requests consumed above (verify, bad id, mode B, mode A, qr).
  let ok = 0;
  let limited = null;
  for (let i = 0; i < 20; i++) {
    const { status, headers } = await api("GET", "/api/verify/CERT-8A91F203");
    if (status === 429) { limited = { status, headers }; break; }
    ok++;
  }
  assert(ok === 5, `expected 5 more allowed requests (10 total), got ${ok}`);
  assert(limited?.status === 429, "never hit 429");
  // standardHeaders "draft-7" → combined `RateLimit: limit=10, remaining=0, reset=…`
  const rl = limited.headers.get("ratelimit") || "";
  assert(/\blimit=10\b/.test(rl), `RateLimit header missing/wrong: "${rl}"`);
});

await check("429 body is readable JSON", async () => {
  const { status, json: body } = await api("GET", "/api/verify/CERT-8A91F203");
  assert(status === 429, `expected 429, got ${status}`);
  assert(/Too many verification requests/.test(body.error), body.error);
});

// ── 3. Revoke / reissue authorization ────────────────────
console.log("\n[3] Revoke / reissue authorization (D2)");

await check("revoke requires authentication (401)", async () => {
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/revoke", { body: { reason: "fraud" } });
  assert(status === 401, `expected 401, got ${status}`);
});

await check("issuers cannot revoke (403) — admins only", async () => {
  setUser("issuer", INST_ID);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/revoke", {
    token: tokenFor("issuer", INST_ID), body: { reason: "fraud" },
  });
  assert(status === 403, `expected 403, got ${status}`);
});

await check("auditors cannot revoke (403)", async () => {
  setUser("auditor", INST_ID);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/revoke", {
    token: tokenFor("auditor", INST_ID), body: { reason: "fraud" },
  });
  assert(status === 403, `expected 403, got ${status}`);
});

await check("revoke demands a reason (400) even for admins", async () => {
  setUser("institution_admin", INST_ID);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/revoke", {
    token: tokenFor("institution_admin", INST_ID), body: {},
  });
  assert(status === 400, `expected 400, got ${status}`);
});

await check("institution admin passes the role gate (reaches certificate lookup)", async () => {
  setUser("institution_admin", INST_ID);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/revoke", {
    token: tokenFor("institution_admin", INST_ID), body: { reason: "documented fraud" },
  });
  // Stand-in has no certificates row → 404 proves authz passed, not 401/403.
  assert(status === 404, `expected 404 (row absent), got ${status}`);
});

await check("platform admin passes the role gate too", async () => {
  setUser("platform_admin", null);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/revoke", {
    token: tokenFor("platform_admin"), body: { reason: "documented fraud" },
  });
  assert(status === 404, `expected 404 (row absent), got ${status}`);
});

await check("auditors cannot start a reissue (403)", async () => {
  setUser("auditor", INST_ID);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/reissue", { token: tokenFor("auditor", INST_ID) });
  assert(status === 403, `expected 403, got ${status}`);
});

await check("issuers can start a reissue (reaches certificate lookup)", async () => {
  setUser("issuer", INST_ID);
  const { status } = await api("POST", "/api/certificates/CERT-8A91F203/reissue", { token: tokenFor("issuer", INST_ID) });
  assert(status === 404, `expected 404 (row absent), got ${status}`);
});

// ── 4. Pure decision logic (offline spot checks) ─────────
console.log("\n[4] Decision logic spot checks");

await check("revoked wins over every matching fingerprint", () => {
  const chain = { documentHash: "0xaa", metadataHash: "0xbb", issuer: "0xc", institutionIdHash: "0xd", ipfsCID: "cid", revoked: true, expiresAt: 0 };
  const row = { document_hash: "0xaa", metadata_hash: "0xbb", issuer_wallet: "0xc", institution_id_hash: "0xd", ipfs_cid: "cid" };
  const { verdict } = verification.decideVerdict({ chain, row });
  assert(verdict === "revoked", verdict);
});

await check("a database row alone can never be authentic", () => {
  const { verdict } = verification.decideVerdict({ chain: null, row: { certificate_id: "CERT-8A91F203" } });
  assert(verdict === "db-chain-mismatch", verdict);
});

await check("tamper verdicts: exact / modified / revoked-on-match / not-found", () => {
  const chain = { documentHash: "0x" + "ab".repeat(32), revoked: false, expiresAt: 0 };
  assert(verification.tamperVerdict({ chain, row: null, uploadedHash: chain.documentHash }).verdict === "exact-match");
  assert(verification.tamperVerdict({ chain, row: null, uploadedHash: "0x" + "cd".repeat(32) }).verdict === "modified");
  assert(verification.tamperVerdict({ chain: { ...chain, revoked: true }, row: null, uploadedHash: chain.documentHash }).verdict === "revoked");
  assert(verification.tamperVerdict({ chain: null, row: null, uploadedHash: "0x" + "ab".repeat(32) }).verdict === "not-found");
});

// ── 5. Source-level invariants ───────────────────────────
console.log("\n[5] Source-level invariants");

const verifySvc = read("backend/services/verification.js");
const verifyRoute = read("backend/routes/verify.js");
const certRoute = read("backend/routes/certificates.js");
const serverSrc = read("backend/server.js");

await check("verification is chain-FIRST (chain read before any DB read)", () => {
  const section = verifySvc.slice(verifySvc.indexOf("export async function verifyCertificate"));
  const chainIdx = section.indexOf("readCertificate(");
  const dbIdx = section.indexOf("fetchRow(");
  assert(chainIdx > 0 && dbIdx > 0 && chainIdx < dbIdx, "DB read precedes chain read");
});

await check("no AI anywhere in integrity checking", () => {
  assert(!/gemini|generative|ocr|tesseract/i.test(verifySvc), "verification imports AI/OCR");
});

await check("public payload excludes identifiers, extras and encryption details", () => {
  const fn = verifySvc.slice(verifySvc.indexOf("function publicCertificate"), verifySvc.indexOf("function buildPayload"));
  for (const forbidden of ["holder_identifier", "extra_data", "encryption", "holder_identity_hash"]) {
    assert(!fn.includes(forbidden), `publicCertificate exposes ${forbidden}`);
  }
});

await check("verify routes are public and rate-limited", () => {
  assert(/rateLimit\(/.test(verifyRoute), "rate limiter missing");
  assert(!/protect/.test(verifyRoute), "public verify must not demand auth");
  assert(serverSrc.includes('app.use("/api/verify"'), "verify not mounted");
  assert(/trust proxy/.test(serverSrc), "trust proxy missing (rate-limit IP correctness)");
});

await check("revoke uses the dedicated key path and keeps the reason private", () => {
  const section = certRoute.slice(certRoute.indexOf('"/:certificateId/revoke"'));
  assert(section.includes('requireRoles("platform_admin", "institution_admin")'), "wrong revoke roles");
  assert(section.includes("computeRevocationReasonHash"), "reason must be keyed-hashed");
  assert(section.includes("revokeCertificateOnChain"), "chain revocation missing");
  assert(/reason: value\.reason, \/\/ private/.test(section), "private reason must go to the audit event");
});

await check("legacy land code is fully retired", () => {
  for (const rel of ["backend/services/ai.js", "backend/services/deedStorage.js", "backend/services/landIdentity.js", "backend/routes/land.js"]) {
    assert(!fs.existsSync(path.join(rootDir, rel)), `${rel} still present`);
  }
  const supabaseSrc = read("backend/supabase.js");
  assert(!/ownerFromRow|landRecordFromRow/.test(supabaseSrc), "land mappers remain");
  assert(!/generateLandQr|buildVerifyUrl\(/.test(read("backend/services/qr.js")), "land QR remains");
});

// ── Result ────────────────────────────────────────────────
server.close();
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
console.log("P7 offline gate: PASS");
process.exit(0);