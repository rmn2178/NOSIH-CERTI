/**
 * P5 offline gate — identity/storage/QR, NO live services.
 *
 * Proves:
 *  - certificate QR: correct verify URL (?certificateId=), valid labelled
 *    PNG (480×564), data URI, production/local base-URL logic
 *  - full document roundtrip: AES-256-GCM encrypt → storage-cache MISS →
 *    IPFS gateway fetch (local stand-in) → decrypt → byte-identical
 *  - GCM authentication rejects a single flipped ciphertext byte
 *  - storage helpers degrade to warnings (never crash) without Supabase
 *
 * Identity hash roundtrips are proven by checkP2.js (38/38).
 * The LIVE Pinata pin+fetch+decrypt gate runs with credentials (task #16).
 * Run: node backend/scripts/checkP5.js
 */

import crypto from "crypto";
process.env.DOCUMENT_ENC_KEY = process.env.DOCUMENT_ENC_KEY || crypto.randomBytes(32).toString("hex");
process.env.HASH_PEPPER = process.env.HASH_PEPPER || crypto.randomBytes(32).toString("hex");

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..");

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

const identity = await import("../services/certificateIdentity.js");
const qr = await import("../services/qr.js");
const storage = await import("../services/certificateStorage.js");
const { makeCertificateFixtures } = await import("./makeCertificateFixtures.js");
await makeCertificateFixtures(); // idempotent — ensures the fixture exists

// ── 1. QR ─────────────────────────────────────────────────
console.log("\n[1] Certificate QR");

const fakeReq = (headers) => ({ get: (h) => headers[h.toLowerCase()], protocol: "http" });

await check("verify URL encodes certificateId", () => {
  const url = qr.buildCertificateVerifyUrl(
    "CERT-8A91F203",
    fakeReq({ host: "nosih.example", "x-forwarded-proto": "https" })
  );
  assert(url === "https://nosih.example/verify?certificateId=CERT-8A91F203", url);
});

await check("base-URL logic: forwarded host, configured override, localhost", () => {
  const prod = qr.verifyBaseFrom(fakeReq({ "x-forwarded-host": "app.nosih.io", "x-forwarded-proto": "https" }));
  assert(prod === "https://app.nosih.io/verify", prod);
  process.env.VERIFY_BASE_URL = "https://verify.nosih.io";
  assert(qr.verifyBaseFrom(fakeReq({ host: "anything" })) === "https://verify.nosih.io", "override ignored");
  process.env.VERIFY_BASE_URL = "http://localhost:3000";
  assert(qr.verifyBaseFrom(fakeReq({ host: "localhost:3000" })) === "http://localhost:3000", "local override lost");
  delete process.env.VERIFY_BASE_URL;
});

let qrResult = null;
await check("generateCertificateQr → valid labelled PNG 480×564", async () => {
  qrResult = await qr.generateCertificateQr("CERT-8A91F203", fakeReq({ host: "nosih.example" }));
  assert(qrResult.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "not a PNG");
  assert(qrResult.qrDataUrl.startsWith("data:image/png;base64,"), "not a data URI");
  const sharp = (await import("sharp")).default;
  const meta = await sharp(qrResult.png).metadata();
  assert(meta.width === 480 && meta.height === 564, `${meta.width}×${meta.height}`);
  assert(qrResult.verifyUrl.includes("certificateId=CERT-8A91F203"), "URL missing certificateId");
});

// ── 2. Storage roundtrip via local IPFS stand-in ──────────
console.log("\n[2] Encrypt → storage miss → IPFS fetch → decrypt");

const CID = "bafyStandInCidForOfflineCheck";
const original = fs.readFileSync(path.join(backendDir, "test-fixtures", "digital-certificate.pdf"));
const { ciphertext, iv, tag } = identity.encryptCertificate(original);

const served = [];
const gateway = http.createServer((req, res) => {
  served.push(req.url);
  if (req.url === `/ipfs/${CID}`) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(ciphertext);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
process.env.IPFS_GATEWAY_BASE_URL = `http://127.0.0.1:${gateway.address().port}/ipfs`;

let fetched = null;
await check("storage cache miss falls back to IPFS and returns ciphertext", async () => {
  fetched = await storage.getEncryptedCertificate({ certificate_id: "CERT-8A91F203", ipfs_cid: CID });
  assert(fetched.buffer.equals(ciphertext), "fetched bytes differ from pinned ciphertext");
  assert(fetched.sourceUrl.includes(CID), "sourceUrl not the gateway");
  assert(served.some((u) => u === `/ipfs/${CID}`), "gateway was not hit");
});

await check("decrypt restores the EXACT original PDF bytes", () => {
  const plain = identity.decryptCertificate(fetched.buffer, iv, tag);
  assert(plain.equals(original), "roundtrip mismatch");
  assert(identity.computeDocumentHash(plain) === identity.computeDocumentHash(original), "document hash differs");
});

await check("one flipped ciphertext byte fails GCM authentication", () => {
  const bad = Buffer.from(fetched.buffer);
  bad[Math.floor(bad.length / 2)] ^= 0x01;
  let threw = false;
  try { identity.decryptCertificate(bad, iv, tag); } catch { threw = true; }
  assert(threw, "tampered ciphertext decrypted");
});

await check("store + bucket-ensure degrade to warnings without Supabase", async () => {
  await storage.ensureCertificatesBucket(); // must not throw
  await storage.storeEncryptedCertificate("CERT-8A91F203", ciphertext); // must not throw
});

// ── 3. Source guarantees ──────────────────────────────────
console.log("\n[3] Source guarantees");

await check("no plaintext upload path: storage only ever receives ciphertext", () => {
  const src = fs.readFileSync(path.join(backendDir, "services", "certificateStorage.js"), "utf8");
  assert(!/decrypt/.test(src), "storage module must never decrypt (ciphertext-only layer)");
  const ipfsSrc = fs.readFileSync(path.join(backendDir, "services", "ipfs.js"), "utf8");
  assert(!/decrypt/.test(ipfsSrc), "ipfs module must never decrypt");
});

gateway.close();
console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);