/**
 * Removes an issuer wallet's on-chain authorization — a LIVE chain write.
 *
 *   npm run issuer:remove -- --yes [0xWallet]
 *
 * Defaults to ISSUER_ADDRESS from .env. Revokes ISSUER_ROLE on the
 * CertificateRegistry and deactivates the matching issuer_wallets row so
 * the issuance handshake stops accepting the wallet immediately.
 * Existing certificates stay verifiable — removal only blocks NEW issuance.
 *
 * Signed by DEPLOYER_PRIVATE_KEY (DEFAULT_ADMIN_ROLE). Needs POL.
 */
const hre = require("hardhat");
const { ethers } = hre;
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const root = path.resolve(__dirname, "..");
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

async function main() {
  // --yes arrives via argv when run directly, or via NOSIH_LIVE_WRITE when
  // launched through scripts/hardhat-live.mjs (hardhat run rejects --yes).
  if (!process.argv.includes("--yes") && process.env.NOSIH_LIVE_WRITE !== "yes") {
    console.error("This writes to the LIVE Polygon Amoy ledger (removeIssuer) and spends POL.");
    console.error("Re-run with --yes:  npm run issuer:remove -- --yes [0xWallet]");
    process.exit(1);
  }

  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!ADDRESS.test(contractAddress || "")) throw new Error("CONTRACT_ADDRESS is missing — nothing to remove from.");

  const walletArg =
    [...process.argv.slice(2), process.env.NOSIH_ARG_WALLET].filter(Boolean).find((a) => ADDRESS.test(a)) ||
    process.env.ISSUER_ADDRESS;
  if (!ADDRESS.test(walletArg || "")) throw new Error("Pass an issuer wallet address (0x…) or set ISSUER_ADDRESS in .env.");
  const wallet = walletArg.toLowerCase();

  const registry = await ethers.getContractAt("CertificateRegistry", contractAddress);
  const ISSUER_ROLE = await registry.ISSUER_ROLE();
  if (!(await registry.hasRole(ISSUER_ROLE, wallet))) {
    console.log(`Wallet has no ISSUER_ROLE on-chain: ${wallet}`);
  } else {
    const tx = await registry.removeIssuer(wallet);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("removeIssuer reverted on-chain.");
    console.log(`Removed on-chain issuer: ${wallet}`);
    console.log("Tx:", receipt.hash);
  }

  const { supabase } = await import(require("url").pathToFileURL(path.join(root, "backend", "supabase.js")).href);
  const { error } = await supabase.from("issuer_wallets").update({ active: false }).eq("wallet_address", wallet);
  if (error) throw new Error(`issuer_wallets deactivation failed: ${error.message}`);
  console.log("issuer_wallets row deactivated — prepare/confirm now refuse this wallet.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});