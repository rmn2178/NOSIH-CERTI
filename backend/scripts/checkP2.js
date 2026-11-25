/**
 * P2 offline gate — runs WITHOUT credentials or network.
 *
 * Proves:
 *  1. Every new/changed backend module imports cleanly (ESM resolution).
 *  2. certificateIdentity: id formats, hash determinism, canonical metadata,
 *     AES-256-GCM roundtrip + tamper rejection (generated dev keys).
 *  3. Role middleware: legacy admin mapping + role gates.
 *  4. SQL: migration is additive (no DROP TABLE), all tables/columns/RLS
 *     present, and every supabase.js mapper column exists in schema.sql.
 *
 * Live gates (login/apply/approve/cross-institution denial) run in
 * scripts/smokeP2.js once Supabase credentials are provided.
 *
 * Run: node backend/scripts/checkP2.js
 */

// Dev-only keys, generated per run — never persisted, never used in production.
import crypto from "crypto";
process.env.DOCUMENT_ENC_KEY = process.env.DOCUMENT_ENC_KEY || crypto.randomBytes(32).toString("hex");
process.env.HASH_PEPPER = process.env.HASH_PEPPER || crypto.randomBytes(32).toString("hex");

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ── 1. Module imports ─────────────────────────────────────
console.log("\n[1] Module imports");
const modules = [
  "../envCheck.js",
  "../config.js",
  "../supabase.js",
  "../middleware/auth.js",
  "../middleware/institutionAccess.js",
  "../middleware/issuerAccess.js",
  "../middleware/errorHandler.js",
  "../services/certificateIdentity.js",
  "../routes/auth.js",
  "../routes/institutions.js",
];
const imported = {};
for (const m of modules) {
  await checkAsync(`import ${m}`, async () => {
    imported[m] = await import(m);
  });
}

// ── 2. Identity crypto ────────────────────────────────────
console.log("\n[2] certificateIdentity");
const id = imported["../services/certificateIdentity.js"];

check("certificate id format + uniqueness (1000 draws)", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const cid = id.generateCertificateId();
    assert(id.isCertificateId(cid), `bad format: ${cid}`);
    assert(!seen.has(cid), `collision: ${cid}`);
    seen.add(cid);
  }
});

check("institution id format", () => {
  const iid = id.generateInstitutionId();
  assert(id.isInstitutionId(iid), `bad format: ${iid}`);
  assert(!id.isCertificateId(iid), "INST id must not pass CERT check");
});

check("certificateIdHash = keccak256(utf8(id)), rejects malformed ids", () => {
  const cid = "CERT-8A91F203";
  const h = id.generateCertificateIdHash(cid);
  assert(/^0x[0-9a-f]{64}$/.test(h), "not bytes32 hex");
  assert(h === id.idHash(cid), "hash mismatch");
  let threw = false;
  try { id.generateCertificateIdHash("CERT-zzz"); } catch { threw = true; }
  assert(threw, "malformed id accepted");
});

check("documentHash = SHA-256 of exact bytes", () => {
  const buf = Buffer.from("%PDF-1.4 fake certificate bytes");
  const expected = "0x" + crypto.createHash("sha256").update(buf).digest("hex");
  assert(id.computeDocumentHash(buf) === expected, "sha256 mismatch");
  let threw = false;
  try { id.computeDocumentHash(Buffer.alloc(0)); } catch { threw = true; }
  assert(threw, "empty buffer accepted");
});

check("canonicalizeMetadata: key order + nesting + normalization", () => {
  const a = { z: "Hello  World", a: { y: 1, x: ["B", "a"] }, n: null };
  const b = { a: { x: ["B", "a"], y: 1 }, n: undefined, z: "hello world" };
  assert(id.canonicalizeMetadata(a) === id.canonicalizeMetadata(b), "canonical forms differ");
  const parsed = JSON.parse(id.canonicalizeMetadata(a));
  assert(Object.keys(parsed)[0] === "a", "keys not sorted");
  assert(parsed.n === "", "null not normalized to empty string");
});

check("metadataHash covers institution identity", () => {
  const meta = { holderName: "Asha Rao", courseName: "B.Sc CS", grade: "A" };
  const instA = id.computeInstitutionIdentityHash("INST-AAAAAAAA");
  const instB = id.computeInstitutionIdentityHash("INST-BBBBBBBB");
  const h1 = id.computeMetadataHash(meta, instA);
  const h2 = id.computeMetadataHash({ ...meta }, instA);
  const h3 = id.computeMetadataHash(meta, instB);
  assert(h1 === h2, "same metadata+institution must hash identically");
  assert(h1 !== h3, "different institutions must produce different hashes");
  let threw = false;
  try { id.computeMetadataHash(meta, "0x1234"); } catch { threw = true; }
  assert(threw, "invalid institution hash accepted");
});

check("holderIdentityHash: deterministic, keyed, identifier-sensitive", () => {
  const h1 = id.computeHolderIdentityHash("Asha  Rao", "REG 12345");
  const h2 = id.computeHolderIdentityHash("asha rao", "reg12345");
  const h3 = id.computeHolderIdentityHash("Asha Rao", "REG 99999");
  assert(h1 === h2, "normalization not deterministic");
  assert(h1 !== h3, "identifier not covered");
  assert(/^0x[0-9a-f]{64}$/.test(h1), "not bytes32 hex");
  const plain = "0x" + crypto.createHash("sha256").update("ASHA RAO|REG12345").digest("hex");
  assert(h1 !== plain, "hash is not keyed (brute-forceable)");
});

check("institutionIdentityHash stable per institution id", () => {
  const a1 = id.computeInstitutionIdentityHash("INST-AAAAAAAA");
  const a2 = id.computeInstitutionIdentityHash("INST-AAAAAAAA");
  assert(a1 === a2, "not stable");
  let threw = false;
  try { id.computeInstitutionIdentityHash("INST-12"); } catch { threw = true; }
  assert(threw, "malformed institution id accepted");
});

check("revocationReasonHash: keyed, non-empty required", () => {
  const h = id.computeRevocationReasonHash("court order 42/2026");
  assert(/^0x[0-9a-f]{64}$/.test(h), "not bytes32 hex");
  assert(h === id.computeRevocationReasonHash("court order 42/2026"), "not deterministic");
  let threw = false;
  try { id.computeRevocationReasonHash("   "); } catch { threw = true; }
  assert(threw, "empty reason accepted");
});

check("AES-256-GCM roundtrip", () => {
  const plain = crypto.randomBytes(250_000); // ~250 KB, PDF-sized
  const { ciphertext, iv, tag } = id.encryptCertificate(plain);
  assert(!ciphertext.equals(plain), "ciphertext equals plaintext");
  assert(/^[0-9a-f]{24}$/.test(iv), "IV not 12-byte hex");
  assert(/^[0-9a-f]{32}$/.test(tag), "tag not 16-byte hex");
  const back = id.decryptCertificate(ciphertext, iv, tag);
  assert(back.equals(plain), "roundtrip mismatch");
});

check("AES-256-GCM rejects tampered ciphertext / tag / iv", () => {
  const plain = Buffer.from("certificate bytes");
  const { ciphertext, iv, tag } = id.encryptCertificate(plain);
  const bad = Buffer.from(ciphertext);
  bad[0] ^= 0xff;
  for (const [ct, i, t, label] of [
    [bad, iv, tag, "ciphertext"],
    [ciphertext, iv, tag.replace(/^./, tag[0] === "0" ? "1" : "0"), "tag"],
    [ciphertext, iv.replace(/^./, iv[0] === "0" ? "1" : "0"), tag, "iv"],
  ]) {
    let threw = false;
    try { id.decryptCertificate(ct, i, t); } catch { threw = true; }
    assert(threw, `tampered ${label} accepted`);
  }
});

// ── 3. Role middleware ────────────────────────────────────
console.log("\n[3] Role middleware");
const authMw = imported["../middleware/auth.js"];

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

check("legacy admin maps to platform_admin", () => {
  assert(authMw.normalizeRole("admin") === "platform_admin", "mapping missing");
  assert(authMw.normalizeRole("issuer") === "issuer", "issuer altered");
});

check("requireRoles gates correctly", () => {
  const gate = authMw.requireRoles("platform_admin", "institution_admin");
  for (const [role, allowed] of [
    ["platform_admin", true], ["admin", true], ["institution_admin", true],
    ["issuer", false], ["auditor", false],
  ]) {
    const res = fakeRes();
    let nexted = false;
    gate({ userRole: authMw.normalizeRole(role) }, res, () => { nexted = true; });
    assert(nexted === allowed, `role ${role}: expected ${allowed ? "allow" : "deny"}`);
    if (!allowed) assert(res.statusCode === 403, "denial must be 403");
  }
});

// ── 4. SQL checks ─────────────────────────────────────────
console.log("\n[4] SQL schema + migration");
const schema = readFileSync(path.join(backendDir, "supabase", "schema.sql"), "utf8");
const migration = readFileSync(path.join(backendDir, "supabase", "migrations", "001_nosih.sql"), "utf8");
const TABLES = ["users", "institutions", "issuer_wallets", "certificates", "issuance_intents", "certificate_events"];

check("migration is additive: no DROP TABLE / TRUNCATE / DELETE FROM", () => {
  for (const sql of [migration]) {
    assert(!/drop\s+table/i.test(sql), "DROP TABLE found");
    assert(!/truncate/i.test(sql), "TRUNCATE found");
    assert(!/delete\s+from/i.test(sql), "DELETE FROM found");
  }
  assert(!/land_records|owners/.test(migration.replace(/--.*$/gm, "")), "migration touches land tables");
});

check("migration preserves legacy admins (maps admin → platform_admin)", () => {
  assert(/update users set role = 'platform_admin' where role = 'admin'/.test(migration), "role mapping missing");
});

for (const table of TABLES) {
  check(`schema.sql creates ${table} + RLS`, () => {
    assert(new RegExp(`create table if not exists ${table}\\s*\\(`).test(schema), `table ${table} missing`);
    assert(new RegExp(`alter table ${table}\\s+enable row level security`).test(schema), `RLS missing for ${table}`);
  });
  if (table !== "users") {
    check(`migration creates ${table} + RLS`, () => {
      assert(new RegExp(`create table if not exists ${table}\\s*\\(`).test(migration), `table ${table} missing`);
      assert(new RegExp(`alter table ${table}\\s+enable row level security`).test(migration), `RLS missing for ${table}`);
    });
  }
}

check("brief §8 certificate columns all present", () => {
  const required = [
    "certificate_id", "certificate_id_hash", "institution_id", "issuer_user_id", "issuer_wallet",
    "holder_name", "holder_identity_hash", "certificate_type", "certificate_number", "course_name",
    "qualification", "specialization", "grade", "issue_date", "expiry_date", "academic_year",
    "signatory_name", "signatory_designation", "extra_data", "document_hash", "metadata_hash",
    "ipfs_cid", "encryption_iv", "encryption_tag", "tx_hash", "block_number", "status",
    "supersedes_certificate_id", "qr_code_data",
  ];
  for (const col of required) {
    assert(new RegExp(`^\\s+${col}\\s`, "m").test(schema), `column ${col} missing from schema.sql`);
    assert(new RegExp(`^\\s+${col}\\s`, "m").test(migration), `column ${col} missing from migration`);
  }
});

check("mapper ↔ schema cross-check (every row.<col> exists in schema.sql)", () => {
  const supabaseSrc = readFileSync(path.join(backendDir, "supabase.js"), "utf8");
  // NOSIH mappers only: userFromRow … end of file. The legacy land
  // mappers were retired in P7 together with the land services.
  const start = supabaseSrc.indexOf("export function userFromRow");
  assert(start !== -1, "mapper block not found in supabase.js");
  assert(!/ownerFromRow|landRecordFromRow/.test(supabaseSrc), "legacy land mappers must be retired");
  const mapperSrc = supabaseSrc.slice(start);
  const schemaCols = new Set(
    [...schema.matchAll(/^\s+([a-z_]+)\s+(?:uuid|text|char|boolean|timestamptz|jsonb|bigint|date|numeric)/gm)].map((m) => m[1])
  );
  const joins = new Set(["institutions"]); // embedded joins, not columns
  const refs = [...mapperSrc.matchAll(/row\.([a-z_]+)/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((c) => !schemaCols.has(c) && !joins.has(c));
  assert(missing.length === 0, `mapper references unknown columns: ${missing.join(", ")}`);
});

// ── Summary ───────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);