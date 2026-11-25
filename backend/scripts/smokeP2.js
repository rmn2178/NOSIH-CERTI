/**
 * P2 LIVE smoke gate — requires the migration applied + a running backend
 * with real Supabase credentials, and ADMIN_EMAIL/ADMIN_PASSWORD seeded
 * (npm run seed:admin).
 *
 * Proves the full authorization story over HTTP:
 *   login/me → institution apply (×2) → approve A → wallet add on A →
 *   issuer account creation → cross-institution access DENIED →
 *   unapproved-institution wallet add DENIED → platform-only status DENIED.
 *
 * Cleans up ONLY the rows it created (test institutions/users/wallets).
 * Land data and existing accounts are never touched.
 *
 * Run: node backend/scripts/smokeP2.js   (BASE_URL defaults to http://localhost:5000)
 */
import "../env.js"; // loads the repository-root .env — must come first
import crypto from "crypto";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:5000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("❌ ADMIN_EMAIL / ADMIN_PASSWORD missing in root .env — seed the platform admin first.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const created = { institutions: [], users: [], wallets: [] };

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

async function step(name, fn) {
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
const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
const walletA = "0x" + crypto.randomBytes(20).toString("hex");
const walletB = "0x" + crypto.randomBytes(20).toString("hex");

console.log(`\nP2 live smoke against ${BASE_URL}\n`);

// ── Health + platform admin login ─────────────────────────
let adminToken = null;
await step("GET /api/health is 200", async () => {
  const { status, data } = await api("GET", "/api/health");
  assert(status === 200, `health ${status}: ${JSON.stringify(data)}`);
});

await step("platform admin login + /me", async () => {
  const { status, data } = await api("POST", "/api/auth/login", {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  assert(status === 200, `login ${status}: ${JSON.stringify(data)}`);
  assert(data.user.role === "platform_admin", `role is ${data.user.role}`);
  adminToken = data.token;
  const me = await api("GET", "/api/auth/me", { token: adminToken });
  assert(me.status === 200 && me.data.email === ADMIN_EMAIL.toLowerCase(), "/me failed");
});

// ── Institution applications ──────────────────────────────
const instA = { email: `smoke-a-${suffix}@example.com`, password: `SmokePass-${suffix}!` };
const instB = { email: `smoke-b-${suffix}@example.com`, password: `SmokePass-${suffix}!` };
let aId = null, bId = null, aAdminToken = null, bAdminToken = null;

await step("institution A applies (pending)", async () => {
  const { status, data } = await api("POST", "/api/institutions/apply", {
    body: {
      name: `Smoke Institute A ${suffix}`,
      registrationNumber: `SMOKE-REG-A-${suffix}`,
      adminEmail: instA.email,
      adminPassword: instA.password,
    },
  });
  assert(status === 201, `apply ${status}: ${JSON.stringify(data)}`);
  assert(data.institution.verificationStatus === "pending", "not pending");
  assert(/^INST-[0-9A-F]{8}$/.test(data.institution.institutionId), "bad INST id");
  aId = data.institution.id;
  created.institutions.push(aId);
  created.users.push(data.admin.id);
});

await step("institution B applies (stays unapproved)", async () => {
  const { status, data } = await api("POST", "/api/institutions/apply", {
    body: {
      name: `Smoke Institute B ${suffix}`,
      registrationNumber: `SMOKE-REG-B-${suffix}`,
      adminEmail: instB.email,
      adminPassword: instB.password,
    },
  });
  assert(status === 201, `apply ${status}: ${JSON.stringify(data)}`);
  bId = data.institution.id;
  created.institutions.push(bId);
  created.users.push(data.admin.id);
});

await step("duplicate registration number rejected (409)", async () => {
  const { status } = await api("POST", "/api/institutions/apply", {
    body: {
      name: "Dup", registrationNumber: `SMOKE-REG-A-${suffix}`,
      adminEmail: `dup-${suffix}@example.com`, adminPassword: "Whatever123!",
    },
  });
  assert(status === 409, `expected 409, got ${status}`);
});

await step("institution admins can log in", async () => {
  const a = await api("POST", "/api/auth/login", { body: { email: instA.email, password: instA.password } });
  const b = await api("POST", "/api/auth/login", { body: { email: instB.email, password: instB.password } });
  assert(a.status === 200 && a.data.user.role === "institution_admin", "A login failed");
  assert(b.status === 200, "B login failed");
  aAdminToken = a.data.token;
  bAdminToken = b.data.token;
});

// ── Approval + scoping ────────────────────────────────────
await step("institution admin cannot approve (403)", async () => {
  const { status } = await api("PATCH", `/api/institutions/${aId}/status`, {
    token: aAdminToken, body: { status: "approved" },
  });
  assert(status === 403, `expected 403, got ${status}`);
});

await step("platform admin approves A", async () => {
  const { status, data } = await api("PATCH", `/api/institutions/${aId}/status`, {
    token: adminToken, body: { status: "approved", reason: "smoke test" },
  });
  assert(status === 200 && data.institution.verificationStatus === "approved", `approve failed: ${status}`);
});

await step("cross-institution read DENIED (A admin → B)", async () => {
  const { status } = await api("GET", `/api/institutions/${bId}`, { token: aAdminToken });
  assert(status === 403, `expected 403, got ${status}`);
});

await step("unapproved institution wallet add DENIED (B)", async () => {
  const { status } = await api("POST", `/api/institutions/${bId}/wallets`, {
    token: bAdminToken, body: { walletAddress: walletB },
  });
  assert(status === 403, `expected 403, got ${status}`);
});

await step("approved institution wallet add OK (A)", async () => {
  const { status, data } = await api("POST", `/api/institutions/${aId}/wallets`, {
    token: aAdminToken, body: { walletAddress: walletA },
  });
  assert(status === 201, `wallet add ${status}: ${JSON.stringify(data)}`);
  created.wallets.push(data.wallet.id);
});

await step("same wallet at second institution DENIED (409)", async () => {
  // Approve B briefly to test the one-wallet-one-institution constraint.
  const approve = await api("PATCH", `/api/institutions/${bId}/status`, {
    token: adminToken, body: { status: "approved" },
  });
  assert(approve.status === 200, "B approve failed");
  const { status } = await api("POST", `/api/institutions/${bId}/wallets`, {
    token: bAdminToken, body: { walletAddress: walletA },
  });
  assert(status === 409, `expected 409, got ${status}`);
});

await step("A admin creates an issuer in own institution", async () => {
  const { status, data } = await api("POST", "/api/auth/register", {
    token: aAdminToken,
    body: {
      email: `smoke-issuer-${suffix}@example.com`,
      password: `IssuerPass-${suffix}!`,
      role: "issuer",
      institutionId: bId, // adversarial: must be IGNORED, forced to A
      walletAddress: walletA,
    },
  });
  assert(status === 201, `register ${status}: ${JSON.stringify(data)}`);
  assert(data.institutionId === aId, "issuer was NOT forced into the admin's own institution");
  created.users.push(data.userId);
});

await step("A admin cannot create platform admins (403)", async () => {
  const { status } = await api("POST", "/api/auth/register", {
    token: aAdminToken,
    body: { email: `smoke-esc-${suffix}@example.com`, password: "Escalate123!", role: "platform_admin" },
  });
  assert(status === 403, `expected 403, got ${status}`);
});

await step("issuer login sees own institution only", async () => {
  const login = await api("POST", "/api/auth/login", {
    body: { email: `smoke-issuer-${suffix}@example.com`, password: `IssuerPass-${suffix}!` },
  });
  assert(login.status === 200, "issuer login failed");
  const list = await api("GET", "/api/institutions", { token: login.data.token });
  assert(list.status === 200 && list.data.institutions.length === 1, "issuer sees more than own institution");
  assert(list.data.institutions[0].id === aId, "wrong institution returned");
});

// ── Cleanup (only rows created by this run) ───────────────
console.log("\n[cleanup] removing smoke rows via service-role client");
try {
  const { supabase } = await import("../supabase.js");
  // FK-safe order: wallets reference users (authorized_by), users reference institutions.
  for (const wid of created.wallets) await supabase.from("issuer_wallets").delete().eq("id", wid);
  for (const uid of created.users) await supabase.from("users").delete().eq("id", uid);
  for (const iid of created.institutions) await supabase.from("institutions").delete().eq("id", iid);
  console.log("  cleanup done");
} catch (err) {
  console.error("  cleanup failed (remove smoke rows manually):", err.message);
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);