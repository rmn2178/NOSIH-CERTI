/**
 * P8 offline gate — frontend rebuild proof, NO live services.
 *
 * Proves:
 *  - EVERY endpoint the frontend calls exists in the backend route table
 *    (method + path, parsed from both sides — not a hand-written list)
 *  - field/type/status/verdict contracts match the backend exactly
 *  - tour + land code is fully gone; no private keys, no window.prompt
 *  - public verify/tamper routes need no auth; issuance is role-gated
 *  - the production build exists and survives a platform-level API failure
 *    (served with a deliberately broken API — HTTP level; the rendered
 *    error path is exercised in the browser smoke)
 *
 * Run AFTER: npm run build --prefix frontend
 * Run: node backend/scripts/checkP8.js
 */

import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(rootDir, rel));

// ── 1. API contract cross-check (parsed from both sides) ──
console.log("\n[1] Frontend ↔ backend API contract");

const serverSrc = read("backend/server.js");
const MOUNTS = {
  "/api/auth": "backend/routes/auth.js",
  "/api/institutions": "backend/routes/institutions.js",
  "/api/certificates": "backend/routes/certificates.js",
  "/api/verify": "backend/routes/verify.js",
};

const backendRoutes = [];
for (const [prefix, file] of Object.entries(MOUNTS)) {
  assert(serverSrc.includes(`app.use("${prefix}"`), `${prefix} not mounted in server.js`);
  const src = read(file);
  const re = /router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    const full = (prefix + (m[2] === "/" ? "" : m[2])).replace(/\/$/, "") || prefix;
    backendRoutes.push({ method: m[1].toUpperCase(), path: full });
  }
}
assert(backendRoutes.length >= 25, `route table suspiciously small (${backendRoutes.length})`);

const apiSrc = read("frontend/src/utils/api.js");
const callRe = /api\.(get|post|patch|put|delete)\(\s*[`"]([^`"]+)[`"]/g;
const frontendCalls = [];
let m;
while ((m = callRe.exec(apiSrc))) {
  const p = m[2].replace(/\$\{[^}]+\}/g, ":p");
  frontendCalls.push({ method: m[1].toUpperCase(), path: "/api" + (p === "/" ? "" : p) });
}
assert(frontendCalls.length >= 20, `frontend call table suspiciously small (${frontendCalls.length})`);

function routeMatches(call, route) {
  if (call.method !== route.method) return false;
  const a = call.path.split("/").filter(Boolean);
  const b = route.path.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || b[i].startsWith(":") || seg === ":p");
}

await check(`every frontend API call (${frontendCalls.length}) resolves to a backend route`, () => {
  const missing = frontendCalls.filter((c) => !backendRoutes.some((r) => routeMatches(c, r)));
  assert(missing.length === 0, `no backend route for: ${missing.map((c) => `${c.method} ${c.path}`).join(", ")}`);
});

await check("public QR URL builder targets the public verify QR route", () => {
  assert(/\/verify\/\$\{certificateId\}\/qr/.test(apiSrc), "QR URL builder changed");
  assert(backendRoutes.some((r) => r.method === "GET" && r.path === "/api/verify/:certificateId/qr"), "backend QR route missing");
});

// ── 2. Field / type / status / verdict contracts ─────────
console.log("\n[2] Shared contracts match the backend");

const templatesSrc = read("backend/services/certificateTemplates.js");
const backendFields = [...templatesSrc.matchAll(/^\s*"([a-zA-Z]+)",?$/gm)]
  .map((x) => x[1])
  .filter((k) => /^[a-z]/.test(k));
const certFieldsBlock = templatesSrc.slice(
  templatesSrc.indexOf("CERTIFICATE_FIELDS = ["),
  templatesSrc.indexOf("FIELD_DESCRIPTIONS")
);
const CERT_FIELDS = [...certFieldsBlock.matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1]);
assert(CERT_FIELDS.length === 17, `expected 17 backend fields, got ${CERT_FIELDS.length}`);

const issueSrc = read("frontend/src/pages/IssuePage.js");
const emptyBlock = issueSrc.slice(issueSrc.indexOf("EMPTY_FIELDS = {"), issueSrc.indexOf("const DATE_FIELDS"));
const FRONT_FIELDS = [...emptyBlock.matchAll(/([a-zA-Z]+):/g)].map((x) => x[1]);

await check("IssuePage EMPTY_FIELDS == backend CERTIFICATE_FIELDS (17)", () => {
  assert(FRONT_FIELDS.length === 17, `frontend has ${FRONT_FIELDS.length} fields`);
  const missing = CERT_FIELDS.filter((f) => !FRONT_FIELDS.includes(f));
  const extra = FRONT_FIELDS.filter((f) => !CERT_FIELDS.includes(f));
  assert(missing.length === 0 && extra.length === 0, `missing: ${missing}; extra: ${extra}`);
});

const helpersSrc = read("frontend/src/utils/certificateHelpers.js");
const typesBlock = templatesSrc.slice(templatesSrc.indexOf("CERTIFICATE_TYPES = ["), templatesSrc.indexOf("CERTIFICATE_TEMPLATES"));
const CERT_TYPES = [...typesBlock.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
const frontTypesBlock = helpersSrc.slice(helpersSrc.indexOf("TYPE_LABELS = {"), helpersSrc.indexOf("STATUS_LABELS"));
const FRONT_TYPES = [...frontTypesBlock.matchAll(/^\s*([a-z_]+):/gm)].map((x) => x[1]);

await check("TYPE_LABELS == backend CERTIFICATE_TYPES (10)", () => {
  assert(CERT_TYPES.length === 10 && FRONT_TYPES.length === 10, `backend ${CERT_TYPES.length}, frontend ${FRONT_TYPES.length}`);
  assert(CERT_TYPES.every((t) => FRONT_TYPES.includes(t)), "type sets differ");
});

await check("STATUS_LABELS covers exactly the certificate lifecycle states", () => {
  const block = helpersSrc.slice(helpersSrc.indexOf("STATUS_LABELS = {"), helpersSrc.indexOf("STATUS_BADGE"));
  const keys = [...block.matchAll(/^\s*([a-z]+):/gm)].map((x) => x[1]).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["active", "expired", "revoked", "superseded"]), keys.join(","));
});

const verifySvcSrc = read("backend/services/verification.js");
const verdictsBlock = verifySvcSrc.slice(verifySvcSrc.indexOf("const VERDICTS"), verifySvcSrc.indexOf("const DISCLAIMER"));
const BACKEND_VERDICTS = [...verdictsBlock.matchAll(/^\s*"?([a-z-]+)"?:\s*\{/gm)].map((x) => x[1]).sort();
const vrSrc = read("frontend/src/components/VerificationResult.js");
const styleBlock = vrSrc.slice(vrSrc.indexOf("VERDICT_STYLE = {"), vrSrc.indexOf("function Flag"));
const FRONT_VERDICTS = [...styleBlock.matchAll(/^\s*"?([a-z-]+)"?:\s*\{/gm)].map((x) => x[1]).sort();

await check("VerificationResult renders all 10 backend verdicts", () => {
  assert(BACKEND_VERDICTS.length === 10, `backend verdicts parsed: ${BACKEND_VERDICTS.length}`);
  assert(JSON.stringify(FRONT_VERDICTS) === JSON.stringify(BACKEND_VERDICTS),
    `frontend [${FRONT_VERDICTS}] vs backend [${BACKEND_VERDICTS}]`);
});

const tamperSrc = read("frontend/src/pages/TamperPage.js");
await check("TamperPage styles every tamper verdict (A + B)", () => {
  for (const v of ["intact", "stored-document-mismatch", "exact-match", "modified",
    "registered-under-different-id", "revoked", "expired", "superseded", "not-found"]) {
    assert(tamperSrc.includes(`"${v}"`) || tamperSrc.includes(`${v}:`), `missing verdict ${v}`);
  }
});

// ── 3. Source-level security / retirement invariants ─────
console.log("\n[3] Security + retirement invariants");

const srcFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (/\.(js|css)$/.test(entry.name)) srcFiles.push(rel);
  }
})("frontend/src");

await check("tour code is fully stripped (build-breaking imports gone)", () => {
  for (const rel of srcFiles) {
    assert(!/components\/tour|TourProvider|TourLauncher|useTour|nosih:tour/i.test(read(rel)), `${rel} references the tour`);
  }
  assert(!exists("frontend/src/components/tour"), "tour directory still present");
});

await check("land surfaces are gone from the frontend", () => {
  for (const rel of srcFiles) {
    assert(!/\/land|verifyLand|registerDeed|extractDeed|landQrUrl|LandRecord/i.test(read(rel)), `${rel} references land code`);
  }
  assert(!exists("frontend/src/pages/RegisterPage.js") && !exists("frontend/src/pages/RecordsPage.js"), "land pages remain");
  assert(exists("frontend/src/assets/nosih-logo.svg"), "NOSIH brand logo asset missing");
});

await check("no private key material anywhere in the frontend", () => {
  for (const rel of srcFiles) {
    assert(!/privateKey|PRIVATE_KEY|new ethers\.Wallet|new Wallet\(/i.test(read(rel)), `${rel} touches key material`);
  }
});

await check("frontend env surface is public-config only", () => {
  const used = new Set();
  for (const rel of srcFiles) {
    for (const mm of read(rel).matchAll(/process\.env\.(REACT_APP_[A-Z_]+)/g)) used.add(mm[1]);
  }
  const allowed = new Set(["REACT_APP_API_URL", "REACT_APP_CONTRACT_ADDRESS", "REACT_APP_CHAIN_ID", "REACT_APP_AMOY_RPC_URL"]);
  for (const name of used) assert(allowed.has(name), `forbidden env var ${name}`);
});

await check("revocation uses a reason-required modal, never window.prompt", () => {
  for (const rel of srcFiles) {
    assert(!/window\.prompt|window\.confirm/.test(read(rel)), `${rel} uses a native prompt`);
  }
  const modal = read("frontend/src/components/RevokeModal.js");
  assert(/minLength|>=\s*3/.test(modal) && /required/.test(modal), "reason not enforced");
  assert(/revokeCertificate\(/.test(modal), "modal does not call the revoke API");
});

const appSrc = read("frontend/src/App.js");
await check("verify + tamper are public; issuance is role-gated; all 8 pages routed", () => {
  assert(/path="\/verify" element=\{<VerifyPage/.test(appSrc), "verify not public");
  assert(/path="\/tamper" element=\{<TamperPage/.test(appSrc), "tamper not public");
  assert(/roles=\{\["issuer", "institution_admin"\]\}/.test(appSrc), "issue not role-gated");
  for (const page of ["LoginPage", "DashboardPage", "IssuePage", "CertificatesPage", "CertificateDetailsPage", "InstitutionsPage", "VerifyPage", "TamperPage"]) {
    assert(appSrc.includes(`<${page} `) || appSrc.includes(`<${page}/>`), `${page} not routed`);
  }
});

await check("every page renders errors through apiErrorMessage/blobErrorMessage", () => {
  for (const rel of srcFiles.filter((f) => f.startsWith("frontend/src/pages/") || f.startsWith("frontend/src/components/"))) {
    const src = read(rel);
    if (/catch\s*\(/.test(src) && /setError|setActionError|setConfirmError/.test(src)) {
      assert(/apiErrorMessage|blobErrorMessage|classifyWalletError/.test(src), `${rel} renders raw errors`);
    }
  }
});

await check("IssuePage implements the full handshake with recovery", () => {
  for (const needle of ["prepareIssuance", "issueCertificate(signer, prepare.issueArgs)", "confirmIssuance",
    "supersedesCertificateId", "USER_REJECTED", "Retry confirm", "status === 202", "recovery"]) {
    assert(issueSrc.includes(needle), `IssuePage missing ${needle}`);
  }
  const walletSrc = read("frontend/src/components/WalletConnect.js");
  assert(/connectAuthorizedIssuer/.test(walletSrc), "wallet gate not enforced in the UI");
});

await check("institution scoping helpers mirror backend role rules", () => {
  assert(/canRevoke[\s\S]*platform_admin[\s\S]*institution_admin/.test(helpersSrc), "revoke role rule wrong");
  const reissueFn = helpersSrc.slice(helpersSrc.indexOf("export function canReissue"));
  assert(!reissueFn.includes("platform_admin"), "backend reissue excludes platform_admin");
});

// ── 4. Production build + broken-API resilience (HTTP) ───
console.log("\n[4] Production build under a failing API");

await check("production build exists (index + bundle + css)", () => {
  assert(exists("frontend/build/index.html"), "run npm run build --prefix frontend first");
  const html = read("frontend/build/index.html");
  assert(/<div id="root">/.test(html), "root div missing");
  assert(/NOSIH/.test(html), "branding not updated");
  const js = [...html.matchAll(/static\/js\/[a-z0-9.]+\.js/g)].map((x) => x[0]);
  const css = [...html.matchAll(/static\/css\/[a-z0-9.]+\.css/g)].map((x) => x[0]);
  assert(js.length > 0 && css.length > 0, "bundle references missing");
  for (const asset of [...js, ...css]) assert(exists(`frontend/build/${asset}`), `${asset} missing`);
});

await check("SPA + assets serve while every API call fails with the platform envelope", async () => {
  const buildDir = path.join(rootDir, "frontend", "build");
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "500", message: "A server error has occurred" } }));
      return;
    }
    const clean = req.url.split("?")[0];
    let file = path.join(buildDir, decodeURIComponent(clean));
    if (!file.startsWith(buildDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(buildDir, "index.html");
    }
    res.writeHead(200);
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ["/login", "/verify", "/tamper", "/issue", "/certificates"]) {
      const res = await fetch(base + route);
      assert(res.status === 200, `${route} → ${res.status}`);
      assert(/<div id="root">/.test(await res.text()), `${route} did not serve the SPA`);
    }
    const apiRes = await fetch(base + "/api/auth/login", { method: "POST" });
    assert(apiRes.status === 500, "broken API stand-in not active");
    const body = await apiRes.json();
    assert(typeof body.error === "object" && body.error.message, "platform envelope shape wrong");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

await check("apiErrorMessage flattens the platform envelope (React #31 guard)", async () => {
  // The util is plain ESM with an axios import — evaluate the pure function
  // by extracting it (no DOM needed).
  const fnSrc = apiSrc.slice(apiSrc.indexOf("export function apiErrorMessage"), apiSrc.indexOf("/**\n * Same guarantee"));
  const fn = new Function(`${fnSrc.replace("export function", "function")}; return apiErrorMessage;`)();
  const platformErr = { response: { data: { error: { code: "500", message: "A server error has occurred" } } } };
  assert(fn(platformErr) === "A server error has occurred", "envelope not flattened");
  assert(fn({ response: { data: { error: "plain" } } }) === "plain", "plain error lost");
  assert(fn(null, "fallback") === "fallback", "fallback lost");
  assert(typeof fn({ response: { data: { error: { code: "X" } } } }) === "string", "object leaked");
});

// ── Result ────────────────────────────────────────────────
console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
console.log("P8 offline gate: PASS");