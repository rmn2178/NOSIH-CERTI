/**
 * NOSIH certificate routes — the prepare → sign → confirm handshake.
 *
 * POST /api/certificates/extract              PDF → AI-suggested metadata (never proof)
 * POST /api/certificates/issue/prepare        encrypt + pin + intent; returns the MetaMask call
 * POST /api/certificates/issue/confirm        independently verify the receipt, then persist
 * GET  /api/certificates/issue/intents/:certificateId   handshake status / recovery
 * GET  /api/certificates                      institution-scoped list
 * GET  /api/certificates/meta/templates       field contract for the review form
 * GET  /api/certificates/:certificateId       detail + audit events
 * GET  /api/certificates/:certificateId/document  decrypted PDF (institution members only)
 * GET  /api/certificates/:certificateId/qr    QR PNG
 *
 * Security invariants:
 *  - The server NEVER signs issuance. issueCertificate is signed only by the
 *    issuer's own MetaMask wallet; confirm re-verifies the receipt on-chain.
 *  - Institution scoping comes from the freshly loaded users row, never the
 *    request body.
 *  - A certificates row exists only AFTER the chain confirms the issuance.
 *  - Missing credentials produce clear 503s — never simulated success.
 */

import "../env.js"; // loads the repository-root .env — must come first
import { Router } from "express";
import multer from "multer";
import Joi from "joi";
import fs from "fs";
import os from "os";
import path from "path";

import { MAX_UPLOAD_BYTES } from "../config.js";
import {
  supabase,
  isUniqueViolation,
  certificateFromRow,
  intentFromRow,
  certificateEventFromRow,
} from "../supabase.js";
import { protect, requireRoles } from "../middleware/auth.js";
import { loadCurrentUser } from "../middleware/institutionAccess.js";
import { requireIssuerWallet } from "../middleware/issuerAccess.js";
import { asyncHandler } from "../middleware/errorHandler.js";

import { validatePdf } from "../services/pdfParser.js";
import { extractCertificateMetadata } from "../services/certificateExtraction.js";
import {
  CERTIFICATE_FIELDS,
  FIELD_DESCRIPTIONS,
  CERTIFICATE_TYPES,
  CERTIFICATE_TEMPLATES,
} from "../services/certificateTemplates.js";
import {
  assertCertificateSecrets,
  generateCertificateId,
  generateCertificateIdHash,
  isCertificateId,
  computeDocumentHash,
  computeMetadataHash,
  computeHolderIdentityHash,
  computeRevocationReasonHash,
  encryptCertificate,
  decryptCertificate,
  ZERO,
} from "../services/certificateIdentity.js";
import { uploadToIPFS } from "../services/ipfs.js";
import {
  ensureCertificatesBucket,
  storeEncryptedCertificate,
  getEncryptedCertificate,
} from "../services/certificateStorage.js";
import { generateCertificateQr } from "../services/qr.js";
import {
  CHAIN_ID,
  getContractAddress,
  verifyIssuanceReceipt,
  readCertificate,
  revokeCertificateOnChain,
} from "../services/blockchain.js";

const router = Router();

const INTENT_TTL_MINUTES = Number(process.env.INTENT_TTL_MINUTES || 30);
const LIVE_INTENT_STATUSES = ["prepared", "submitted"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_, file, cb) =>
    file.mimetype === "application/pdf"
      ? cb(null, true)
      : cb(Object.assign(new Error("Only PDF certificates are accepted"), { status: 400 }), false),
});

// ── Validation ───────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const field = (max = 500) => Joi.string().allow("").max(max);

const metadataSchema = Joi.object({
  certificateType: Joi.string().valid(...CERTIFICATE_TYPES).required(),
  holderName: Joi.string().trim().min(2).max(200).required(),
  certificateNumber: field(200),
  holderIdentifier: field(200),
  institutionName: field(300),
  institutionAddress: field(500),
  courseName: field(300),
  qualification: field(300),
  qualificationLevel: field(100),
  specialization: field(300),
  grade: field(100),
  percentage: field(20),
  issueDate: Joi.string().allow("").pattern(DATE_RE).message("issueDate must be YYYY-MM-DD"),
  expiryDate: Joi.string().allow("").pattern(DATE_RE).message("expiryDate must be YYYY-MM-DD"),
  academicYear: field(50),
  signatoryName: field(200),
  signatoryDesignation: field(200),
  extraData: Joi.object().pattern(Joi.string().max(100), Joi.string().allow("").max(1000)).default({}),
});

const confirmSchema = Joi.object({
  certificateId: Joi.string().pattern(/^CERT-[0-9A-F]{8}$/).required(),
  txHash: Joi.string().pattern(/^0x[0-9a-fA-F]{64}$/).required(),
});

/** The 17 base fields as plain strings ("" for anything absent). */
function baseFields(metadata) {
  const out = {};
  for (const key of CERTIFICATE_FIELDS) out[key] = String(metadata[key] ?? "").trim();
  return out;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ── Extraction (suggestions only — human approval is mandatory) ──

router.post(
  "/extract",
  protect,
  loadCurrentUser,
  requireRoles("issuer", "institution_admin"),
  upload.single("document"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw httpError(400, "Upload a PDF certificate in the 'document' field");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nosih-"));
    const filePath = path.join(dir, "upload.pdf");
    try {
      fs.writeFileSync(filePath, req.file.buffer);
      const result = await extractCertificateMetadata(filePath, req.file.originalname);
      res.json({
        ...result,
        disclaimer:
          "AI extraction is a convenience, not proof of authenticity. Review and correct every field before issuing.",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })
);

// ── Field contract for the review form ───────────────────

router.get(
  "/meta/templates",
  protect,
  loadCurrentUser,
  asyncHandler(async (_req, res) => {
    res.json({
      fields: CERTIFICATE_FIELDS,
      descriptions: FIELD_DESCRIPTIONS,
      types: CERTIFICATE_TYPES,
      templates: CERTIFICATE_TEMPLATES,
    });
  })
);

// ── PREPARE ──────────────────────────────────────────────

router.post(
  "/issue/prepare",
  protect,
  loadCurrentUser,
  requireIssuerWallet,
  upload.single("document"),
  asyncHandler(async (req, res) => {
    assertCertificateSecrets();
    const contractAddress = getContractAddress(); // fail fast (503) before any upload work

    if (!req.file) throw httpError(400, "Upload the certificate PDF in the 'document' field");

    let metadata;
    try {
      metadata = JSON.parse(req.body.metadata ?? "{}");
    } catch {
      throw httpError(400, "metadata must be a JSON string");
    }
    const { error: validationError, value } = metadataSchema.validate(metadata, { abortEarly: false });
    if (validationError) {
      throw httpError(400, validationError.details.map((d) => d.message).join("; "));
    }

    const supersedesCertificateId = String(req.body.supersedesCertificateId ?? "").trim().toUpperCase() || null;
    if (supersedesCertificateId && !isCertificateId(supersedesCertificateId)) {
      throw httpError(400, "supersedesCertificateId must look like CERT-XXXXXXXX");
    }

    const institution = req.institution;
    const fields = baseFields(value);
    const extraData = value.extraData ?? {};

    // Original bytes: validated, then hashed EXACTLY as uploaded.
    const { buffer: pdfBuffer } = await validatePdf(req.file.buffer);
    const documentHash = computeDocumentHash(pdfBuffer);

    // ── Duplicate guards ──
    const { data: existingCert, error: certErr } = await supabase
      .from("certificates")
      .select("certificate_id, institution_id")
      .eq("document_hash", documentHash)
      .maybeSingle();
    if (certErr) throw httpError(500, certErr.message);
    if (existingCert) {
      throw httpError(409, `This exact PDF is already registered as ${existingCert.certificate_id}`);
    }

    const nowIso = new Date().toISOString();
    const { data: liveIntent, error: intentErr } = await supabase
      .from("issuance_intents")
      .select("certificate_id, status, expires_at")
      .eq("document_hash", documentHash)
      .in("status", LIVE_INTENT_STATUSES)
      .gt("expires_at", nowIso)
      .maybeSingle();
    if (intentErr) throw httpError(500, intentErr.message);
    if (liveIntent) {
      throw httpError(
        409,
        `An issuance for this exact PDF is already in progress (${liveIntent.certificate_id}, ${liveIntent.status}). Confirm or let it expire before preparing another.`
      );
    }

    if (fields.certificateNumber) {
      const { data: dupNumber, error: numErr } = await supabase
        .from("certificates")
        .select("certificate_id")
        .eq("institution_id", institution.id)
        .eq("certificate_number", fields.certificateNumber)
        .maybeSingle();
      if (numErr) throw httpError(500, numErr.message);
      if (dupNumber && dupNumber.certificate_id !== supersedesCertificateId) {
        throw httpError(409, `Certificate number ${fields.certificateNumber} is already registered by your institution (${dupNumber.certificate_id}). Use reissue to correct it.`);
      }

      const { data: dupIntentNumber, error: dupIntentErr } = await supabase
        .from("issuance_intents")
        .select("certificate_id, status")
        .eq("institution_id", institution.id)
        .in("status", LIVE_INTENT_STATUSES)
        .gt("expires_at", nowIso)
        .filter("certificate_payload->>certificateNumber", "eq", fields.certificateNumber)
        .maybeSingle();
      if (dupIntentErr) throw httpError(500, dupIntentErr.message);
      if (dupIntentNumber) {
        throw httpError(409, `Certificate number ${fields.certificateNumber} already has an issuance in progress (${dupIntentNumber.certificate_id})`);
      }
    }

    // ── Reissuance target ──
    let supersedesCertificateIdHash = ZERO;
    if (supersedesCertificateId) {
      const { data: target, error: targetErr } = await supabase
        .from("certificates")
        .select("certificate_id, certificate_id_hash, institution_id, status, superseded_by_certificate_id")
        .eq("certificate_id", supersedesCertificateId)
        .maybeSingle();
      if (targetErr) throw httpError(500, targetErr.message);
      if (!target) throw httpError(404, `Certificate ${supersedesCertificateId} does not exist`);
      if (target.institution_id !== institution.id) {
        throw httpError(403, "You can only reissue certificates from your own institution");
      }
      if (target.superseded_by_certificate_id) {
        throw httpError(409, `${supersedesCertificateId} was already superseded by ${target.superseded_by_certificate_id}`);
      }
      if (target.status === "revoked") {
        throw httpError(400, "A revoked certificate cannot be reissued — issue a new certificate instead");
      }

      // The chain must know the target too (it enforces supersedes existence).
      const chainTarget = await readCertificate(target.certificate_id_hash);
      if (!chainTarget) throw httpError(409, `${supersedesCertificateId} is not confirmed on-chain, so it cannot be superseded`);
      if (chainTarget.revoked) throw httpError(400, "A revoked certificate cannot be reissued on-chain");
      supersedesCertificateIdHash = target.certificate_id_hash;
    }

    // ── Chain expiry (0 = does not expire) ──
    let chainExpiresAt = 0;
    if (fields.expiryDate) {
      chainExpiresAt = Math.floor(Date.parse(`${fields.expiryDate}T23:59:59Z`) / 1000);
      if (!Number.isFinite(chainExpiresAt)) throw httpError(400, "expiryDate is not a valid date");
      if (chainExpiresAt <= Math.floor(Date.now() / 1000)) {
        throw httpError(400, "expiryDate is in the past — the contract rejects expiry before issuance");
      }
    }

    // ── Hashes (institution binding is part of the metadata hash) ──
    const metadataHash = computeMetadataHash({ ...fields, extraData }, institution.institution_id_hash);
    const holderIdentityHash = computeHolderIdentityHash(fields.holderName, fields.holderIdentifier);

    // ── Fresh random id (never derived from PII) ──
    let certificateId = null;
    for (let attempt = 0; attempt < 5 && !certificateId; attempt++) {
      const candidate = generateCertificateId();
      const [{ data: c }, { data: i }] = await Promise.all([
        supabase.from("certificates").select("id").eq("certificate_id", candidate).maybeSingle(),
        supabase.from("issuance_intents").select("id").eq("certificate_id", candidate).maybeSingle(),
      ]);
      if (!c && !i) certificateId = candidate;
    }
    if (!certificateId) throw httpError(500, "Could not allocate a certificate id — retry");
    const certificateIdHash = generateCertificateIdHash(certificateId);

    // ── Encrypt → IPFS (permanent) → private storage mirror (cache) ──
    const { ciphertext, iv, tag } = encryptCertificate(pdfBuffer);
    const ipfsCid = await uploadToIPFS(ciphertext, `${certificateId}.enc`, "application/octet-stream");
    await ensureCertificatesBucket();
    await storeEncryptedCertificate(certificateId, ciphertext);

    // ── The intent pins every value the confirm stage will verify ──
    const expiresAt = new Date(Date.now() + INTENT_TTL_MINUTES * 60 * 1000).toISOString();
    const payload = { ...fields, extraData };
    const { data: intent, error: insertErr } = await supabase
      .from("issuance_intents")
      .insert({
        certificate_id: certificateId,
        certificate_id_hash: certificateIdHash,
        institution_id: institution.id,
        institution_id_hash: institution.institution_id_hash,
        issuer_user_id: req.userId,
        issuer_wallet: req.issuerWallet,
        certificate_payload: payload,
        document_hash: documentHash,
        metadata_hash: metadataHash,
        holder_identity_hash: holderIdentityHash,
        ipfs_cid: ipfsCid,
        encryption_iv: iv,
        encryption_tag: tag,
        original_filename: req.file.originalname ?? null,
        supersedes_certificate_id: supersedesCertificateId,
        chain_expires_at: chainExpiresAt,
        status: "prepared",
        expires_at: expiresAt,
      })
      .select("*")
      .single();
    if (insertErr) {
      if (isUniqueViolation(insertErr)) throw httpError(409, "A conflicting issuance intent already exists — retry");
      throw httpError(500, insertErr.message);
    }

    console.log(`[issue/prepare] ${certificateId} pinned (${ipfsCid}) for ${req.issuerWallet}`);

    // The exact issueCertificate argument. The contract stamps issuer/issuedAt
    // itself; the values here for those fields are ignored on-chain.
    res.status(201).json({
      certificateId,
      intentExpiresAt: expiresAt,
      contractAddress,
      chainId: CHAIN_ID,
      issuerWallet: req.issuerWallet,
      issueArgs: {
        certificateIdHash,
        institutionIdHash: institution.institution_id_hash,
        holderIdentityHash,
        documentHash,
        metadataHash,
        ipfsCID: ipfsCid,
        issuer: req.issuerWallet,
        issuedAt: 0,
        expiresAt: chainExpiresAt,
        revoked: false,
        exists: false,
        supersedesCertificateIdHash,
      },
      intent: intentFromRow(intent),
    });
  })
);

// ── CONFIRM ──────────────────────────────────────────────

/** Maps the pinned payload + verified receipt to a certificates insert. */
function certificateInsertFromIntent(intent, verification, qr) {
  const p = intent.certificate_payload ?? {};
  const dateOrNull = (v) => (DATE_RE.test(String(v ?? "")) ? v : null);
  return {
    certificate_id: intent.certificate_id,
    certificate_id_hash: intent.certificate_id_hash,
    institution_id: intent.institution_id,
    institution_id_hash: intent.institution_id_hash,
    issuer_user_id: intent.issuer_user_id,
    issuer_wallet: intent.issuer_wallet,
    holder_name: p.holderName,
    holder_identity_hash: intent.holder_identity_hash,
    holder_identifier: p.holderIdentifier || null,
    certificate_type: p.certificateType,
    certificate_number: p.certificateNumber || null,
    course_name: p.courseName || null,
    qualification: p.qualification || null,
    qualification_level: p.qualificationLevel || null,
    specialization: p.specialization || null,
    grade: p.grade || null,
    percentage: p.percentage || null,
    issue_date: dateOrNull(p.issueDate),
    expiry_date: dateOrNull(p.expiryDate),
    academic_year: p.academicYear || null,
    signatory_name: p.signatoryName || null,
    signatory_designation: p.signatoryDesignation || null,
    extra_data: p.extraData ?? {},
    document_hash: intent.document_hash,
    metadata_hash: intent.metadata_hash,
    ipfs_cid: intent.ipfs_cid,
    encryption_iv: intent.encryption_iv,
    encryption_tag: intent.encryption_tag,
    original_filename: intent.original_filename,
    tx_hash: verification.txHash,
    block_number: verification.blockNumber,
    issued_at: new Date(verification.issuedAt * 1000).toISOString(),
    chain_expires_at: intent.chain_expires_at,
    status: "active",
    supersedes_certificate_id: intent.supersedes_certificate_id,
    qr_code_data: qr?.qrDataUrl ?? null,
    verify_url: qr?.verifyUrl ?? null,
  };
}

router.post(
  "/issue/confirm",
  protect,
  loadCurrentUser,
  requireIssuerWallet,
  asyncHandler(async (req, res) => {
    const { error: validationError, value } = confirmSchema.validate(req.body ?? {});
    if (validationError) throw httpError(400, validationError.details.map((d) => d.message).join("; "));
    const { certificateId, txHash } = value;

    const { data: intent, error } = await supabase
      .from("issuance_intents")
      .select("*")
      .eq("certificate_id", certificateId)
      .maybeSingle();
    if (error) throw httpError(500, error.message);
    if (!intent) throw httpError(404, `No issuance intent for ${certificateId}`);
    if (intent.institution_id !== req.userInstitutionId) {
      throw httpError(403, "This issuance belongs to another institution");
    }
    if (intent.issuer_user_id !== req.userId && intent.issuer_wallet !== req.issuerWallet) {
      throw httpError(403, "This issuance was prepared by a different issuer");
    }

    const fetchCertificate = async () => {
      const { data, error: fetchErr } = await supabase
        .from("certificates")
        .select("*, institutions(*)")
        .eq("certificate_id", certificateId)
        .maybeSingle();
      if (fetchErr) throw httpError(500, fetchErr.message);
      return data;
    };

    // ── Idempotent: already confirmed → return the existing certificate ──
    if (intent.status === "confirmed") {
      const row = await fetchCertificate();
      return res.json({ state: "confirmed", alreadyConfirmed: true, certificate: certificateFromRow(row) });
    }
    if (intent.status === "failed") {
      throw httpError(409, `This issuance was rejected: ${intent.failure_reason || "receipt verification failed"}. Prepare a new issuance.`);
    }
    if (intent.status === "expired") {
      throw httpError(410, "This issuance intent expired. Prepare a new issuance.");
    }

    const pastTtl = new Date(intent.expires_at).getTime() < Date.now();
    if (intent.status === "prepared" && pastTtl) {
      await supabase.from("issuance_intents").update({ status: "expired" }).eq("id", intent.id);
      throw httpError(410, "This issuance intent expired before the transaction was submitted. Prepare a new issuance.");
    }
    // A SUBMITTED intent past its TTL is still verified: the chain may have
    // confirmed it, and the certificate must not be orphaned (reconciliation).

    // ── Persist the claimed tx BEFORE verification (recovery anchor) ──
    if (intent.tx_hash !== txHash || intent.status !== "submitted") {
      const { error: markErr } = await supabase
        .from("issuance_intents")
        .update({ tx_hash: txHash, status: "submitted" })
        .eq("id", intent.id);
      if (markErr) throw httpError(500, markErr.message);
    }

    // ── Independent on-chain verification — the client's word is never trusted ──
    const verification = await verifyIssuanceReceipt({
      txHash,
      expected: {
        certificateIdHash: intent.certificate_id_hash,
        documentHash: intent.document_hash,
        metadataHash: intent.metadata_hash,
        institutionIdHash: intent.institution_id_hash,
        issuerWallet: intent.issuer_wallet,
        ipfsCID: intent.ipfs_cid,
        chainExpiresAt: intent.chain_expires_at,
        supersedesCertificateIdHash: intent.supersedes_certificate_id
          ? generateCertificateIdHash(intent.supersedes_certificate_id)
          : ZERO,
      },
    });
    // ChainUnavailableError propagates as 503; the intent stays 'submitted'
    // with its tx_hash so confirm can be retried safely.

    if (verification.state === "pending") {
      return res.status(202).json({
        state: "pending",
        certificateId,
        txHash,
        message: verification.reason,
      });
    }
    if (verification.state === "rejected") {
      await supabase
        .from("issuance_intents")
        .update({ status: "failed", failure_reason: verification.reason })
        .eq("id", intent.id);
      throw httpError(409, `Issuance rejected: ${verification.reason}`);
    }

    // ── Chain confirmed → persist the authoritative certificate row ──
    let qr = null;
    try {
      qr = await generateCertificateQr(certificateId, req);
    } catch (err) {
      console.warn(`[issue/confirm] QR generation failed for ${certificateId}:`, err.message);
    }

    const { data: row, error: insertErr } = await supabase
      .from("certificates")
      .insert(certificateInsertFromIntent(intent, verification, qr))
      .select("*, institutions(*)")
      .single();

    let certificateRow = row;
    if (insertErr) {
      if (!isUniqueViolation(insertErr)) {
        // The chain HAS the certificate. Keep the intent submitted with its
        // tx_hash and tell the client exactly how to recover.
        console.error(`[issue/confirm] DB persist failed after chain confirmation for ${certificateId}:`, insertErr.message);
        return res.status(500).json({
          error: "The certificate is confirmed on-chain but could not be saved to the database yet. Retry confirm — it is safe and idempotent.",
          certificateId,
          txHash,
          recovery: "POST /api/certificates/issue/confirm with the same certificateId and txHash",
        });
      }
      // Concurrent confirm already inserted it — idempotent success.
      certificateRow = await fetchCertificate();
      if (!certificateRow) throw httpError(500, insertErr.message);
    }

    // ── Audit events + reissuance bookkeeping (non-fatal after the row exists) ──
    try {
      await supabase.from("certificate_events").insert({
        certificate_id: certificateId,
        event_type: "issued",
        performed_by: req.userId,
        institution_id: intent.institution_id,
        transaction_hash: txHash,
        new_status: "active",
        details: intent.supersedes_certificate_id ? { supersedes: intent.supersedes_certificate_id } : {},
      });

      if (intent.supersedes_certificate_id) {
        await supabase
          .from("certificates")
          .update({ status: "superseded", superseded_by_certificate_id: certificateId })
          .eq("certificate_id", intent.supersedes_certificate_id);
        await supabase.from("certificate_events").insert({
          certificate_id: intent.supersedes_certificate_id,
          event_type: "superseded",
          performed_by: req.userId,
          institution_id: intent.institution_id,
          previous_status: "active",
          new_status: "superseded",
          details: { supersededBy: certificateId },
        });
      }
    } catch (err) {
      console.warn(`[issue/confirm] audit bookkeeping warning for ${certificateId}:`, err.message);
    }

    await supabase
      .from("issuance_intents")
      .update({ status: "confirmed", block_number: verification.blockNumber })
      .eq("id", intent.id);

    console.log(`[issue/confirm] ✓ ${certificateId} confirmed in block ${verification.blockNumber} (${txHash})`);
    res.status(201).json({
      state: "confirmed",
      alreadyConfirmed: Boolean(insertErr),
      certificate: certificateFromRow(certificateRow),
    });
  })
);

// ── Intent status / recovery ─────────────────────────────

router.get(
  "/issue/intents/:certificateId",
  protect,
  loadCurrentUser,
  asyncHandler(async (req, res) => {
    const certificateId = String(req.params.certificateId ?? "").toUpperCase();
    if (!isCertificateId(certificateId)) throw httpError(400, "Certificate ID must look like CERT-XXXXXXXX");

    const { data: intent, error } = await supabase
      .from("issuance_intents")
      .select("*")
      .eq("certificate_id", certificateId)
      .maybeSingle();
    if (error) throw httpError(500, error.message);
    if (!intent) throw httpError(404, `No issuance intent for ${certificateId}`);

    const isPlatformAdmin = req.userRole === "platform_admin";
    if (!isPlatformAdmin && intent.institution_id !== req.userInstitutionId) {
      throw httpError(403, "This issuance belongs to another institution");
    }

    const effectiveStatus =
      intent.status === "prepared" && new Date(intent.expires_at).getTime() < Date.now()
        ? "expired"
        : intent.status;

    res.json({ intent: intentFromRow(intent), effectiveStatus });
  })
);

// ── List (institution-scoped) ────────────────────────────

router.get(
  "/",
  protect,
  loadCurrentUser,
  asyncHandler(async (req, res) => {
    const isPlatformAdmin = req.userRole === "platform_admin";
    let institutionId = req.userInstitutionId;

    if (isPlatformAdmin && req.query.institutionId) {
      const key = String(req.query.institutionId);
      const column = key.startsWith("INST-") ? "institution_id" : "id";
      const { data: inst, error } = await supabase
        .from("institutions")
        .select("id")
        .eq(column, key)
        .maybeSingle();
      if (error) throw httpError(500, error.message);
      if (!inst) throw httpError(404, "Institution not found");
      institutionId = inst.id;
    } else if (!isPlatformAdmin && !institutionId) {
      throw httpError(403, "No institution associated with this account");
    }

    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    let query = supabase
      .from("certificates")
      .select("*, institutions(name, institution_id, verification_status)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (institutionId) query = query.eq("institution_id", institutionId);
    if (req.query.status) query = query.eq("status", String(req.query.status));
    if (req.query.type) query = query.eq("certificate_type", String(req.query.type));
    if (req.query.q) {
      const q = String(req.query.q).replace(/[%,]/g, "").slice(0, 100);
      query = query.or(`holder_name.ilike.%${q}%,certificate_id.ilike.%${q}%,certificate_number.ilike.%${q}%`);
    }

    const { data, error, count } = await query;
    if (error) throw httpError(500, error.message);

    res.json({
      certificates: (data ?? []).map(certificateFromRow),
      total: count ?? 0,
      page,
      limit,
    });
  })
);

// ── Detail / document / QR (institution members only) ────

async function loadScopedCertificate(req) {
  const certificateId = String(req.params.certificateId ?? "").toUpperCase();
  if (!isCertificateId(certificateId)) throw httpError(400, "Certificate ID must look like CERT-XXXXXXXX");

  const { data: row, error } = await supabase
    .from("certificates")
    .select("*, institutions(*)")
    .eq("certificate_id", certificateId)
    .maybeSingle();
  if (error) throw httpError(500, error.message);
  if (!row) throw httpError(404, `Certificate ${certificateId} not found`);

  const isPlatformAdmin = req.userRole === "platform_admin";
  if (!isPlatformAdmin && row.institution_id !== req.userInstitutionId) {
    throw httpError(403, "This certificate belongs to another institution");
  }
  return row;
}

router.get(
  "/:certificateId",
  protect,
  loadCurrentUser,
  asyncHandler(async (req, res) => {
    const row = await loadScopedCertificate(req);
    const { data: events, error } = await supabase
      .from("certificate_events")
      .select("*")
      .eq("certificate_id", row.certificate_id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw httpError(500, error.message);

    res.json({
      certificate: certificateFromRow(row),
      events: (events ?? []).map(certificateEventFromRow),
    });
  })
);

router.get(
  "/:certificateId/document",
  protect,
  loadCurrentUser,
  asyncHandler(async (req, res) => {
    const row = await loadScopedCertificate(req);

    const file = await getEncryptedCertificate(row);
    const pdf = decryptCertificate(file.buffer, row.encryption_iv, row.encryption_tag);
    if (computeDocumentHash(pdf) !== row.document_hash) {
      throw httpError(500, "Stored document failed its integrity check against the registered hash");
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${row.certificate_id}.pdf"`);
    res.setHeader("X-Certificate-Id", row.certificate_id);
    res.setHeader("X-IPFS-CID", row.ipfs_cid);
    res.setHeader("X-Document-Source", file.sourceUrl);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(pdf);
  })
);

router.get(
  "/:certificateId/qr",
  protect,
  loadCurrentUser,
  asyncHandler(async (req, res) => {
    const row = await loadScopedCertificate(req);
    const { png } = await generateCertificateQr(row.certificate_id, req);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (req.query.download) {
      res.setHeader("Content-Disposition", `attachment; filename="${row.certificate_id}-QR.png"`);
    }
    res.send(png);
  })
);

// ── Revocation (D2: platform admin OR owning institution admin) ──
// The ONLY server-side chain write. Signed with the dedicated REVOKE_PRIVATE_KEY
// (REVOKER_ROLE) — never an issuer's browser key. Only the reason HASH goes
// on-chain; the explanation stays private in certificate_events.

const revokeSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(1000).required(),
});

router.post(
  "/:certificateId/revoke",
  protect,
  loadCurrentUser,
  requireRoles("platform_admin", "institution_admin"),
  asyncHandler(async (req, res) => {
    const { error: validationError, value } = revokeSchema.validate(req.body ?? {});
    if (validationError) throw httpError(400, "A revocation reason is required (3–1000 characters)");

    const row = await loadScopedCertificate(req); // institution scoping enforced
    if (row.status === "revoked") throw httpError(409, `${row.certificate_id} is already revoked`);

    // Chain state first — it is authoritative for revocation.
    const chain = await readCertificate(row.certificate_id_hash);
    if (!chain) throw httpError(409, `${row.certificate_id} is not confirmed on-chain, so it cannot be revoked`);

    const reasonHash = computeRevocationReasonHash(value.reason);
    let txHash = row.revoked_tx_hash || null;

    if (!chain.revoked) {
      // Missing REVOKE_PRIVATE_KEY → ChainConfigError → clear 503, never fake success.
      const result = await revokeCertificateOnChain(row.certificate_id_hash, reasonHash);
      txHash = result.txHash;
    }
    // chain.revoked already true → reconciliation path: complete the DB mirror
    // of a revocation that landed on-chain but was not persisted (retry-safe).

    const revokedAt = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("certificates")
      .update({ status: "revoked", revoked_at: revokedAt, revoke_reason: value.reason, revoked_tx_hash: txHash })
      .eq("certificate_id", row.certificate_id);
    if (updateErr) {
      console.error(`[revoke] DB mirror failed after chain revocation of ${row.certificate_id}:`, updateErr.message);
      return res.status(500).json({
        error: "The certificate is revoked on-chain but the database mirror failed. Retry revoke — it reconciles safely.",
        certificateId: row.certificate_id,
        txHash,
        recovery: `POST /api/certificates/${row.certificate_id}/revoke with the same reason`,
      });
    }

    try {
      await supabase.from("certificate_events").insert({
        certificate_id: row.certificate_id,
        event_type: "revoked",
        performed_by: req.userId,
        institution_id: row.institution_id,
        reason: value.reason, // private — never on-chain
        transaction_hash: txHash,
        previous_status: row.status,
        new_status: "revoked",
      });
    } catch (err) {
      console.warn(`[revoke] audit event warning for ${row.certificate_id}:`, err.message);
    }

    console.log(`[revoke] ✓ ${row.certificate_id} revoked (${txHash})`);
    res.json({ certificateId: row.certificate_id, status: "revoked", txHash, revokedAt });
  })
);

// ── Reissuance prefill (D8) ──────────────────────────────
// Returns the old approved metadata so IssuePage can prefill a NEW prepare
// with supersedesCertificateId. The old chain record is never modified; the
// supersede link is written when the new certificate confirms (P6 confirm).

router.post(
  "/:certificateId/reissue",
  protect,
  loadCurrentUser,
  requireRoles("issuer", "institution_admin"),
  asyncHandler(async (req, res) => {
    const row = await loadScopedCertificate(req);
    if (row.status === "revoked") {
      throw httpError(400, "A revoked certificate cannot be reissued — issue a new certificate instead");
    }
    if (row.superseded_by_certificate_id) {
      throw httpError(409, `${row.certificate_id} was already superseded by ${row.superseded_by_certificate_id}`);
    }

    res.json({
      supersedesCertificateId: row.certificate_id,
      fields: {
        certificateType: row.certificate_type,
        certificateNumber: row.certificate_number ?? "",
        holderName: row.holder_name,
        holderIdentifier: row.holder_identifier ?? "",
        institutionName: row.institutions?.name ?? "",
        institutionAddress: row.institutions?.address ?? "",
        courseName: row.course_name ?? "",
        qualification: row.qualification ?? "",
        qualificationLevel: row.qualification_level ?? "",
        specialization: row.specialization ?? "",
        grade: row.grade ?? "",
        percentage: row.percentage ?? "",
        issueDate: row.issue_date ?? "",
        expiryDate: row.expiry_date ?? "",
        academicYear: row.academic_year ?? "",
        signatoryName: row.signatory_name ?? "",
        signatoryDesignation: row.signatory_designation ?? "",
      },
      extraData: row.extra_data ?? {},
      target: {
        certificateId: row.certificate_id,
        holderName: row.holder_name,
        certificateType: row.certificate_type,
        status: row.status,
        txHash: row.tx_hash,
      },
      note: "Upload the corrected PDF and run prepare with supersedesCertificateId. The original stays on-chain untouched; verification of the old id will point to the new one.",
    });
  })
);

export default router;