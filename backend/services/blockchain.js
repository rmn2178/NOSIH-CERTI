/**
 * NOSIH blockchain service — Polygon Amoy (chain 80002).
 *
 * Responsibilities:
 *  - READ the CertificateRegistry (verification is chain-authoritative).
 *  - INDEPENDENTLY verify issuance receipts for the confirm stage: status,
 *    target contract, chain id, and every CertificateIssued event field
 *    against the issuance intent. The client's word is never trusted.
 *  - Sign REVOCATIONS with the dedicated REVOKE_PRIVATE_KEY (REVOKER_ROLE).
 *
 * There is NO issuance signing here, by design: issueCertificate is signed
 * only by the issuer's own MetaMask wallet. A server key can never issue.
 *
 * Every function accepts provider/address overrides so the local Hardhat
 * integration tests exercise the exact same code paths as production.
 */

import "../env.js"; // loads the repository-root .env — must come first
import { ethers } from "ethers";
import { CERTIFICATE_REGISTRY_ABI } from "./certificateRegistryABI.js";

const DEFAULT_AMOY_RPC = "https://rpc-amoy.polygon.technology";

/** The chain the platform verifies against (80002 = Polygon Amoy). */
export const CHAIN_ID = Number(process.env.CHAIN_ID || 80002);

/** Configuration is missing — a clear 503, never a simulated success. */
export class ChainConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChainConfigError";
    this.status = 503;
  }
}

/** The chain could not be reached — verification must stay INDETERMINATE. */
export class ChainUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChainUnavailableError";
    this.status = 503;
  }
}

function getRpcUrl() {
  return process.env.ALCHEMY_AMOY_URL || process.env.AMOY_RPC_URL || DEFAULT_AMOY_RPC;
}

let readProvider = null;
export function getReadProvider() {
  if (!readProvider) readProvider = new ethers.JsonRpcProvider(getRpcUrl());
  return readProvider;
}

export function getContractAddress() {
  const address = process.env.CONTRACT_ADDRESS;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new ChainConfigError("CONTRACT_ADDRESS is not set — the CertificateRegistry deployment address is required");
  }
  return address;
}

export function getRegistry(runner, addressOverride) {
  return new ethers.Contract(addressOverride || getContractAddress(), CERTIFICATE_REGISTRY_ABI, runner);
}

const normalizePrivateKey = (key) => (key?.startsWith("0x") ? key : `0x${key}`);
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

// ── Issuance receipt verification (confirm stage) ─────────

/**
 * Independently verifies a claimed issuance transaction.
 *
 * @param {object} args
 * @param {string} args.txHash the transaction the client claims issued the certificate
 * @param {object} args.expected the intent's pinned values:
 *   { certificateIdHash, documentHash, metadataHash, institutionIdHash,
 *     issuerWallet, ipfsCID, chainExpiresAt, supersedesCertificateIdHash }
 * @returns {Promise<{ok: boolean, state: "confirmed"|"pending"|"rejected", reason?: string, blockNumber?: number, issuedAt?: number}>}
 */
export async function verifyIssuanceReceipt({ txHash, expected, provider, contractAddress, chainId }) {
  if (!TX_HASH_RE.test(String(txHash ?? ""))) {
    return { ok: false, state: "rejected", reason: "Malformed transaction hash" };
  }
  const runProvider = provider || getReadProvider();
  const address = (contractAddress || getContractAddress()).toLowerCase();
  const expectedChain = Number(chainId ?? CHAIN_ID);

  let receipt;
  try {
    receipt = await runProvider.getTransactionReceipt(txHash);
  } catch (err) {
    throw new ChainUnavailableError(`Could not reach the chain to verify the transaction: ${err.shortMessage || err.message}`);
  }

  if (!receipt) {
    return { ok: false, state: "pending", reason: "Transaction not found on-chain yet — it may still be propagating" };
  }

  let network;
  try {
    network = await runProvider.getNetwork();
  } catch (err) {
    throw new ChainUnavailableError(`Could not read the chain id: ${err.shortMessage || err.message}`);
  }
  if (Number(network.chainId) !== expectedChain) {
    return { ok: false, state: "rejected", reason: `Transaction is on chain ${network.chainId}, expected ${expectedChain}` };
  }
  if (receipt.status !== 1) {
    return { ok: false, state: "rejected", reason: "Transaction reverted on-chain" };
  }
  if ((receipt.to || "").toLowerCase() !== address) {
    return { ok: false, state: "rejected", reason: "Transaction was not sent to the CertificateRegistry contract" };
  }

  // Find the CertificateIssued event for THIS certificate in THIS contract's logs.
  const iface = new ethers.Interface(CERTIFICATE_REGISTRY_ABI);
  let event = null;
  for (const log of receipt.logs) {
    if ((log.address || "").toLowerCase() !== address) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "CertificateIssued" && parsed.args.certificateIdHash === expected.certificateIdHash) {
        event = parsed;
        break;
      }
    } catch {
      /* a log from another contract/event — not ours */
    }
  }
  if (!event) {
    return { ok: false, state: "rejected", reason: "No CertificateIssued event for this certificate in the transaction" };
  }

  const a = event.args;
  const comparisons = [
    ["documentHash", a.documentHash, expected.documentHash],
    ["metadataHash", a.metadataHash, expected.metadataHash],
    ["institutionIdHash", a.institutionIdHash, expected.institutionIdHash],
    ["issuer", a.issuer.toLowerCase(), String(expected.issuerWallet).toLowerCase()],
    ["ipfsCID", a.ipfsCID, expected.ipfsCID],
    ["expiresAt", Number(a.expiresAt), Number(expected.chainExpiresAt ?? 0)],
    ["supersedesCertificateIdHash", a.supersedesCertificateIdHash, expected.supersedesCertificateIdHash || ethers.ZeroHash],
  ];
  for (const [field, onChain, expectedValue] of comparisons) {
    if (onChain !== expectedValue) {
      return { ok: false, state: "rejected", reason: `On-chain ${field} does not match the approved issuance intent` };
    }
  }

  return {
    ok: true,
    state: "confirmed",
    blockNumber: receipt.blockNumber,
    issuedAt: Number(a.issuedAt),
    txHash,
  };
}

// ── Reads (free — no gas) ─────────────────────────────────

function mapCertificate(c) {
  return {
    certificateIdHash: c.certificateIdHash,
    institutionIdHash: c.institutionIdHash,
    holderIdentityHash: c.holderIdentityHash,
    documentHash: c.documentHash,
    metadataHash: c.metadataHash,
    ipfsCID: c.ipfsCID,
    issuer: c.issuer,
    issuedAt: Number(c.issuedAt),
    expiresAt: Number(c.expiresAt),
    revoked: c.revoked,
    exists: c.exists,
    supersedesCertificateIdHash: c.supersedesCertificateIdHash,
  };
}

/**
 * Reads a certificate from the chain. Returns null when it does not exist.
 * Throws ChainUnavailableError when the chain cannot be reached — callers
 * must answer INDETERMINATE, never "valid from the database alone".
 */
export async function readCertificate(certificateIdHash, { provider, contractAddress } = {}) {
  if (!BYTES32_RE.test(String(certificateIdHash ?? ""))) {
    throw Object.assign(new Error("Invalid certificate id hash"), { status: 400 });
  }
  try {
    const c = getRegistry(provider || getReadProvider(), contractAddress);
    if (!(await c.certificateExists(certificateIdHash))) return null;
    return mapCertificate(await c.getCertificate(certificateIdHash));
  } catch (err) {
    if (err instanceof ChainConfigError || err.status === 400) throw err;
    throw new ChainUnavailableError(`Chain read failed: ${err.shortMessage || err.message}`);
  }
}

/** The institution pseudonym an issuer wallet is bound to on-chain. */
export async function getIssuerInstitutionFromChain(walletAddress, { provider, contractAddress } = {}) {
  try {
    const c = getRegistry(provider || getReadProvider(), contractAddress);
    return await c.getIssuerInstitution(walletAddress);
  } catch (err) {
    if (err instanceof ChainConfigError) throw err;
    throw new ChainUnavailableError(`Chain read failed: ${err.shortMessage || err.message}`);
  }
}

// ── Revocation (the ONLY server-side signing) ─────────────

export function getRevocationSigner() {
  const key = process.env.REVOKE_PRIVATE_KEY;
  if (!key) {
    throw new ChainConfigError("REVOKE_PRIVATE_KEY is not set — revocation is not configured");
  }
  return new ethers.Wallet(normalizePrivateKey(key), getReadProvider());
}

/**
 * Revokes on-chain with the dedicated REVOKER_ROLE key. Only the reason
 * HASH goes on-chain; the reason text stays private in Supabase.
 */
export async function revokeCertificateOnChain(certificateIdHash, reasonHash, { signer, contractAddress } = {}) {
  const runner = signer || getRevocationSigner();
  const c = getRegistry(runner, contractAddress);
  const tx = await c.revokeCertificate(certificateIdHash, reasonHash);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("Revocation transaction reverted on-chain");
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}