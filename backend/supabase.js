/**
 * Supabase client — single access point for Postgres.
 * The backend talks to Supabase with the service-role key only (no RLS),
 * so the database is never exposed to the browser.
 *
 * Boot behavior: the app stays up even when the database is unreachable.
 * A missing variable is reported by envCheck.js and answered over HTTP; a
 * failed connectivity check is logged and surfaced through /api/health.
 * Exiting at import time would turn either problem into Vercel's opaque
 * FUNCTION_INVOCATION_FAILED on every route.
 */

import "./env.js"; // loads the repository-root .env — must come first
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Set when the Supabase variables are missing or unusable. */
export const supabaseConfigError = !SUPABASE_URL
  ? "SUPABASE_URL is not set"
  : !SUPABASE_SERVICE_ROLE_KEY
    ? "SUPABASE_SERVICE_ROLE_KEY is not set"
    : null;

/** Set when the database answered a boot-time query with an error. */
export let supabaseBootError = null;

/** A stand-in that refuses every call with a readable reason. */
function unusableClient(reason) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`Supabase client unavailable: ${reason}`);
      },
    }
  );
}

export const supabase = supabaseConfigError
  ? unusableClient(supabaseConfigError)
  : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

if (supabaseConfigError) {
  console.error("FATAL:", supabaseConfigError, "— set it in the backend environment.");
} else {
  // ── Boot-time connectivity check ─────────────────────────
  // Real GET (not HEAD) — PostgREST returns 200 on HEAD even for missing
  // tables, so only a full read proves the schema exists.
  const { error: bootError } = await supabase
    .from("users")
    .select("id")
    .limit(1);

  if (bootError) {
    supabaseBootError = bootError.message;
    console.error("FATAL: Supabase connection check failed:", bootError.message);
    console.error("Did you run backend/supabase/schema.sql in the Supabase SQL editor?");
  } else {
    console.log("✅ Supabase connected");
  }

  // NOSIH tables are created by migrations/001_nosih.sql (existing
  // installs) or schema.sql (fresh installs) — warn, don't exit, so auth and
  // the health check keep answering while the migration is pending.
  for (const table of ["institutions", "certificates", "issuance_intents"]) {
    const { error: tableError } = await supabase.from(table).select("id").limit(1);
    if (tableError) {
      console.warn(`⚠️  ${table} table not reachable:`, tableError.message);
      console.warn("   Run backend/supabase/migrations/001_nosih.sql in the Supabase SQL editor.");
    }
  }
}

// ── Helpers ──────────────────────────────────────────────

/** True when a Supabase error is a Postgres unique-constraint violation. */
export function isUniqueViolation(error) {
  return error?.code === "23505";
}

/** Maps a users table row to the API shape the frontend expects. */
export function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    // Legacy NOSIH 'admin' rows are platform admins (migration maps them too).
    role: row.role === "admin" ? "platform_admin" : row.role,
    walletAddress: row.wallet_address,
    organizationName: row.organization_name,
    institutionId: row.institution_id ?? null,
    institution: row.institutions ? institutionFromRow(row.institutions) : undefined,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Maps an institutions row. institutionIdHash is public (it is on-chain). */
export function institutionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    institutionId: row.institution_id,
    institutionIdHash: row.institution_id_hash,
    name: row.name,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    website: row.website,
    address: row.address,
    verificationStatus: row.verification_status,
    statusReason: row.status_reason,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Maps an issuer_wallets row. */
export function issuerWalletFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    institutionId: row.institution_id,
    walletAddress: row.wallet_address,
    active: row.active,
    authorizedBy: row.authorized_by,
    authorizationTxHash: row.authorization_tx_hash,
    createdAt: row.created_at,
  };
}

/**
 * Maps a certificates row to the authenticated API shape.
 * Encryption details stay server-side; the public verify payload is built
 * separately by the verification service (P7) from an explicit allow-list.
 */
export function certificateFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    certificateId: row.certificate_id,
    certificateIdHash: row.certificate_id_hash,
    institutionId: row.institution_id,
    institutionIdHash: row.institution_id_hash,
    institution: row.institutions ? institutionFromRow(row.institutions) : undefined,
    issuerUserId: row.issuer_user_id,
    issuerWallet: row.issuer_wallet,
    holderName: row.holder_name,
    holderIdentityHash: row.holder_identity_hash,
    holderIdentifier: row.holder_identifier,
    certificateType: row.certificate_type,
    certificateNumber: row.certificate_number,
    courseName: row.course_name,
    qualification: row.qualification,
    qualificationLevel: row.qualification_level,
    specialization: row.specialization,
    grade: row.grade,
    percentage: row.percentage,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    academicYear: row.academic_year,
    signatoryName: row.signatory_name,
    signatoryDesignation: row.signatory_designation,
    extraData: row.extra_data ?? {},
    documentHash: row.document_hash,
    metadataHash: row.metadata_hash,
    ipfsCid: row.ipfs_cid,
    originalFilename: row.original_filename,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    issuedAt: row.issued_at,
    chainExpiresAt: row.chain_expires_at,
    status: row.status,
    supersedesCertificateId: row.supersedes_certificate_id,
    supersededByCertificateId: row.superseded_by_certificate_id,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    revokedTxHash: row.revoked_tx_hash,
    qrCodeData: row.qr_code_data,
    verifyUrl: row.verify_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Maps an issuance_intents row (issuer-facing recovery/status shape). */
export function intentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    certificateId: row.certificate_id,
    certificateIdHash: row.certificate_id_hash,
    institutionId: row.institution_id,
    institutionIdHash: row.institution_id_hash,
    issuerWallet: row.issuer_wallet,
    certificatePayload: row.certificate_payload,
    documentHash: row.document_hash,
    metadataHash: row.metadata_hash,
    holderIdentityHash: row.holder_identity_hash,
    ipfsCid: row.ipfs_cid,
    supersedesCertificateId: row.supersedes_certificate_id,
    chainExpiresAt: row.chain_expires_at,
    status: row.status,
    txHash: row.tx_hash,
    blockNumber: row.block_number,
    failureReason: row.failure_reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Maps a certificate_events row. */
export function certificateEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    certificateId: row.certificate_id,
    eventType: row.event_type,
    performedBy: row.performed_by,
    institutionId: row.institution_id,
    reason: row.reason,
    transactionHash: row.transaction_hash,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    details: row.details,
    createdAt: row.created_at,
  };
}
