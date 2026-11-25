/**
 * Wallet credit report for NOSIH on Polygon Amoy — READ-ONLY.
 *
 *   node scripts/check-gas.mjs
 *
 * Reports balances, the current gas price, and how many operations each
 * balance covers. Gas figures are conservative estimates from the local
 * Hardhat suite (issueCertificate ~300k, revokeCertificate ~100k,
 * authorizeIssuer ~60k, deploy ~3.5M) — nothing is simulated against live
 * state and NOTHING is broadcast.
 *
 * Roles:
 *   DEPLOYER — pays for deploy + authorizeIssuer/removeIssuer (local hardhat)
 *   REVOKER  — the only server-side chain write (revocations)
 *   ISSUER   — signs issuance in MetaMask; may share the revoker wallet/key
 *              if the operator unified them (see NOTE at the bottom)
 */
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const BACKEND = path.join(ROOT, "backend");
const asUrl = (p) => pathToFileURL(p).href;

const { default: dotenv } = await import(asUrl(path.join(BACKEND, "node_modules", "dotenv/lib/main.js")));
dotenv.config({ path: path.join(ROOT, ".env") });
const ethers = await import(asUrl(path.join(BACKEND, "node_modules", "ethers/lib.esm/index.js")));

const normKey = (k) => (!k ? null : k.startsWith("0x") ? k : `0x${k.trim()}`);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const rpc =
  process.env.ALCHEMY_AMOY_URL ||
  process.env.AMOY_RPC_URL ||
  "https://rpc-amoy.polygon.technology";
const provider = new ethers.JsonRpcProvider(rpc, 80002, { staticNetwork: true });
const network = await provider.getNetwork();

console.log(`Amoy testnet — chain ${network.chainId}  via ${rpc.replace(/\/v2\/.*/, "/v2/…")}`);
if (Number(network.chainId) !== 80002) {
  console.log("FAIL: RPC is not Polygon Amoy (80002).");
  process.exit(1);
}

const feeData = await provider.getFeeData();
const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
console.log(`Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

const GAS = { deploy: 3_500_000n, issue: 300_000n, revoke: 100_000n, authorize: 60_000n };
const cost = (gas) => Number(ethers.formatEther(gas * gasPrice));

const wallets = [];
if (process.env.DEPLOYER_PRIVATE_KEY) {
  wallets.push(["DEPLOYER (owner/admin)", new ethers.Wallet(normKey(process.env.DEPLOYER_PRIVATE_KEY)).address, "deploy"]);
}
if (process.env.REVOKE_PRIVATE_KEY) {
  wallets.push(["REVOKER  (server write)", new ethers.Wallet(normKey(process.env.REVOKE_PRIVATE_KEY)).address, "revoke"]);
}
if (ADDRESS.test(process.env.ISSUER_ADDRESS || "")) {
  wallets.push(["ISSUER   (MetaMask)   ", process.env.ISSUER_ADDRESS, "issue"]);
}

let failures = 0;
for (const [label, address, op] of wallets) {
  const bal = await provider.getBalance(address);
  const pol = Number(ethers.formatEther(bal));
  const perTx = cost(GAS[op]);
  console.log(`${label}  ${address}`);
  console.log(`  balance        ${pol.toFixed(6)} POL`);
  console.log(`  est. cost/op   ${perTx.toFixed(6)} POL  (${GAS[op]} gas)`);
  console.log(`  operations     ~${perTx > 0 ? Math.floor(pol / perTx).toLocaleString() : "n/a"}`);
  if (pol === 0) {
    console.log(`  STATUS         UNFUNDED — fund before live ${op} writes`);
    if (op === "deploy") failures++;
  } else {
    console.log("  STATUS         funded");
  }
  console.log("");
}

if (!wallets.length) {
  console.log("No wallet keys/addresses configured in .env.");
  failures++;
}

console.log("Estimates are conservative; actual gas varies with calldata size.");
console.log("Issuance is signed in MetaMask (prepare→sign→confirm); the server signs revocations only.");
const revokerAddress = process.env.REVOKE_PRIVATE_KEY
  ? new ethers.Wallet(normKey(process.env.REVOKE_PRIVATE_KEY)).address.toLowerCase()
  : null;
if (revokerAddress && (process.env.ISSUER_ADDRESS || "").toLowerCase() === revokerAddress) {
  console.log("NOTE: issuer and revoker are the SAME wallet — the server custodies the shared key.");
}
process.exit(failures ? 1 : 0);