/**
 * NOSIH verification service — CHAIN-AUTHORITATIVE.
 *
 * The blockchain decides: existence, issuer, fingerprints, revocation,
 * timestamps. Supabase supplies the approved public metadata and the
 * document index — a database row alone can NEVER make a certificate
 * authentic. When the chain cannot be reached the verdict is INDETERMINATE
 * (503), never "valid from the database".
 *
 * The decision logic is a pure function (decideVerdict / tamperVerdict) so
 * every verdict branch is testable without a database; the orchestrators
 * fetch chain + row and apply it. No AI anywhere in integrity checking.
 */

import "../env.js"; // loads the repository-root .env — must come first
import { supabase } from "../supabase.js";
import { readCertificate, CHAIN_ID, getContractAddress, ChainUnavailableError } from "./blockchain.js";
import { isCertificateId, generateCertificateIdHash, computeDocumentHash, decryptCertificate } from "./certificateIdentity.js";
import { getEncryptedCertificate } from "./certificateStorage.js";

// ── Verdicts ─────────────────────────────────────────────

export const VERDICTS = {
  "authentic-active": { label: "Authentic and Active", httpStatus: 200 },
  revoked: { label: "Certificate Revoked", httpStatus: 200 },
  expired: { label: "Certificate Expired", httpStatus: 200 },
  superseded: { label: "Certificate Superseded (Reissued)", httpStatus: 200 },
  "document-mismatch": { label: "Document Hash Mismatch", httpStatus: 200 },
  "metadata-mismatch": { label: "Metadata Mismatch", httpStatus: 200 },
  "issuer-unauthorized": { label: "Issuer Unauthorized", httpStatus: 200 },
  "not-found": { label: "Certificate Not Found", httpStatus: 404 },
  "db-chain-mismatch": { label: "Database/Blockchain Mismatch", httpStatus: 200 },
  "blockchain-unavailable": { label: "Blockchain Unavailable — Indeterminate", httpStatus: 503 },
};

export const DISCLAIMER =
  "Verification is anchored to the Polygon Amoy blockchain. A matching fingerprint proves the document " +
  "matches the registered original; it does not independently prove the underlying award was legitimate. " +
  "Revocation and expiry are decided by the chain, not by this database.";

const eq = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Pure verdict decision. `chain` is the mapped on-chain certificate (or null),
 * `row` the Supabase certificates row (or null). Revocation is checked FIRST
 * among status conditions: a revoked certificate always returns revoked.
 */
export function decideVerdict({ chain, row, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const flags = {
    onChain: Boolean(chain),
    inDatabase: Boolean(row),
    documentHashMatch: Boolean(chain && row && eq(chain.documentHash, row.document_hash)),
    metadataHashMatch: Boolean(chain && row && eq(chain.metadataHash, row.metadata_hash)),
    issuerAuthorized: Boolean(chain && row && eq(chain.issuer, row.issuer_wallet)),
    institutionMatch: Boolean(chain && row && eq(chain.institutionIdHash, row.institution_id_hash)),
    ipfsCidMatch: Boolean(chain && row && chain.ipfsCID === row.ipfs_cid),
    revoked: Boolean(chain?.revoked),
    expired: Boolean(chain && Number(chain.expiresAt) !== 0 && nowSeconds > Number(chain.expiresAt)),
    superseded: Boolean(row?.superseded_by_certificate_id),
  };

  let verdict;
  if (!chain && !row) verdict = "not-found";
  else if (!chain || !row) verdict = "db-chain-mismatch"; // one side knows it, the other does not
  else if (flags.revoked) verdict = "revoked";
  else if (!flags.documentHashMatch) verdict = "document-mismatch";
  else if (!flags.metadataHashMatch) verdict = "metadata-mismatch";
  else if (!flags.issuerAuthorized) verdict = "issuer-unauthorized";
  else if (!flags.institutionMatch || !flags.ipfsCidMatch) verdict = "db-chain-mismatch";
  else if (flags.superseded) verdict = "superseded";
  else if (flags.expired) verdict = "expired";
  else verdict = "authentic-active";

  return { verdict, flags };
}

/**
 * Pure Mode-B tamper decision: uploaded PDF fingerprint vs the CHAIN hash.
 * `registeredElsewhere` is a certificates row whose document_hash equals the
 * uploaded hash but under a different certificate id (or null).
 */
export function tamperVerdict({ chain, row, uploadedHash, registeredElsewhere, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!chain) {
    return { verdict: "not-found", match: false, label: "Certificate Not Found" };
  }
  const match = eq(uploadedHash, chain.documentHash);
  if (match) {
    if (chain.revoked) return { verdict: "revoked", match: true, label: "Registered But Revoked" };
    if (row?.superseded_by_certificate_id) {
      return { verdict: "superseded", match: true, label: "Registered But Superseded", supersededByCertificateId: row.superseded_by_certificate_id };
    }
    if (Number(chain.expiresAt) !== 0 && nowSeconds > Number(chain.expiresAt)) {
      return { verdict: "expired", match: true, label: "Registered But Expired" };
    }
    return { verdict: "exact-match", match: true, label: "Exact Registered Document" };
  }
  if (registeredElsewhere) {
    return {
      verdict: "registered-under-different-id",
      match: false,
      label: "Registered Under A Different Certificate",
      registeredCertificateId: registeredElsewhere.certificate_id,
    };
  }
  return { verdict: "modified", match: false, label: "Modified Or Unregistered Document" };
}

// ── Public payload (explicit allow-list — never PII beyond the award) ──

function publicCertificate(row) {
  if (!row) return null;
  return {
    holderName: row.holder_name,
    certificateType: row.certificate_type,
    certificateNumber: row.certificate_number || undefined,
    courseName: row.course_name || undefined,
    qualification: row.qualification || undefined,
    qualificationLevel: row.qualification_level || undefined,
    specialization: row.specialization || undefined,
    grade: row.grade || undefined,
    percentage: row.percentage || undefined,
    issueDate: row.issue_date || undefined,
    expiryDate: row.expiry_date || undefined,
    academicYear: row.academic_year || undefined,
    signatoryName: row.signatory_name || undefined,
    signatoryDesignation: row.signatory_designation || undefined,
  };
}

function buildPayload({ certificateId, chain, row, verdict, flags, contractAddress }) {
  const meta = VERDICTS[verdict];
  const authentic = verdict === "authentic-active";
  return {
    found: Boolean(chain),
    certificateId,
    verdict,
    verdictLabel: meta.label,
    authentic,
    documentHashMatch: flags.documentHashMatch,
    metadataHashMatch: flags.metadataHashMatch,
    issuerAuthorized: flags.issuerAuthorized,
    institution: row?.institutions
      ? {
          name: row.institutions.name,
          institutionId: row.institutions.institution_id,
          verified: row.institutions.verification_status === "approved",
        }
      : undefined,
    certificate: publicCertificate(row),
    status: verdict === "authentic-active" ? "active" : verdict,
    revoked: flags.revoked,
    expired: flags.expired,
    superseded: flags.superseded,
    supersededByCertificateId: row?.superseded_by_certificate_id || undefined,
    supersedesCertificateId: row?.supersedes_certificate_id || undefined,
    issuerWallet: chain?.issuer,
    transactionHash: row?.tx_hash,
    blockNumber: row?.block_number ?? undefined,
    issuedAt: chain ? new Date(Number(chain.issuedAt) * 1000).toISOString() : undefined,
    expiresAt: chain && Number(chain.expiresAt) !== 0 ? new Date(Number(chain.expiresAt) * 1000).toISOString() : undefined,
    documentHash: chain?.documentHash,
    chainId: CHAIN_ID,
    contractAddress,
    verifiedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}

async function fetchRow(certificateId) {
  const { data, error } = await supabase
    .from("certificates")
    .select("*, institutions(name, institution_id, verification_status)")
    .eq("certificate_id", certificateId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return data;
}

/** Lazily mirrors chain expiry into the DB status + audit trail (non-fatal). */
async function mirrorExpiry(row) {
  if (!row || row.status === "expired") return;
  try {
    await supabase.from("certificates").update({ status: "expired" }).eq("certificate_id", row.certificate_id);
    await supabase.from("certificate_events").insert({
      certificate_id: row.certificate_id,
      event_type: "expired",
      institution_id: row.institution_id,
      previous_status: row.status,
      new_status: "expired",
      details: { source: "chain-expiry-at-verification" },
    });
  } catch (err) {
    console.warn(`[verify] expiry mirror warning for ${row.certificate_id}:`, err.message);
  }
}

/** Public 'verified' audit event — async, never blocks or fails the verdict. */
function recordVerificationEvent(certificateId, verdict) {
  supabase
    .from("certificate_events")
    .insert({
      certificate_id: certificateId,
      event_type: "verified",
      performed_by: null, // public verification
      details: { verdict, source: "public-verify" },
    })
    .then(({ error }) => {
      if (error) console.warn(`[verify] audit event warning for ${certificateId}:`, error.message);
    })
    .catch(() => {});
}

/**
 * Public verification. Chain FIRST; the database only enriches.
 * `nowSeconds` defaults to the server clock; tests pass the chain's block
 * time so expiry is judged against the same clock that stamped the chain.
 * @returns {Promise<{httpStatus: number, payload: object, row: object|null}>}
 */
export async function verifyCertificate(certificateId, { provider, contractAddress, chainId, nowSeconds } = {}) {
  const id = String(certificateId ?? "").trim().toUpperCase();
  if (!isCertificateId(id)) {
    throw Object.assign(new Error("Certificate ID must look like CERT-XXXXXXXX"), { status: 400 });
  }

  const address = contractAddress || getContractAddress(); // ChainConfigError → 503

  let chain;
  try {
    chain = await readCertificate(generateCertificateIdHash(id), { provider, contractAddress: address, chainId });
  } catch (err) {
    if (err instanceof ChainUnavailableError) {
      const meta = VERDICTS["blockchain-unavailable"];
      return {
        httpStatus: meta.httpStatus,
        row: null,
        payload: {
          found: null,
          certificateId: id,
          verdict: "blockchain-unavailable",
          verdictLabel: meta.label,
          authentic: null, // INDETERMINATE — never true, never false-from-DB
          chainId: CHAIN_ID,
          verifiedAt: new Date().toISOString(),
          error: "The blockchain could not be reached. This result is INDETERMINATE — the certificate is NOT confirmed valid. Retry shortly.",
          disclaimer: DISCLAIMER,
        },
      };
    }
    throw err;
  }

  const row = await fetchRow(id);
  const { verdict, flags } = decideVerdict({ chain, row, nowSeconds });
  if (verdict === "expired") await mirrorExpiry(row);
  if (row) recordVerificationEvent(id, verdict); // FK requires the certificates row

  return {
    httpStatus: VERDICTS[verdict].httpStatus,
    row,
    payload: buildPayload({ certificateId: id, chain, row, verdict, flags, contractAddress: address }),
  };
}

/**
 * Mode A — stored-document integrity. Chain fingerprint → ciphertext from
 * storage/IPFS → decrypt → rehash → compare. Contents are NEVER returned.
 */
export async function tamperCheckStored(certificateId, { provider, contractAddress } = {}) {
  const id = String(certificateId ?? "").trim().toUpperCase();
  if (!isCertificateId(id)) {
    throw Object.assign(new Error("Certificate ID must look like CERT-XXXXXXXX"), { status: 400 });
  }
  const address = contractAddress || getContractAddress();
  const chain = await readCertificate(generateCertificateIdHash(id), { provider, contractAddress: address });
  if (!chain) throw Object.assign(new Error(`Certificate ${id} is not registered on-chain`), { status: 404 });

  const row = await fetchRow(id);
  if (!row) {
    throw Object.assign(new Error("The certificate exists on-chain but has no stored document index"), { status: 409 });
  }

  const file = await getEncryptedCertificate(row);
  const pdf = decryptCertificate(file.buffer, row.encryption_iv, row.encryption_tag);
  const storedHash = computeDocumentHash(pdf);
  const intact = eq(storedHash, chain.documentHash);

  return {
    certificateId: id,
    mode: "stored-document",
    intact,
    verdict: intact ? "intact" : "stored-document-mismatch",
    verdictLabel: intact ? "Stored Document Intact" : "Stored Document Does Not Match The Chain Fingerprint",
    revoked: chain.revoked,
    documentSource: file.sourceUrl,
    chainDocumentHash: chain.documentHash,
    verifiedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}

/**
 * Mode B — uploaded-PDF fingerprint vs the CHAIN hash. No AI, no decryption;
 * pure SHA-256 over the exact uploaded bytes.
 */
export async function tamperCheckUploaded(certificateId, uploadedBuffer, { provider, contractAddress, nowSeconds } = {}) {
  const id = String(certificateId ?? "").trim().toUpperCase();
  if (!isCertificateId(id)) {
    throw Object.assign(new Error("Certificate ID must look like CERT-XXXXXXXX"), { status: 400 });
  }
  if (!Buffer.isBuffer(uploadedBuffer) || uploadedBuffer.length === 0) {
    throw Object.assign(new Error("Upload a PDF document"), { status: 400 });
  }
  if (!uploadedBuffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw Object.assign(new Error("The uploaded file is not a PDF (magic bytes missing)"), { status: 400 });
  }

  const address = contractAddress || getContractAddress();
  const chain = await readCertificate(generateCertificateIdHash(id), { provider, contractAddress: address });
  const uploadedHash = computeDocumentHash(uploadedBuffer);

  if (!chain) {
    // The id is unknown to the chain — is the DOCUMENT registered elsewhere?
    const { data: elsewhere } = await supabase
      .from("certificates")
      .select("certificate_id")
      .eq("document_hash", uploadedHash)
      .maybeSingle();
    return {
      certificateId: id,
      mode: "uploaded-document",
      uploadedHash,
      ...tamperVerdict({ chain: null, row: null, uploadedHash, registeredElsewhere: elsewhere }),
      found: false,
      verifiedAt: new Date().toISOString(),
      disclaimer: DISCLAIMER,
    };
  }

  const row = await fetchRow(id);
  let registeredElsewhere = null;
  if (!eq(uploadedHash, chain.documentHash)) {
    const { data } = await supabase
      .from("certificates")
      .select("certificate_id")
      .eq("document_hash", uploadedHash)
      .neq("certificate_id", id)
      .maybeSingle();
    registeredElsewhere = data;
  }

  const decision = tamperVerdict({ chain, row, uploadedHash, registeredElsewhere, nowSeconds });
  return {
    certificateId: id,
    mode: "uploaded-document",
    uploadedHash,
    chainDocumentHash: chain.documentHash,
    found: true,
    revoked: chain.revoked,
    dbChainMismatch: Boolean(row && !eq(row.document_hash, chain.documentHash)),
    ...decision,
    verifiedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  };
}