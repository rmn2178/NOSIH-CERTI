/**
 * Authorizes an issuer wallet on-chain AND in the database — a LIVE write.
 *
 *   npm run issuer:add -- --yes [0xWallet] [INST-XXXXXXXX]
 *
 * Defaults: wallet = ISSUER_ADDRESS from .env; institution = the only
 * approved institution (errors with a list when there are several).
 *
 * The institution MUST be approved in Supabase — arbitrary wallets cannot
 * be authorized. The on-chain institutionIdHash is the stored HMAC pseudonym
 * (cross-checked against the backend's own derivation, never recomputed
 * differently). Also upserts the active issuer_wallets row the issuance
 * handshake requires, recording the authorization tx hash.
 *
 * Signed by DEPLOYER_PRIVATE_KEY (DEFAULT_ADMIN_ROLE). Needs POL.
 */
const hre = require("hardhat");
const { ethers } = hre;
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const root = path.resolve(__dirname, "..");
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const INST_ID = /^INST-[0-9A-F]{8}$/i;

async function main() {
  // --yes arrives via argv when run directly, or via NOSIH_LIVE_WRITE when
  // launched through scripts/hardhat-live.mjs (hardhat run rejects --yes).
  if (!process.argv.includes("--yes") && process.env.NOSIH_LIVE_WRITE !== "yes") {
    console.error("This writes to the LIVE Polygon Amoy ledger (authorizeIssuer) and spends POL.");
    console.error("Re-run with --yes:  npm run issuer:add -- --yes [0xWallet] [INST-XXXXXXXX]");
    process.exit(1);
  }

  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!ADDRESS.test(contractAddress || "")) throw new Error("CONTRACT_ADDRESS is missing — run npm run deploy:amoy first.");

  // Positionals arrive via argv when run directly, or via NOSIH_ARG_* when
  // launched through scripts/hardhat-live.mjs (hardhat run rejects extras).
  const args = [
    ...process.argv.slice(2),
    process.env.NOSIH_ARG_WALLET,
    process.env.NOSIH_ARG_INSTITUTION,
  ].filter(Boolean);
  const walletArg = args.find((a) => ADDRESS.test(a)) || process.env.ISSUER_ADDRESS;
  const instArg = args.find((a) => INST_ID.test(a));
  if (!ADDRESS.test(walletArg || "")) throw new Error("Pass an issuer wallet address (0x…) or set ISSUER_ADDRESS in .env.");
  const wallet = walletArg.toLowerCase();

  // ── Approved institution from Supabase (the authorization source of truth) ──
  const { supabase } = await import(require("url").pathToFileURL(path.join(root, "backend", "supabase.js")).href);
  let institution;
  if (instArg) {
    const { data, error } = await supabase.from("institutions").select("*").eq("institution_id", instArg.toUpperCase()).maybeSingle();
    if (error) throw new Error(`Institution lookup failed: ${error.message}`);
    if (!data) throw new Error(`No institution ${instArg} in the database.`);
    institution = data;
  } else {
    const { data, error } = await supabase.from("institutions").select("*").eq("verification_status", "approved");
    if (error) throw new Error(`Institution lookup failed: ${error.message}`);
    if (!data?.length) throw new Error("No approved institutions yet — approve one first (platform admin).");
    if (data.length > 1) {
      throw new Error(`Several approved institutions — pass one explicitly:\n${data.map((i) => `  ${i.institution_id}  ${i.name}`).join("\n")}`);
    }
    institution = data[0];
  }
  if (institution.verification_status !== "approved") {
    throw new Error(`Institution ${institution.institution_id} is '${institution.verification_status}' — issuance requires platform approval.`);
  }

  // Cross-check the stored pseudonym against the backend's own derivation.
  const { computeInstitutionIdentityHash } = await import(require("url").pathToFileURL(path.join(root, "backend", "services", "certificateIdentity.js")).href);
  const derived = computeInstitutionIdentityHash(institution.institution_id);
  if (derived.toLowerCase() !== String(institution.institution_id_hash).toLowerCase()) {
    throw new Error("Stored institution_id_hash does not match HASH_PEPPER derivation — wrong pepper or corrupted row. Refusing to authorize.");
  }
  const institutionIdHash = institution.institution_id_hash;

  // ── On-chain authorization ──
  let txHash = null;
  const registry = await ethers.getContractAt("CertificateRegistry", contractAddress);
  const existing = await registry.getIssuerInstitution(wallet);
  if (existing.toLowerCase() === institutionIdHash.toLowerCase()) {
    console.log(`Wallet already bound to ${institution.institution_id} on-chain: ${wallet}`);
  } else if (existing !== ethers.ZeroHash) {
    throw new Error(`Wallet ${wallet} is bound to a DIFFERENT institution on-chain. Run npm run issuer:remove first.`);
  } else {
    const tx = await registry.authorizeIssuer(wallet, institutionIdHash);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("authorizeIssuer reverted on-chain.");
    console.log(`Authorized ${wallet} for ${institution.institution_id} (${institution.name})`);
    console.log("Tx:", receipt.hash);
    txHash = receipt.hash;
  }

  // ── DB binding the issuance handshake checks (idempotent upsert) ──
  const { error: upsertError } = await supabase.from("issuer_wallets").upsert(
    {
      institution_id: institution.id,
      wallet_address: wallet,
      active: true,
      ...(txHash ? { authorization_tx_hash: txHash } : {}),
    },
    { onConflict: "wallet_address" }
  );
  if (upsertError) throw new Error(`issuer_wallets upsert failed: ${upsertError.message}`);
  console.log("issuer_wallets row active — the issuance handshake will accept this wallet.");
  console.log("\nThe issuer signs with this wallet in MetaMask (import the key, fund it with POL).");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});