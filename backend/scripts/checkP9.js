/**
 * P9 PREP offline gate — deployment wiring, env surface, land retirement.
 * No network, no chain writes, no credentials needed.
 *
 *   node backend/scripts/checkP9.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

// ── [1] Env template + Vercel push list ───────────────────
console.log("[1] Environment surface");
{
  const example = read(".env.example");
  const activeKeys = [...example.matchAll(/^\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const { REQUIRED_ENV } = await import(pathToFileURL(path.join(ROOT, "backend", "envCheck.js")).href);
  for (const spec of REQUIRED_ENV) {
    check(`.env.example defines ${spec.name}`, activeKeys.includes(spec.name));
  }
  for (const name of ["CONTRACT_ADDRESS", "REVOKE_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "CHAIN_ID", "GEMINI_API_KEY", "PINATA_JWT", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) {
    check(`.env.example defines ${name}`, activeKeys.includes(name));
  }
  check(".env.example has no ISSUER_PRIVATE_KEY (MetaMask-only issuance)", !activeKeys.includes("ISSUER_PRIVATE_KEY"));
  check(".env.example has no VIEW_DOCUMENT_POLICY (land leftover)", !activeKeys.includes("VIEW_DOCUMENT_POLICY"));
  check(".env.example documents the frontend REACT_APP_* set", ["REACT_APP_API_URL", "REACT_APP_CONTRACT_ADDRESS", "REACT_APP_CHAIN_ID", "REACT_APP_AMOY_RPC_URL"].every((k) => example.includes(k)));
  check(".env.example warns the publishable key is wrong", /publishable/i.test(example));

  const ve = read("scripts/vercel-env.mjs");
  const requiredBlock = ve.match(/const REQUIRED = \[([\s\S]*?)\];/)?.[1] || "";
  const requiredNames = [...requiredBlock.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  check("vercel-env pushes REVOKE_PRIVATE_KEY", requiredNames.includes("REVOKE_PRIVATE_KEY"));
  check("vercel-env never pushes ISSUER_PRIVATE_KEY", !requiredNames.includes("ISSUER_PRIVATE_KEY") && !ve.includes('"ISSUER_PRIVATE_KEY"'));
  check("vercel-env never pushes DEPLOYER_PRIVATE_KEY", !ve.includes('"DEPLOYER_PRIVATE_KEY"'));
  check("vercel-env drops VIEW_DOCUMENT_POLICY", !requiredNames.includes("VIEW_DOCUMENT_POLICY"));
  check("vercel-env keeps ADMIN_* local (bootstrap only)", !requiredNames.includes("ADMIN_EMAIL") && !requiredNames.includes("ADMIN_PASSWORD"));
  const feBlock = ve.match(/const FRONTEND_REQUIRED = \[([\s\S]*?)\];/)?.[1] || "";
  for (const k of ["REACT_APP_API_URL", "REACT_APP_CONTRACT_ADDRESS", "REACT_APP_CHAIN_ID", "REACT_APP_AMOY_RPC_URL"]) {
    check(`vercel-env pushes build-time ${k}`, feBlock.includes(`"${k}"`));
  }

  const fe = read("frontend/.env.local");
  for (const k of ["REACT_APP_API_URL", "REACT_APP_CONTRACT_ADDRESS", "REACT_APP_CHAIN_ID", "REACT_APP_AMOY_RPC_URL"]) {
    check(`frontend/.env.local defines ${k}`, new RegExp(`^${k}=`, "m").test(fe));
  }
  const feValues = [...fe.matchAll(/^\s*[A-Z][A-Z0-9_]*=(.*)$/gm)].map((m) => m[1]).join("\n");
  check("frontend env has no Alchemy key / secret material", !/alchemy|sb_secret|PRIVATE|eyJ/i.test(feValues));
}

// ── [2] Deploy / issuer tooling ───────────────────────────
console.log("\n[2] Deployment tooling");
{
  const deploy = read("scripts/deploy.js");
  check("deploy.js deploys CertificateRegistry", deploy.includes('getContractFactory("CertificateRegistry")'));
  check("deploy.js requires explicit --yes (live-write guard)", deploy.includes('process.argv.includes("--yes")'));
  check("deploy.js grants REVOKER_ROLE", deploy.includes("grantRole(REVOKER_ROLE"));
  check("deploy.js verifies contract code after deploy", deploy.includes("getCode"));
  check("deploy.js records deployments/amoy.json", deploy.includes('"deployments", "amoy.json"'));
  check("deploy.js regenerates both ABI modules", deploy.includes('require("./generateAbi.js")'));
  check("deploy.js wires CONTRACT_ADDRESS into both env files", deploy.includes('setEnvLine(".env", "CONTRACT_ADDRESS"') && deploy.includes('REACT_APP_CONTRACT_ADDRESS'));

  const add = read("scripts/addIssuer.js");
  check("addIssuer requires an APPROVED institution", add.includes('verification_status !== "approved"') && add.includes('eq("verification_status", "approved")'));
  check("addIssuer cross-checks the stored hash against the backend derivation", add.includes("computeInstitutionIdentityHash") && add.includes("institution_id_hash"));
  check("addIssuer calls authorizeIssuer with the institution pseudonym", add.includes("registry.authorizeIssuer(wallet, institutionIdHash)"));
  check("addIssuer activates the issuer_wallets binding", add.includes('from("issuer_wallets").upsert') && add.includes("active: true"));
  check("addIssuer refuses wallets bound to another institution", add.includes("issuer:remove"));
  check("addIssuer has the --yes live-write guard", add.includes('process.argv.includes("--yes")'));

  const rm = read("scripts/removeIssuer.js");
  check("removeIssuer revokes on-chain and deactivates the DB row", rm.includes("registry.removeIssuer(wallet)") && rm.includes("active: false"));
  check("removeIssuer has the --yes live-write guard", rm.includes('process.argv.includes("--yes")'));

  const abi = read("scripts/generateAbi.js");
  check("generateAbi reads the CertificateRegistry artifact", abi.includes("CertificateRegistry.sol"));
  check("generateAbi writes backend + frontend ABI modules", abi.includes("certificateRegistryABI.js") && abi.includes("contractABI.js"));

  const gas = read("scripts/check-gas.mjs");
  check("check-gas is read-only (no estimateGas/broadcast against live state)", !/estimateGas|sendTransaction|\.deploy\(/.test(gas));
  check("check-gas reports deployer/revoker/issuer", gas.includes("DEPLOYER") && gas.includes("REVOKER") && gas.includes("ISSUER"));

  const env = read("scripts/check-env.js");
  check("check-env reuses the backend boot audit", env.includes("auditEnv"));
  check("check-env rejects a publishable Supabase key", env.includes("sb_publishable_"));
  check("check-env flags any server-side ISSUER_PRIVATE_KEY", env.includes("ISSUER_PRIVATE_KEY present"));
}

// ── [3] Land retirement ───────────────────────────────────
console.log("\n[3] Land retirement");
{
  check("LandRegistry.sol is gone", !exists("contracts/LandRegistry.sol"));
  check("LandRegistry.test.js is gone", !exists("test/LandRegistry.test.js"));
  const retired = [
    "scripts/check-extraction-resilience.mjs", "scripts/lib/deed-fixtures.mjs",
    "scripts/check-runtime.js", "scripts/check-vercel-env.js", "scripts/simulate-deploy.mjs",
    "scripts/check-readme.mjs", "scripts/format-readme-diagrams.mjs", "scripts/generate-badges.mjs",
    "scripts/smoke-api.js", "scripts/reset-supabase.js", "backend/scripts/makeScannedDeed.js",
    "docs/guided-tour-plan.md", "docs/tour-implementation-plan.md", "docs/vercel-deployment.md",
  ];
  check("every land-era script/doc is retired", retired.every((p) => !exists(p)), retired.filter(exists).join(", "));

  // No LandRegistry reference survives in live code.
  const scan = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...scan(full));
      else if (/\.(js|mjs|json|md)$/.test(entry.name) && !full.endsWith("checkP9.js") && /LandRegistry/.test(read(full))) out.push(full);
    }
    return out;
  };
  const refs = [...scan("scripts"), ...scan("backend"), ...scan("contracts"), ...scan("test")];
  check("no LandRegistry references in scripts/backend/contracts/test", refs.length === 0, refs.join(", "));

  const pkg = JSON.parse(read("package.json"));
  check("root package renamed to nosih-contracts", pkg.name === "nosih-contracts");
  check("no check:tour / db:reset / land smoke scripts", !pkg.scripts["check:tour"] && !pkg.scripts["db:reset"] && !/smoke-api/.test(JSON.stringify(pkg.scripts)));
  const missingTargets = [];
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    const m = cmd.match(/((?:scripts|backend\/scripts)\/[A-Za-z0-9._-]+\.(?:js|mjs))/);
    if (m && !exists(m[1])) missingTargets.push(`${name} → ${m[1]}`);
  }
  check("every package.json script target exists", missingTargets.length === 0, missingTargets.join(", "));
  check("issuer:remove script is wired", Boolean(pkg.scripts["issuer:remove"]));

  const bpkg = JSON.parse(read("backend/package.json"));
  check("backend package renamed to nosih-backend", bpkg.name === "nosih-backend");

  const readme = read("README.md");
  check("README is NOSIH (no land deed content)", /NOSIH/.test(readme) && !/LandRegistry|land deed|Land ID/.test(readme));
  check("README documents the live-write guard", readme.includes("deploy:amoy -- --yes"));
}

// ── [4] Backend security invariants (unchanged by P9) ─────
console.log("\n[4] Backend invariants");
{
  const bc = read("backend/services/blockchain.js");
  check("revocation is the only server signing key", bc.includes("REVOKE_PRIVATE_KEY") && !bc.includes("ISSUER_PRIVATE_KEY"));
  const routes = ["backend/routes/auth.js", "backend/routes/institutions.js", "backend/routes/certificates.js", "backend/routes/verify.js"];
  check("no route reads ISSUER_PRIVATE_KEY", routes.every((p) => !read(p).includes("ISSUER_PRIVATE_KEY")));
  const server = read("backend/server.js");
  for (const mount of ["/api/auth", "/api/institutions", "/api/certificates", "/api/verify"]) {
    check(`server mounts ${mount}`, server.includes(`"${mount}"`));
  }
  const sql = read("backend/supabase/migrations/001_nosih.sql");
  for (const table of ["institutions", "issuer_wallets", "certificates", "issuance_intents", "certificate_events"]) {
    check(`migration creates ${table}`, new RegExp(`create table if not exists ${table}`).test(sql));
  }
  check("migration is additive (no drop table)", !/drop table/i.test(sql));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed) {
  console.log("P9 prep gate: FAIL");
  process.exit(1);
}
console.log("P9 prep gate: PASS");