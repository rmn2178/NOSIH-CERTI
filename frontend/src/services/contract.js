/**
 * CertificateRegistry contract bindings for the browser.
 *
 * WRITE: only issueCertificate, signed by the issuer's MetaMask wallet.
 * READ:  free chain reads (verification is chain-authoritative).
 *
 * Revocation is NOT here — it is a server-side operation with the dedicated
 * REVOKER_ROLE key, never a browser transaction.
 */

import { Contract, JsonRpcProvider } from "ethers";
import { CERTIFICATE_REGISTRY_ABI } from "../utils/contractABI.js";
import { AMOY_CHAIN_ID, WalletError } from "./wallet.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function getContractAddress() {
  const address = process.env.REACT_APP_CONTRACT_ADDRESS;
  if (!address || !ADDRESS_RE.test(address)) {
    throw new WalletError(
      "CONTRACT_MISSING",
      "REACT_APP_CONTRACT_ADDRESS is not configured — the CertificateRegistry deployment address is required."
    );
  }
  return address;
}

let readProvider = null;
export function getReadProvider() {
  if (!readProvider) {
    readProvider = new JsonRpcProvider(
      process.env.REACT_APP_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      AMOY_CHAIN_ID,
      { staticNetwork: true }
    );
  }
  return readProvider;
}

export function getRegistry(runner, addressOverride) {
  return new Contract(addressOverride || getContractAddress(), CERTIFICATE_REGISTRY_ABI, runner);
}

/**
 * Sends issueCertificate with the EXACT arguments the backend prepared.
 * Returns as soon as the transaction is broadcast — the backend's confirm
 * endpoint independently verifies the receipt (pending → 202, retry-safe).
 *
 * @param {import("ethers").Signer} signer the connected issuer wallet
 * @param {object} issueArgs the prepare response's issueArgs (12-field struct)
 * @returns {Promise<{ txHash: string }>}
 */
export async function issueCertificate(signer, issueArgs) {
  const contract = getRegistry(signer);
  const tx = await contract.issueCertificate(issueArgs);
  return { txHash: tx.hash };
}

/** Free read: the on-chain certificate, or null when it does not exist. */
export async function readCertificate(certificateIdHash) {
  const contract = getRegistry(getReadProvider());
  if (!(await contract.certificateExists(certificateIdHash))) return null;
  const c = await contract.getCertificate(certificateIdHash);
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

/** Block explorer link for a transaction (Amoy). */
export function explorerTxUrl(txHash) {
  return `https://amoy.polygonscan.com/tx/${txHash}`;
}