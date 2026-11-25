/**
 * Dual storage for ENCRYPTED certificate documents.
 *
 * Primary cache: Supabase private storage bucket ('certificates') for
 * instant retrieval. Permanent layer: IPFS (Pinata), referenced by the
 * on-chain ipfsCID. Only ciphertext is ever stored in either place —
 * AES-256-GCM encryption happens in certificateIdentity.js before upload,
 * and the key never leaves the backend environment.
 *
 * Retrieval: storage serves in milliseconds; on a miss it falls back to the
 * IPFS gateway race and backfills the cache in the background.
 */

import "../env.js"; // loads the repository-root .env — must come first
import { supabase } from "../supabase.js";
import { fetchIPFSFile } from "./ipfs.js";

const BUCKET = "certificates";

/** Ensures the private storage bucket exists (non-fatal on failure). */
export async function ensureCertificatesBucket() {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some((b) => b.name === BUCKET)) {
      await supabase.storage.createBucket(BUCKET, { public: false });
    }
  } catch (err) {
    console.warn("[certStorage] Bucket ensure check:", err.message);
  }
}

/**
 * Mirrors ciphertext into the private bucket. A failure here is a warning,
 * not an error: IPFS remains the authoritative document layer.
 */
export async function storeEncryptedCertificate(certificateId, ciphertext) {
  try {
    const { error } = await supabase.storage.from(BUCKET).upload(`${certificateId}.enc`, ciphertext, {
      contentType: "application/octet-stream",
      upsert: true,
    });
    if (error) console.warn(`[certStorage] Storage upload warning for ${certificateId}:`, error.message);
  } catch (err) {
    console.warn(`[certStorage] Storage upload exception for ${certificateId}:`, err.message);
  }
}

/**
 * Retrieves the encrypted certificate buffer: storage first, IPFS fallback
 * with background backfill.
 * @param {{ certificate_id: string, ipfs_cid: string }} row
 * @returns {Promise<{ buffer: Buffer, sourceUrl: string }>}
 */
export async function getEncryptedCertificate(row) {
  // 1. Instant private storage (no rate limits, no propagation delay)
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(`${row.certificate_id}.enc`);
    if (data && !error) {
      const arrayBuffer = await data.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        sourceUrl: `supabase://storage/${BUCKET}/${row.certificate_id}.enc`,
      };
    }
  } catch (err) {
    console.warn(`[certStorage] Storage cache miss for ${row.certificate_id}:`, err.message);
  }

  // 2. Decentralized IPFS gateways (the on-chain referenced layer)
  const file = await fetchIPFSFile(row.ipfs_cid);

  // Backfill so subsequent requests are instant.
  storeEncryptedCertificate(row.certificate_id, file.buffer).catch(() => {});

  return { buffer: file.buffer, sourceUrl: file.sourceUrl };
}

export { BUCKET as CERTIFICATES_BUCKET };