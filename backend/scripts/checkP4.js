/**
 * P4 offline gate — extraction pipeline, NO API quota spent.
 *
 * A local stand-in server plays the Gemini REST endpoint (the GEMINI_BASE_URL
 * seam). It CAPTURES every request payload, so the gate proves:
 *   - only TEXT parts are ever sent (no inlineData, no image/PDF mime)
 *   - retry-with-backoff on 503, fatal-stop on 400, budget enforcement
 *   - the full pipeline on a digital fixture (text-layer strategy)
 *   - the full pipeline on a scanned fixture (local-ocr strategy, real
 *     Tesseract running locally)
 *   - validation rejections: non-PDF, empty, oversized, page-cap
 *   - parser coercion: dates, percentage, confidence clamps, inferred list
 *   - the forbidden whole-pdf/vision paths are gone from the source
 *
 * The real-Gemini fixture check runs later with credentials (task #16).
 * Run: node backend/scripts/checkP4.js
 */

// Stand-in configuration — set BEFORE the service modules are imported.
process.env.GEMINI_API_KEY = "stand-in-key-not-real";
process.env.GEMINI_BACKOFF_MS = "50";
process.env.GEMINI_MAX_ATTEMPTS = "3";
process.env.GEMINI_TIMEOUT_MS = "5000";

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { makeCertificateFixtures } from "./makeCertificateFixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "..");

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

// ── The stand-in Gemini server ────────────────────────────

const BASE_ANSWER = {
  certificateType: "undergraduate_degree",
  certificateNumber: "AU/2024/UG/001234",
  holderName: "Asha Rao",
  holderIdentifier: "21CS1042",
  institutionName: "Anna University",
  institutionAddress: "Guindy, Chennai 600025",
  courseName: "Bachelor of Engineering",
  qualification: "Bachelor of Engineering",
  qualificationLevel: "undergraduate",
  specialization: "Computer Science and Engineering",
  grade: "First Class with Distinction",
  percentage: "87.5",
  issueDate: "2024-08-15",
  expiryDate: "",
  academicYear: "2020-2024",
  signatoryName: "R. Kumar",
  signatoryDesignation: "Controller of Examinations",
  fieldConfidence: Object.fromEntries([
    ["certificateType", 0.9], ["certificateNumber", 0.98], ["holderName", 0.99],
    ["holderIdentifier", 0.95], ["institutionName", 0.99], ["institutionAddress", 0.9],
    ["courseName", 0.95], ["qualification", 0.97], ["qualificationLevel", 0.8],
    ["specialization", 0.95], ["grade", 0.95], ["percentage", 0.97],
    ["issueDate", 0.95], ["expiryDate", 0], ["academicYear", 0.9],
    ["signatoryName", 0.9], ["signatoryDesignation", 0.9],
  ]),
  fieldEvidence: {
    holderName: "ASHA RAO",
    certificateNumber: "Certificate No: AU/2024/UG/001234",
    percentage: "Percentage: 87.5",
  },
  inferredFields: ["qualificationLevel"],
};

const EXTRA_ANSWER = {
  universityRegistrationNumber: "21CS1042",
  degreeClass: "First Class with Distinction",
  convocationDate: "2024-08-15",
  cgpa: "8.7",
  fieldConfidence: { universityRegistrationNumber: 0.95, degreeClass: 0.95, convocationDate: 0.9, cgpa: 0.97 },
};

const captured = [];
let mode = "normal"; // normal | retry-once | fatal
let modeRequests = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const payload = JSON.parse(body);
    captured.push({ url: req.url, payload });
    modeRequests++;

    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (mode === "fatal") {
      return send(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
    }
    if (mode === "retry-once" && modeRequests === 1) {
      return send(503, { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } });
    }

    const prompt = payload.contents?.[0]?.parts?.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("\n") ?? "";
    const answer = prompt.includes("extra keys") ? EXTRA_ANSWER : BASE_ANSWER;
    send(200, {
      candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }], role: "model" }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 },
      modelVersion: "stand-in",
    });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
console.log(`\nStand-in Gemini at ${process.env.GEMINI_BASE_URL}\n`);

// Import services AFTER the env is set.
const pdfParser = await import("../services/pdfParser.js");
const gemini = await import("../services/gemini.js");
const extraction = await import("../services/certificateExtraction.js");
const templates = await import("../services/certificateTemplates.js");
const { ocrAvailable } = await import("../services/ocr.js");
const { canvasTextAvailable } = await import("../services/canvasIcu.js");

const fixtures = await makeCertificateFixtures();

// ── 1. Validation ─────────────────────────────────────────
console.log("[1] PDF validation");

await check("digital fixture validates (1 page)", async () => {
  const r = await pdfParser.validatePdf(fs.readFileSync(fixtures.digital));
  assert(r.pageCount === 1, `pageCount ${r.pageCount}`);
});

await check("non-PDF bytes rejected", async () => {
  try { await pdfParser.validatePdf(Buffer.from("this is not a pdf at all")); assert(false, "accepted"); }
  catch (err) { assert(err.status === 400, `status ${err.status}`); }
});

await check("empty buffer rejected", async () => {
  try { await pdfParser.validatePdf(Buffer.alloc(0)); assert(false, "accepted"); }
  catch (err) { assert(err.status === 400, `status ${err.status}`); }
});

await check("oversized PDF rejected (413)", async () => {
  const { MAX_UPLOAD_BYTES } = await import("../config.js");
  const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
  big.write("%PDF-1.4", 0);
  try { await pdfParser.validatePdf(big); assert(false, "accepted"); }
  catch (err) { assert(err.status === 413, `status ${err.status}`); }
});

await check("page cap enforced (11 pages > 10)", async () => {
  try { await pdfParser.validatePdf(fs.readFileSync(fixtures.manyPages)); assert(false, "accepted"); }
  catch (err) { assert(err.status === 400 && /limit is 10/.test(err.message), err.message); }
});

// ── 2. Text extraction ────────────────────────────────────
console.log("\n[2] JavaScript text extraction");

await check("digital fixture: sufficient text + per-page blocks", async () => {
  const r = await pdfParser.extractPdfText(fs.readFileSync(fixtures.digital));
  assert(pdfParser.isTextSufficient(r.text), `only ${r.text.length} chars`);
  assert(r.pages.length === 1 && r.pages[0].num === 1, "per-page blocks missing");
  assert(r.text.includes("ASHA RAO"), "holder name not in text");
  assert(r.text.includes("AU/2024/UG/001234"), "certificate number not in text");
});

await check("scanned fixture: text layer insufficient (OCR required)", async () => {
  const r = await pdfParser.extractPdfText(fs.readFileSync(fixtures.scanned));
  assert(!pdfParser.isTextSufficient(r.text), `scanned PDF yielded ${r.text.length} chars of text`);
});

// ── 3. Parser coercion ────────────────────────────────────
console.log("\n[3] Response parsing");

await check("dates normalized, percentage coerced, confidence clamped", () => {
  const r = extraction.parseCertificateResponse({
    ...BASE_ANSWER,
    issueDate: "15/08/2024",       // wrong format → dropped
    percentage: "87.5 %",          // coerced
    fieldConfidence: { ...BASE_ANSWER.fieldConfidence, holderName: 7, grade: -2 },
    inferredFields: ["qualificationLevel", "holderName", "notAField"],
  });
  assert(r.fields.issueDate === "", "bad date kept");
  assert(r.fields.percentage === "87.5", `percentage ${r.fields.percentage}`);
  assert(r.confidence.holderName === 1, "confidence not clamped to 1");
  assert(r.confidence.grade === 0, "negative confidence not clamped to 0");
  assert(r.confidence.expiryDate === 0, "empty field has nonzero confidence");
  // Known, non-empty fields survive; unknown names are dropped.
  assert(r.inferredFields.length === 2, `inferred list: ${r.inferredFields.join(",")}`);
  assert(r.inferredFields.includes("qualificationLevel") && !r.inferredFields.includes("notAField"), "inferred list not filtered");
});

await check("unknown certificate type falls back to other", () => {
  const r = extraction.parseCertificateResponse({ ...BASE_ANSWER, certificateType: "phd_in_astrophysics" });
  assert(r.fields.certificateType === "other", "unknown type kept");
});

await check("fenced JSON answers parse", () => {
  const r = extraction.parseCertificateResponse("```json\n" + JSON.stringify(BASE_ANSWER) + "\n```");
  assert(r.fields.holderName === "Asha Rao", "fenced answer not parsed");
});

// ── 4. Gemini client resilience (stand-in) ────────────────
console.log("\n[4] Gemini client resilience");

await check("media parts are rejected by construction", async () => {
  try {
    await gemini.generateStructuredText({ inlineData: { data: "x", mimeType: "image/jpeg" } }, {});
    assert(false, "media accepted");
  } catch (err) {
    assert(/text only/i.test(err.message), err.message);
  }
});

await check("spent budget throws before any HTTP call", async () => {
  const before = captured.length;
  try {
    await gemini.generateStructuredText("prompt", templates.buildBaseResponseSchema(), Date.now() - 1000);
    assert(false, "budget not enforced");
  } catch (err) {
    assert(/budget/i.test(err.message), err.message);
    assert(captured.length === before, "HTTP call made despite spent budget");
  }
});

await check("503 → retry with backoff → success", async () => {
  mode = "retry-once"; modeRequests = 0;
  const text = await gemini.generateStructuredText("base prompt", templates.buildBaseResponseSchema());
  assert(modeRequests === 2, `expected 2 attempts, got ${modeRequests}`);
  assert(JSON.parse(text).holderName === "Asha Rao", "wrong answer after retry");
  mode = "normal";
});

await check("400 → fatal, no retry", async () => {
  mode = "fatal"; modeRequests = 0;
  try {
    await gemini.generateStructuredText("base prompt", templates.buildBaseResponseSchema());
    assert(false, "fatal error not thrown");
  } catch (err) {
    assert(gemini.isFatalModelError(err), "not classified fatal");
    assert(modeRequests === 1, `retried a fatal error (${modeRequests} requests)`);
  }
  mode = "normal";
});

// ── 5. Full pipeline ──────────────────────────────────────
console.log("\n[5] Full extraction pipeline");

await check("digital fixture → text-layer strategy + template extras", async () => {
  captured.length = 0;
  const r = await extraction.extractCertificateMetadata(fixtures.digital, "digital-certificate.pdf");
  assert(r.strategy === "text-layer", `strategy ${r.strategy}`);
  assert(r.fields.holderName === "Asha Rao", "holderName wrong");
  assert(r.fields.certificateNumber === "AU/2024/UG/001234", "certificateNumber wrong");
  assert(r.fields.issueDate === "2024-08-15", "issueDate wrong");
  assert(r.extraData.cgpa === "8.7", "template extra (cgpa) missing");
  assert(r.confidence.cgpa > 0, "extra confidence missing");
  assert(r.inferredFields.includes("qualificationLevel"), "inferred flag lost");
  assert(r.evidence.holderName === "ASHA RAO", "evidence fragment lost");
  assert(captured.length === 2, `expected base+extras calls, got ${captured.length}`);
});

await check("every captured payload is TEXT ONLY", () => {
  assert(captured.length > 0, "nothing captured");
  for (const { payload } of captured) {
    const raw = JSON.stringify(payload);
    assert(!raw.includes("inlineData"), "inlineData part sent");
    assert(!/image\/|application\/pdf/.test(raw), "media mime type sent");
    for (const content of payload.contents ?? []) {
      for (const part of content.parts ?? []) {
        assert(typeof part === "string" || typeof part.text === "string", "non-text part sent");
      }
    }
    assert(payload.generationConfig?.responseMimeType === "application/json", "JSON mode not requested");
    assert(payload.generationConfig?.responseSchema, "responseSchema not sent");
  }
});

await check("scanned fixture → local-ocr strategy (real Tesseract)", async () => {
  assert(ocrAvailable(), "OCR engine unavailable");
  assert(canvasTextAvailable(), "canvas cannot render safely");
  captured.length = 0;
  const r = await extraction.extractCertificateMetadata(fixtures.scanned, "scanned-certificate.pdf");
  assert(r.strategy === "local-ocr", `strategy ${r.strategy}`);
  assert(r.textLength >= 200, `OCR text too short: ${r.textLength}`);
  const prompt = captured[0].payload.contents[0].parts.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("\n");
  assert(prompt.includes("--- page 1 ---"), "OCR page markers missing from prompt");
  assert(/ASHA|CERTIFICATE|ANNA/i.test(prompt), "OCR text not recognisable in prompt");
});

await check("missing GEMINI_API_KEY → clear 503, never simulated success", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await extraction.extractCertificateMetadata(fixtures.digital, "x.pdf");
    assert(false, "extraction ran without a key");
  } catch (err) {
    assert(err.status === 503 && /GEMINI_API_KEY/.test(err.message), err.message);
  } finally {
    process.env.GEMINI_API_KEY = saved;
  }
});

// ── 6. Forbidden paths are gone ───────────────────────────
console.log("\n[6] Source-level guarantees");

await check("no whole-pdf / vision code remains anywhere", () => {
  // The legacy ai.js was deleted in P7 — its absence is itself asserted.
  assert(!fs.existsSync(path.join(backendDir, "services/ai.js")), "legacy services/ai.js must be deleted");
  for (const file of ["services/gemini.js", "services/certificateExtraction.js", "services/pdfParser.js"]) {
    const src = fs.readFileSync(path.join(backendDir, file), "utf8");
    assert(!src.includes("inlineData"), `${file} contains inlineData`);
    assert(!/extractWithGeminiPdf|extractWithGeminiVision|renderPdfPages\b/.test(src), `${file} contains a deleted vision/pdf function`);
    assert(!/id:\s*"(whole-pdf|rendered-vision)"/.test(src), `${file} still lists a forbidden strategy`);
  }
});

await check("strategy lists expose exactly text-layer + local-ocr", () => {
  const ids = extraction.EXTRACTION_STRATEGIES.map((s) => s.id);
  assert(ids.join(",") === "text-layer,local-ocr", ids.join(","));
});

// ── Teardown ──────────────────────────────────────────────
await extraction.shutdownExtraction();
server.close();

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);