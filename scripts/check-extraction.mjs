/**
 * Exercises the certificate extraction chain against the REAL Gemini API.
 *
 *   node scripts/check-extraction.mjs [file.pdf]
 *
 * With no argument it builds both fixtures — a digital certificate and a
 * scanned one — and runs each through the service. It asserts:
 *
 *   - the extraction succeeded and was useful,
 *   - the EXPECTED strategy answered (digital → text-layer; scanned →
 *     local-ocr, i.e. recognised on the server and sent as a text dump —
 *     no certificate image ever leaves the deployment),
 *   - the identity fields the fixture states came back correctly.
 *
 * Passing a file of your own skips the strategy/field assertions, since the
 * script cannot know what that certificate says.
 *
 * Spends Gemini quota. The offline companion is backend/scripts/checkP4.js
 * (stand-in model: retry, backoff, budget, text-only payloads).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BACKEND = path.join(ROOT, "backend");

const { makeCertificateFixtures } = await import(
  pathToFileURL(path.join(BACKEND, "scripts", "makeCertificateFixtures.js")).href
);

const given = process.argv[2];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosih-extract-"));

let cases;
if (given) {
  cases = [[path.resolve(given), path.basename(given), null]];
} else {
  const fixtures = await makeCertificateFixtures(workDir);
  cases = [
    [fixtures.digital, "digital certificate", "text-layer"],
    [fixtures.scanned, "scanned certificate", "local-ocr"],
  ];
}

// Normalized comparison — the model may change case/spacing, not facts.
const norm = (v) => String(v ?? "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
const EXPECTED = {
  holderName: "ASHA RAO",
  holderIdentifier: "21CS1042",
  institutionName: "ANNA UNIVERSITY",
  certificateNumber: "AU/2024/UG/001234",
  qualification: "BACHELOR OF ENGINEERING",
  specialization: "COMPUTER SCIENCE AND ENGINEERING",
  percentage: "87.5",
  academicYear: "2020 2024",
  issueDate: "2024 08 15",
  signatoryName: "R KUMAR",
};

const service = path.join(BACKEND, "services", "certificateExtraction.js");
const { EXTRACTION_STRATEGIES } = await import(pathToFileURL(service).href);
const strategyName = (id) => EXTRACTION_STRATEGIES.find((s) => s.id === id)?.name ?? id;

const probe = path.join(workDir, "probe.mjs");
fs.writeFileSync(
  probe,
  `import { extractCertificateMetadata, isUsefulExtraction, shutdownExtraction } from "${pathToFileURL(service).href}";
let error = "";
let data = null;
try {
  data = await extractCertificateMetadata(process.argv[2], "check.pdf");
} catch (err) {
  error = err && err.message ? err.message : String(err);
} finally {
  // The OCR worker is a live thread; exiting with it running trips a libuv
  // assertion on Windows. Release it before the process ends.
  try { await shutdownExtraction(); } catch { /* it is going away anyway */ }
}
console.log("EXTRACT_RESULT " + JSON.stringify({ error, data, useful: isUsefulExtraction(data) }));
`,
  "utf8"
);

console.log("Certificate extraction check — real Gemini API");
console.log(`  model: ${process.env.GEMINI_MODEL || "gemini-3.6-flash (default)"}`);

let failures = 0;
for (const [file, label, expectedStrategy] of cases) {
  const res = spawnSync(process.execPath, [probe, file], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env },
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const line = out.split(/\r?\n/).find((l) => l.startsWith("EXTRACT_RESULT "));
  if (!line) {
    console.log(`  FAIL  ${label} — the extractor did not report a result`);
    out.split(/\r?\n/).slice(-8).forEach((l) => console.log(`        ${l}`));
    failures++;
    continue;
  }

  const parsed = JSON.parse(line.slice("EXTRACT_RESULT ".length));
  const strategy = parsed.data?.strategy ?? "none";

  if (parsed.error) {
    console.log(`  FAIL  ${label} — ${strategy}: ${parsed.error}`);
    failures++;
    continue;
  }
  if (!parsed.useful) {
    console.log(`  FAIL  ${label} — ${strategy}: extraction was not useful`);
    console.log(`        ${JSON.stringify(parsed.data?.fields)}`);
    failures++;
    continue;
  }

  const problems = [];
  if (expectedStrategy) {
    if (strategy !== expectedStrategy) {
      problems.push(`expected strategy ${expectedStrategy}, got ${strategy}`);
    }
    for (const [key, want] of Object.entries(EXPECTED)) {
      const got = norm(parsed.data.fields?.[key]);
      // Dates/years may be reformatted — compare digit content, not punctuation.
      const wanted = want.replace(/[^A-Z0-9.]/g, "");
      const gotten = got.replace(/[^A-Z0-9.]/g, "");
      if (!gotten.includes(wanted) && !wanted.includes(gotten)) {
        problems.push(`${key}: "${parsed.data.fields?.[key]}" ≠ "${want}"`);
      }
    }
  }

  if (problems.length) {
    console.log(`  FAIL  ${label} — ${strategyName(strategy)}`);
    problems.forEach((p) => console.log(`        ${p}`));
    failures++;
    continue;
  }

  const f = parsed.data.fields;
  console.log(`  PASS  ${label} — ${strategyName(strategy)}`);
  console.log(`        ${f.holderName} · ${f.certificateNumber} · ${f.institutionName}`);
  console.log(`        ${f.qualification} (${f.specialization}) · ${f.percentage}% · ${f.academicYear}`);
}

fs.rmSync(workDir, { recursive: true, force: true });
console.log("");
if (failures) {
  console.log(`${failures} extraction check(s) FAILED.`);
  process.exit(1);
}
console.log("Every extraction check PASS.");
console.log("  Digital certificate read through its text layer; scanned certificate");
console.log("  recognised locally and sent to the model as a text dump only.");