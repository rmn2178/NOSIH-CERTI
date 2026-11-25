/**
 * NOSIH identity, hashing and certificate encryption.
 *
 * Three hash families, same design as the audited NOSIH system:
 * - KEYED hashes (HMAC-SHA256 with HASH_PEPPER) for low-entropy identity
 *   inputs: holder name/identifier, institution id, revocation reasons.
 *   A plain hash of a name on a public chain could be brute-forced; the
 *   server-side pepper makes that infeasible. Never exposed to the frontend.
 * - keccak256(utf8(humanId)) for the random CERT-XXXXXXXX / INST-XXXXXXXX
 *   identifiers that go on-chain as bytes32.
 * - SHA-256 over canonical JSON / exact bytes for metadata and documents,
 *   so anyone holding the same approved data can recompute them.
 *
 * Certificate PDFs are encrypted with AES-256-GCM before IPFS upload.
 * No personally identifiable information ever goes on-chain.
 */

import "../env.js"; // loads the repository-root .env — must come first
import crypto from "crypto";
import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";

const ZERO = ethers.ZeroHash;

function requireHexKey(name) {
  const value = process.env[name];
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be set in the root .env as 64 hex characters (32 bytes)`);
  }
  return Buffer.from(value, "hex");
}

// ── Normalization ───────────────────────────────────────

/** Uppercase, collapse whitespace, strip punctuation noise. */
export function norm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}/\-.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic canonical JSON for metadata hashing.
 * Object keys sorted at EVERY depth; arrays keep their order; strings are
 * normalized; null/undefined become ""; numbers and booleans pass through.
 * Two issuers approving the same metadata must get the same hash regardless
 * of key insertion order or nested extra_data layout.
 */
export function canonicalizeMetadata(value) {
  const walk = (v) => {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const sorted = {};
      for (const key of Object.keys(v).sort()) sorted[key] = walk(v[key]);
      return sorted;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    return norm(v);
  };
  return JSON.stringify(walk(value));
}

// ── Hash primitives ─────────────────────────────────────

const sha256Hex = (data) => "0x" + crypto.createHash("sha256").update(data).digest("hex");

function keyedHash(label, value) {
  return "0x" + crypto.createHmac("sha256", requireHexKey("HASH_PEPPER")).update(`${label}|${value}`).digest("hex");
}

/** keccak256 of the UTF-8 human id — the on-chain bytes32 form. */
export const idHash = (humanId) => ethers.keccak256(ethers.toUtf8Bytes(humanId));

// ── Human IDs (random — NEVER derived from names, DOBs or reg numbers) ──

const shortId = () => uuidv4().replace(/-/g, "").slice(0, 8).toUpperCase();

export const generateCertificateId = () => `CERT-${shortId()}`;
export const generateInstitutionId = () => `INST-${shortId()}`;

export const isCertificateId = (v) => /^CERT-[0-9A-F]{8}$/.test(String(v ?? ""));
export const isInstitutionId = (v) => /^INST-[0-9A-F]{8}$/.test(String(v ?? ""));

export const generateCertificateIdHash = (certificateId) => {
  if (!isCertificateId(certificateId)) throw new Error(`Invalid certificate id: ${certificateId}`);
  return idHash(certificateId);
};

// ── Certificate hashes ──────────────────────────────────

/** SHA-256 of the EXACT original uploaded PDF bytes (never OCR text/images). */
export const computeDocumentHash = (pdfBuffer) => {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error("Document hash requires the original PDF bytes");
  }
  return sha256Hex(pdfBuffer);
};

/**
 * SHA-256 over canonical approved metadata + institution identity.
 * Covers the institution binding per the NOSIH spec, so the same
 * metadata approved by two institutions produces two different hashes.
 */
export function computeMetadataHash(metadata, institutionIdHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(institutionIdHash ?? ""))) {
    throw new Error("Metadata hash requires the institution identity hash");
  }
  return sha256Hex(canonicalizeMetadata({ ...metadata, institutionIdHash }));
}

/** HMAC pseudonym for the holder — name + optional identifier, never plaintext on-chain. */
export function computeHolderIdentityHash(holderName, holderIdentifier = "") {
  const name = norm(holderName);
  if (!name) throw new Error("Holder name is required for the identity hash");
  const identifier = norm(holderIdentifier).replace(/\s+/g, "");
  return keyedHash("holder", `${name}|${identifier}`);
}

/** Stable per-institution pseudonym: HMAC over the random INST-XXXXXXXX id. */
export function computeInstitutionIdentityHash(institutionId) {
  if (!isInstitutionId(institutionId)) throw new Error(`Invalid institution id: ${institutionId}`);
  return keyedHash("institution", institutionId);
}

/**
 * Revocation reasons are low-entropy free text ("fraud", "error") — a plain
 * hash would be enumerable. Keyed HMAC keeps the reason private while the
 * on-chain reasonHash still commits to it.
 */
export function computeRevocationReasonHash(reason) {
  const text = String(reason ?? "").trim();
  if (!text) throw new Error("Revocation reason is required");
  return keyedHash("revocation-reason", text);
}

// ── Document encryption (AES-256-GCM) ───────────────────

export function encryptCertificate(plainBuffer) {
  const key = requireHexKey("DOCUMENT_ENC_KEY");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return { ciphertext, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

export function decryptCertificate(ciphertext, ivHex, tagHex) {
  const key = requireHexKey("DOCUMENT_ENC_KEY");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Fails fast when secrets are missing/malformed (called by routes, not at import). */
export function assertCertificateSecrets() {
  requireHexKey("DOCUMENT_ENC_KEY");
  requireHexKey("HASH_PEPPER");
}

export { ZERO };