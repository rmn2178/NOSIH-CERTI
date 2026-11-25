#!/usr/bin/env node
/**
 * NOSIH read-only chain probe.
 *
 * Verifies the deployed CertificateRegistry on Polygon Amoy WITHOUT any
 * write: contract code exists, chain id, role holders (admin/revoker), and
 * that the issuer wallet is NOT yet authorized (issuer:add is a separate,
 * explicitly approved live write). Also cross-checks deployments/amoy.json
 * against both env files. Safe to run at any time; never sends a transaction.
 *
 *   npm run check:chain
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "backend", "package.json"));
require("dotenv").config({ path: path.join(root, ".env") });
const { ethers } = require("ethers");

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const record = JSON.parse(fs.readFileSync(path.join(root, "deployments", "amoy.json"), "utf8"));
const envAddress = process.env.CONTRACT_ADDRESS;
const feEnv = fs.readFileSync(path.join(root, "frontend", ".env.local"), "utf8");
const feAddress = (feEnv.match(/^REACT_APP_CONTRACT_ADDRESS=(.*)$/m) || [])[1];

console.log(`\nRead-only probe of CertificateRegistry @ ${record.address}\n`);
check(envAddress === record.address, "root .env CONTRACT_ADDRESS matches deployments/amoy.json");
check(feAddress === record.address, "frontend/.env.local REACT_APP_CONTRACT_ADDRESS matches");
check(Number(record.chainId) === 80002, "deployment record chainId is 80002");

const url = process.env.AMOY_RPC_URL || process.env.ALCHEMY_AMOY_URL;
const provider = new ethers.JsonRpcProvider(url);
const network = await provider.getNetwork();
check(Number(network.chainId) === 80002, "RPC reports Polygon Amoy (80002)", `chainId ${network.chainId}`);

const code = await provider.getCode(record.address);
check(code !== "0x", "contract code exists at the deployed address", `${(code.length - 2) / 2} bytes`);

const { CERTIFICATE_REGISTRY_ABI } = await import(
  pathToFileURL(path.join(root, "backend", "services", "certificateRegistryABI.js")).href
);
const registry = new ethers.Contract(record.address, CERTIFICATE_REGISTRY_ABI, provider);

const [adminRole, issuerRole, revokerRole] = await Promise.all([
  registry.DEFAULT_ADMIN_ROLE(),
  registry.ISSUER_ROLE(),
  registry.REVOKER_ROLE(),
]);
check(adminRole === ethers.ZeroHash, "DEFAULT_ADMIN_ROLE is the zero hash (OZ convention)");

const [isAdmin, isRevoker, isIssuer] = await Promise.all([
  registry.hasRole(adminRole, record.deployer),
  registry.hasRole(revokerRole, record.revoker),
  registry.hasRole(issuerRole, process.env.ISSUER_ADDRESS),
]);
check(isAdmin, "deployer holds DEFAULT_ADMIN_ROLE", record.deployer);
check(isRevoker, "revoker holds REVOKER_ROLE", record.revoker);
check(!isIssuer, "issuer wallet NOT yet authorized (issuer:add pending)", process.env.ISSUER_ADDRESS);

const deployTx = await provider.getTransactionReceipt(record.deployTxHash);
check(deployTx && deployTx.status === 1, "deploy transaction receipt status 1", record.deployTxHash.slice(0, 18) + "…");

console.log(failures === 0 ? "\n✅ CHAIN PROBE: ALL PASS (read-only)\n" : `\n❌ CHAIN PROBE: ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);