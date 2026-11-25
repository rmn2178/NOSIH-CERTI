/**
 * P7 integration gate — the REAL verification service against a REAL
 * (in-memory Hardhat) chain, with deterministic PostgREST + IPFS stand-ins
 * for the database/document layers. No live network, no ledger writes.
 *
 * Covers all 10 verdicts through the actual orchestrator (verifyCertificate),
 * revoked-on-hash-match, chain-time expiry + lazy DB mirror, both tamper
 * modes (stored-document integrity and uploaded-PDF fingerprint), the public
 * payload privacy allow-list, and the async 'verified' audit event.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const http = require("http");
const crypto = require("crypto");

// Dev-only keys + stand-in endpoints, set BEFORE the ESM service imports.
process.env.DOCUMENT_ENC_KEY = process.env.DOCUMENT_ENC_KEY || crypto.randomBytes(32).toString("hex");
process.env.HASH_PEPPER = process.env.HASH_PEPPER || crypto.randomBytes(32).toString("hex");
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://offline-gate.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "offline-gate-" + crypto.randomBytes(24).toString("hex");

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const CERT_ID = "CERT-8A91F203";
const OTHER_CERT_ID = "CERT-00000000";
const INST_HASH = id("INST-AAAAAAAA");
const IPFS_CID = "bafyVerifyTestCid";

// A small PDF-shaped buffer: magic bytes + deterministic content. The
// verification path never parses PDF structure — it hashes exact bytes.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\nNOSIH verification fixture — original registered bytes\n%%EOF\n" + "x".repeat(512)
);
const sha256 = (buf) => "0x" + crypto.createHash("sha256").update(buf).digest("hex");

describe("Verification service — chain-authoritative (P7)", function () {
  let verification, identity, chainService;
  let registry, registryAddress, admin, issuer, revoker;
  let provider, server, port;

  // ── Stand-in state ──
  const rows = new Map(); // certificate_id → certificates row (with institutions embed)
  const ipfsStore = new Map(); // cid → ciphertext buffer
  const captures = { events: [], patches: [] };

  const makeRow = (overrides = {}) => ({
    certificate_id: CERT_ID,
    certificate_id_hash: id(CERT_ID),
    institution_id: "11111111-1111-1111-1111-111111111111",
    institution_id_hash: INST_HASH,
    issuer_user_id: null,
    issuer_wallet: issuer.address.toLowerCase(),
    holder_name: "Asha Rao",
    holder_identity_hash: id("holder-1"),
    holder_identifier: "21CS1042",
    certificate_type: "undergraduate_degree",
    certificate_number: "AU/2024/UG/001234",
    course_name: "B.E. Computer Science",
    qualification: "Bachelor of Engineering",
    qualification_level: "undergraduate",
    specialization: "Computer Science",
    grade: "First Class with Distinction",
    percentage: "87.5",
    issue_date: "2024-08-15",
    expiry_date: null,
    academic_year: "2020-2024",
    signatory_name: "R. Kumar",
    signatory_designation: "Controller of Examinations",
    extra_data: { cgpa: "8.7" },
    document_hash: sha256(PDF_BYTES),
    metadata_hash: id("meta-1"),
    ipfs_cid: IPFS_CID,
    encryption_iv: null, // filled per test from the real encryption
    encryption_tag: null,
    original_filename: "certificate.pdf",
    tx_hash: "0x" + "11".repeat(32),
    block_number: 1,
    issued_at: new Date().toISOString(),
    chain_expires_at: 0,
    status: "active",
    supersedes_certificate_id: null,
    superseded_by_certificate_id: null,
    revoked_at: null,
    revoke_reason: null,
    revoked_tx_hash: null,
    institutions: { name: "Anna University", institution_id: "INST-AAAAAAAA", verification_status: "approved" },
    ...overrides,
  });

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  // ── Deterministic PostgREST + storage + IPFS stand-in ──
  const standIn = async (url, init) => {
    const method = (init?.method || "GET").toUpperCase();
    const p = url.pathname;

    if (p.startsWith("/ipfs/")) {
      const cid = p.slice("/ipfs/".length);
      const buf = ipfsStore.get(cid);
      if (!buf) return json({ error: "not pinned" }, 404);
      return new Response(buf, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }

    if (p.startsWith("/storage/v1/object/")) {
      // Always a cache MISS → forces the IPFS fallback path (and backfill).
      return json({ statusCode: "404", error: "Not Found", message: "Object not found" }, 404);
    }

    if (p.startsWith("/rest/v1/certificate_events") && method === "POST") {
      captures.events.push(JSON.parse(init.body));
      return new Response(null, { status: 201 });
    }

    if (p.startsWith("/rest/v1/certificates") && method === "PATCH") {
      const body = JSON.parse(init.body);
      const filter = url.searchParams.get("certificate_id");
      const certId = filter?.startsWith("eq.") ? filter.slice(3) : null;
      captures.patches.push({ certId, body });
      if (certId && rows.has(certId)) Object.assign(rows.get(certId), body);
      return new Response(null, { status: 204 });
    }

    if (p.startsWith("/rest/v1/certificates") && method === "GET") {
      let accept = "";
      try { accept = new Headers(init?.headers || {}).get("accept") || ""; } catch { accept = String(init?.headers?.Accept || init?.headers?.accept || ""); }
      const wantsObject = accept.includes("vnd.pgrst.object");
      let found = [...rows.values()];
      for (const [key, value] of url.searchParams) {
        if (key === "select" || key === "limit" || key === "order") continue;
        const [op, ...rest] = value.split(".");
        const target = rest.join(".");
        if (op === "eq") found = found.filter((r) => String(r[key]) === target);
        if (op === "neq") found = found.filter((r) => String(r[key]) !== target);
      }
      if (wantsObject) {
        if (found.length === 1) return json(found[0]);
        return json(
          { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows", hint: null },
          406
        );
      }
      return json(found);
    }

    // Boot-time connectivity probes (users / institutions / issuance_intents).
    if (p.startsWith("/rest/v1/")) return json([]);

    return json({ error: "unhandled stand-in path " + p }, 404);
  };

  before(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const response = await standIn(url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() || undefined });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    process.env.IPFS_GATEWAY_BASE_URL = `http://127.0.0.1:${port}/ipfs`;

    // Route Supabase through the stand-in; allow localhost; block everything
    // else so the gate can never touch an external service.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname.endsWith(".supabase.co")) {
        return standIn(url, init).catch((err) => { throw err; });
      }
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
      return Promise.reject(new TypeError("fetch blocked (offline P7 stand-in)"));
    };

    verification = await import("../backend/services/verification.js");
    identity = await import("../backend/services/certificateIdentity.js");
    chainService = await import("../backend/services/blockchain.js");
    provider = ethers.provider;
  });

  after(async () => {
    server?.close();
  });

  beforeEach(async () => {
    [admin, issuer, revoker] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("CertificateRegistry")).deploy();
    registryAddress = await registry.getAddress();
    await registry.authorizeIssuer(issuer.address, INST_HASH);
    await registry.grantRole(await registry.REVOKER_ROLE(), revoker.address);

    rows.clear();
    ipfsStore.clear();
    captures.events.length = 0;
    captures.patches.length = 0;

    // Encrypt the fixture and pin the ciphertext to the stand-in IPFS.
    const { ciphertext, iv, tag } = identity.encryptCertificate(PDF_BYTES);
    ipfsStore.set(IPFS_CID, ciphertext);
    rows.set(CERT_ID, makeRow({ encryption_iv: iv, encryption_tag: tag }));

    // Issue on the REAL local chain with fingerprints of the fixture.
    await registry.connect(issuer).issueCertificate({
      certificateIdHash: id(CERT_ID),
      institutionIdHash: INST_HASH,
      holderIdentityHash: id("holder-1"),
      documentHash: sha256(PDF_BYTES),
      metadataHash: id("meta-1"),
      ipfsCID: IPFS_CID,
      issuer: ethers.ZeroAddress,
      issuedAt: 0,
      expiresAt: 0,
      revoked: false,
      exists: false,
      supersedesCertificateIdHash: ethers.ZeroHash,
    });
  });

  const verify = (certId = CERT_ID, opts = {}) =>
    verification.verifyCertificate(certId, { provider, contractAddress: registryAddress, ...opts });

  // 1. Authentic-active through the full orchestrator + public payload privacy
  it("returns authentic-active with the public allow-list payload and audits the verification", async () => {
    const { httpStatus, payload } = await verify();
    expect(httpStatus).to.equal(200);
    expect(payload.verdict).to.equal("authentic-active");
    expect(payload.authentic).to.equal(true);
    expect(payload.found).to.equal(true);
    expect(payload.documentHashMatch).to.equal(true);
    expect(payload.metadataHashMatch).to.equal(true);
    expect(payload.issuerAuthorized).to.equal(true);
    expect(payload.certificate.holderName).to.equal("Asha Rao");
    expect(payload.institution).to.deep.equal({ name: "Anna University", institutionId: "INST-AAAAAAAA", verified: true });
    expect(payload.issuerWallet.toLowerCase()).to.equal(issuer.address.toLowerCase());
    expect(payload.transactionHash).to.equal("0x" + "11".repeat(32));
    expect(payload.revoked).to.equal(false);
    expect(payload.expired).to.equal(false);

    // Privacy: no identifier, no extras, no encryption details, no ciphertext.
    const serialized = JSON.stringify(payload);
    expect(serialized).to.not.contain("21CS1042");
    expect(serialized).to.not.contain("extra_data");
    expect(serialized).to.not.contain("encryption");
    expect(serialized).to.not.contain("cgpa");
    expect(payload.certificate.holderIdentifier).to.equal(undefined);

    // Async 'verified' audit event (performed_by null for public verifies).
    await new Promise((r) => setTimeout(r, 50));
    const event = captures.events.find((e) => e.event_type === "verified");
    expect(event).to.exist;
    expect(event.performed_by).to.equal(null);
    expect(event.details.verdict).to.equal("authentic-active");
  });

  // 2. Revoked-on-hash-match: chain revocation ALWAYS wins
  it("returns revoked even when every fingerprint matches", async () => {
    await registry.connect(revoker).revokeCertificate(id(CERT_ID), id("revocation-reason|fraud"));
    const { httpStatus, payload } = await verify();
    expect(httpStatus).to.equal(200);
    expect(payload.verdict).to.equal("revoked");
    expect(payload.authentic).to.equal(false);
    expect(payload.documentHashMatch).to.equal(true); // hashes DO match…
    expect(payload.revoked).to.equal(true); // …and it is still revoked
  });

  // 3. Expiry judged on CHAIN time + lazy DB mirror + expired event
  it("returns expired from chain timestamps and mirrors the status lazily", async () => {
    const certId = "CERT-EEEEEEEE";
    const latest = await provider.getBlock("latest");
    const expiresAt = Number(latest.timestamp) + 60;
    await registry.connect(issuer).issueCertificate({
      certificateIdHash: id(certId),
      institutionIdHash: INST_HASH,
      holderIdentityHash: id("holder-2"),
      documentHash: id("doc-2"),
      metadataHash: id("meta-2"),
      ipfsCID: "bafyExpiryCid",
      issuer: ethers.ZeroAddress,
      issuedAt: 0,
      expiresAt,
      revoked: false,
      exists: false,
      supersedesCertificateIdHash: ethers.ZeroHash,
    });
    rows.set(certId, makeRow({
      certificate_id: certId,
      certificate_id_hash: id(certId),
      document_hash: id("doc-2"),
      metadata_hash: id("meta-2"),
      ipfs_cid: "bafyExpiryCid",
      chain_expires_at: expiresAt,
      expiry_date: "2030-01-01",
    }));

    await network.provider.send("evm_increaseTime", [120]);
    await network.provider.send("evm_mine", []);
    const chainNow = Number((await provider.getBlock("latest")).timestamp);

    const { payload } = await verify(certId, { nowSeconds: chainNow });
    expect(payload.verdict).to.equal("expired");
    expect(payload.expired).to.equal(true);
    expect(payload.authentic).to.equal(false);

    const patch = captures.patches.find((p) => p.certId === certId);
    expect(patch?.body.status).to.equal("expired");
    const event = captures.events.find((e) => e.event_type === "expired" && e.certificate_id === certId);
    expect(event).to.exist;
  });

  // 4. Superseded verdict points at the replacement
  it("returns superseded with the replacement certificate id", async () => {
    rows.get(CERT_ID).superseded_by_certificate_id = "CERT-FFFFFFFF";
    const { payload } = await verify();
    expect(payload.verdict).to.equal("superseded");
    expect(payload.supersededByCertificateId).to.equal("CERT-FFFFFFFF");
    expect(payload.authentic).to.equal(false);
  });

  // 5–8. Fingerprint mismatch verdicts (chain vs database)
  const mismatchCases = [
    ["document_hash", "0x" + "ff".repeat(32), "document-mismatch"],
    ["metadata_hash", "0x" + "ee".repeat(32), "metadata-mismatch"],
    ["issuer_wallet", "0x" + "99".repeat(20), "issuer-unauthorized"],
    ["institution_id_hash", "0x" + "dd".repeat(32), "db-chain-mismatch"],
    ["ipfs_cid", "bafyWrongCid", "db-chain-mismatch"],
  ];
  for (const [column, value, expected] of mismatchCases) {
    it(`returns ${expected} when the database ${column} diverges from the chain`, async () => {
      rows.get(CERT_ID)[column] = value;
      const { payload } = await verify();
      expect(payload.verdict).to.equal(expected);
      expect(payload.authentic).to.equal(false);
    });
  }

  // 9. Not found on either side
  it("returns not-found (404) for an unknown certificate", async () => {
    const { httpStatus, payload } = await verify(OTHER_CERT_ID);
    expect(httpStatus).to.equal(404);
    expect(payload.verdict).to.equal("not-found");
    expect(payload.found).to.equal(false);
  });

  // 10. Chain knows it, database does not → db-chain-mismatch (never authentic)
  it("returns db-chain-mismatch when the chain has it but the database does not", async () => {
    rows.delete(CERT_ID);
    const { payload } = await verify();
    expect(payload.verdict).to.equal("db-chain-mismatch");
    expect(payload.authentic).to.equal(false);
    expect(payload.found).to.equal(true); // the CHAIN found it
    expect(payload.certificate).to.equal(null);
  });

  // 11. Blockchain unavailable → INDETERMINATE 503, never valid-from-DB
  it("returns indeterminate 503 when the chain cannot be reached", async () => {
    const dead = new ethers.JsonRpcProvider("http://127.0.0.1:9", 31337, { staticNetwork: true });
    const { httpStatus, payload } = await verify(CERT_ID, { provider: dead });
    expect(httpStatus).to.equal(503);
    expect(payload.verdict).to.equal("blockchain-unavailable");
    expect(payload.authentic).to.equal(null); // indeterminate — NOT false-from-DB, NOT true
    expect(payload.found).to.equal(null);
  });

  // 12. Id validation
  it("rejects malformed certificate ids with 400", async () => {
    for (const bad of ["LAND-0000000000", "CERT-123", ""]) {
      let err = null;
      try { await verify(bad); } catch (e) { err = e; }
      expect(err?.status, bad).to.equal(400);
    }
  });

  // 13. Mode A — stored document intact via storage-MISS → IPFS → decrypt → rehash
  it("Mode A proves the stored document intact without exposing contents", async () => {
    const result = await verification.tamperCheckStored(CERT_ID, { provider, contractAddress: registryAddress });
    expect(result.intact).to.equal(true);
    expect(result.verdict).to.equal("intact");
    expect(result.documentSource).to.contain("/ipfs/"); // fell back to IPFS
    expect(result.chainDocumentHash).to.equal(sha256(PDF_BYTES));
    const serialized = JSON.stringify(result);
    expect(serialized).to.not.contain(PDF_BYTES.toString("base64"));
    expect(serialized).to.not.contain("NOSIH verification fixture");
  });

  // 14. Mode A — corrupted ciphertext fails GCM authentication (never "intact")
  it("Mode A rejects corrupted ciphertext instead of reporting intact", async () => {
    const corrupted = Buffer.from(ipfsStore.get(IPFS_CID));
    corrupted[10] ^= 0xff;
    ipfsStore.set(IPFS_CID, corrupted);
    let err = null;
    try {
      await verification.tamperCheckStored(CERT_ID, { provider, contractAddress: registryAddress });
    } catch (e) { err = e; }
    expect(err).to.exist;
    expect(/authenticate|unsupported state/i.test(err.message)).to.equal(true);
  });

  // 15. Mode B — exact registered document
  it("Mode B reports exact-match for the original bytes", async () => {
    const result = await verification.tamperCheckUploaded(CERT_ID, PDF_BYTES, { provider, contractAddress: registryAddress });
    expect(result.verdict).to.equal("exact-match");
    expect(result.match).to.equal(true);
    expect(result.uploadedHash).to.equal(sha256(PDF_BYTES));
  });

  // 16. Mode B — modified document (one flipped byte)
  it("Mode B reports modified for a single-byte change", async () => {
    const modified = Buffer.from(PDF_BYTES);
    modified[100] ^= 0x01;
    const result = await verification.tamperCheckUploaded(CERT_ID, modified, { provider, contractAddress: registryAddress });
    expect(result.verdict).to.equal("modified");
    expect(result.match).to.equal(false);
  });

  // 17. Mode B — the uploaded bytes belong to a DIFFERENT registered certificate
  it("Mode B reports registered-under-different-id when the hash is known elsewhere", async () => {
    const otherPdf = Buffer.from("%PDF-1.4\nanother certificate\n%%EOF");
    rows.set("CERT-AAAAAAAA", makeRow({ certificate_id: "CERT-AAAAAAAA", document_hash: sha256(otherPdf) }));
    const result = await verification.tamperCheckUploaded(CERT_ID, otherPdf, { provider, contractAddress: registryAddress });
    expect(result.verdict).to.equal("registered-under-different-id");
    expect(result.registeredCertificateId).to.equal("CERT-AAAAAAAA");
  });

  // 18. Mode B — revoked certificate still matches, verdict stays revoked
  it("Mode B reports revoked on hash match after chain revocation", async () => {
    await registry.connect(revoker).revokeCertificate(id(CERT_ID), id("revocation-reason|error"));
    const result = await verification.tamperCheckUploaded(CERT_ID, PDF_BYTES, { provider, contractAddress: registryAddress });
    expect(result.verdict).to.equal("revoked");
    expect(result.match).to.equal(true);
  });

  // 19. Mode B — input validation (magic bytes, id shape)
  it("Mode B rejects non-PDF uploads and malformed ids", async () => {
    let err = null;
    try {
      await verification.tamperCheckUploaded(CERT_ID, Buffer.from("not a pdf"), { provider, contractAddress: registryAddress });
    } catch (e) { err = e; }
    expect(err?.status).to.equal(400);

    err = null;
    try {
      await verification.tamperCheckUploaded("nope", PDF_BYTES, { provider, contractAddress: registryAddress });
    } catch (e) { err = e; }
    expect(err?.status).to.equal(400);
  });

  // 20. Verdict catalogue completeness (the plan's 10 verdicts)
  it("exposes exactly the ten planned verdicts", () => {
    expect(Object.keys(verification.VERDICTS).sort()).to.deep.equal([
      "authentic-active", "blockchain-unavailable", "db-chain-mismatch", "document-mismatch",
      "expired", "issuer-unauthorized", "metadata-mismatch", "not-found", "revoked", "superseded",
    ]);
    expect(verification.VERDICTS["blockchain-unavailable"].httpStatus).to.equal(503);
  });
});