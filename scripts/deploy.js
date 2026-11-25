/**
 * Deploys CertificateRegistry to Polygon Amoy — a LIVE chain write.
 *
 *   npm run deploy:amoy -- --yes
 *
 * Requires: DEPLOYER_PRIVATE_KEY funded with POL, explicit --yes (guards
 * against accidental ledger writes). After the deploy it:
 *   1. grants REVOKER_ROLE to the dedicated REVOKE_PRIVATE_KEY wallet,
 *   2. saves deployments/amoy.json (address, chain, tx, roles),
 *   3. regenerates both ABI modules from the fresh artifact,
 *   4. fills CONTRACT_ADDRESS in .env and REACT_APP_CONTRACT_ADDRESS in
 *      frontend/.env.local (rebuild the frontend afterwards).
 *
 * Issuers are NOT authorized here — that needs an approved institution
 * record: `npm run issuer:add` (scripts/addIssuer.js).
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const root = path.resolve(__dirname, "..");
const normalizePrivateKey = (key) => (key?.startsWith("0x") ? key : `0x${key}`);

function setEnvLine(file, name, value) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return false;
  const text = fs.readFileSync(full, "utf8");
  const re = new RegExp(`^${name}=.*$`, "m");
  const next = re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
  fs.writeFileSync(full, next);
  return true;
}

async function main() {
  // --yes arrives via argv when run directly, or via NOSIH_LIVE_WRITE when
  // launched through scripts/hardhat-live.mjs (hardhat run rejects --yes).
  if (!process.argv.includes("--yes") && process.env.NOSIH_LIVE_WRITE !== "yes") {
    console.error("This deploys to the LIVE Polygon Amoy ledger and spends POL.");
    console.error("Re-run with --yes once the deployer wallet is funded and you approve the write:");
    console.error("  npm run deploy:amoy -- --yes");
    process.exit(1);
  }

  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== 80002) {
    throw new Error(`Expected Polygon Amoy (80002), got ${network.chainId}. Use --network amoy.`);
  }

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address);
  console.log("Balance :", ethers.formatEther(balance), "POL");
  if (balance === 0n) throw new Error("Deployer has no POL — fund it before deploying.");

  const Factory = await ethers.getContractFactory("CertificateRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();
  const address = await registry.getAddress();

  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error("Deploy receipt has no contract code — aborting.");
  const deployTx = registry.deploymentTransaction();
  console.log("\nCertificateRegistry deployed:", address);
  console.log("Deploy tx:", deployTx.hash);

  // ── Grant REVOKER_ROLE to the dedicated revocation wallet ──
  let revokerAddress = null;
  const revokeKey = process.env.REVOKE_PRIVATE_KEY;
  if (revokeKey) {
    revokerAddress = new ethers.Wallet(normalizePrivateKey(revokeKey)).address;
    const REVOKER_ROLE = await registry.REVOKER_ROLE();
    if (await registry.hasRole(REVOKER_ROLE, revokerAddress)) {
      console.log("Revoker already authorized:", revokerAddress);
    } else {
      const tx = await registry.grantRole(REVOKER_ROLE, revokerAddress);
      await tx.wait();
      console.log("REVOKER_ROLE granted:", revokerAddress, "(tx", tx.hash + ")");
      console.log("Fund the revoker with a little POL for revocation gas.");
    }
  } else {
    console.log("REVOKE_PRIVATE_KEY not set — revocation stays unconfigured (503) until you grant REVOKER_ROLE.");
  }

  // ── Deployment record ──
  const record = {
    network: "amoy",
    chainId: 80002,
    contract: "CertificateRegistry",
    address,
    deployer: deployer.address,
    revoker: revokerAddress,
    deployTxHash: deployTx.hash,
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  fs.writeFileSync(path.join(root, "deployments", "amoy.json"), JSON.stringify(record, null, 2) + "\n");
  console.log("Saved deployments/amoy.json");

  // ── ABI modules from the fresh artifact ──
  require("./generateAbi.js");

  // ── Wire the address into both env files ──
  setEnvLine(".env", "CONTRACT_ADDRESS", address);
  setEnvLine(path.join("frontend", ".env.local"), "REACT_APP_CONTRACT_ADDRESS", address);
  console.log("CONTRACT_ADDRESS filled in .env and frontend/.env.local");

  console.log("\nNext steps:");
  console.log("  1. npm run check:env            (read-only sanity + balances)");
  console.log("  2. npm run issuer:add           (authorize an approved institution's wallet)");
  console.log("  3. cd frontend && npm run build (inline the new address)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});