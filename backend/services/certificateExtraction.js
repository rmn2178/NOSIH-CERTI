/**
 * Certificate extraction orchestrator — the NOSIH pipeline.
 *
 *   PDF upload → validation → JavaScript text extraction → sufficiency check
 *   → (insufficient) render pages → local Tesseract OCR → combine/clean text
 *   → Gemini structures the TEXT ONLY → editable fields for issuer review.
 *
 * Two strategies, in order: text-layer, then local-ocr→text. The land
 * system's whole-PDF-base64 and Gemini-vision paths are DELETED — gemini.js
 * accepts strings only, so media cannot leave this server even by accident.
 *
 * Extraction only pre-fills the review form. It is NEVER proof of
 * authenticity: an approved institution's authorized issuer must review and
 * approve every field before anything is hashed or issued on-chain.
 */

import "../env.js"; // loads the repository-root .env — must come first
import {
  validatePdf,
  extractPdfText,
  isTextSufficient,
  joinPages,
  cleanExtractedText,
  renderPdfPageBuffers,
  primeBrowserGlobals,
  primePdfWorker,
} from "./pdfParser.js";
import { ocrImages, ocrAvailable, shutdownOcr } from "./ocr.js";
import { canvasTextAvailable } from "./canvasIcu.js";
import { generateStructuredText, parseJsonResponse, isFatalModelError, geminiConfigured } from "./gemini.js";
import {
  CERTIFICATE_FIELDS,
  CERTIFICATE_TYPES,
  FIELD_SPEC,
  SCHEMA_RULES,
  buildBaseResponseSchema,
  buildExtraFieldsSchema,
  templateFor,
} from "./certificateTemplates.js";

/** The whole extraction, start to finish (both Gemini calls included). */
const EXTRACTION_BUDGET_MS = Number(process.env.EXTRACTION_BUDGET_MS || 120000);

/**
 * The strategy chain — the single description of what runs and what leaves
 * the server. Check scripts read this same list.
 */
export const EXTRACTION_STRATEGIES = [
  { id: "text-layer", name: "The text layer", leaves: "the PDF's own extracted text" },
  { id: "local-ocr", name: "Local OCR → text", leaves: "an OCR text dump — no pixels leave the server" },
];

function reportStrategy(id, detail = "") {
  console.log(`[extract] strategy: ${id}${detail ? ` — ${detail}` : ""}`);
}

/** What the issuer is told when the document could not be read. */
export const MANUAL_ENTRY =
  "This certificate could not be read automatically. You can fill the form manually.";

async function timed(label, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - started;
    if (ms >= 200) console.log(`[extract] ${label}: ${ms} ms`);
  }
}

// ── Prompt + parsing ──────────────────────────────────────

function basePrompt(text, source) {
  return `You are a precise certificate data extractor. Below is the text of an academic or professional certificate, taken from ${source}.

Return a single JSON object with exactly the base keys described here, plus fieldConfidence, fieldEvidence and inferredFields:

${FIELD_SPEC}

${SCHEMA_RULES}

Certificate text:
"""
${text}
"""`;
}

function extraPrompt(text, certificateType, extraFields) {
  const spec = `{\n${Object.entries(extraFields)
    .map(([key, desc]) => `  "${key}": ${JSON.stringify(desc)}`)
    .join(",\n")}\n}`;
  return `You are a precise certificate data extractor. The document is a ${certificateType} certificate. Below is its extracted text.

Return a single JSON object with exactly these extra keys plus fieldConfidence:

${spec}

Rules:
- Every key is present. A field that is not stated is an empty string "".
- NEVER guess or invent values. Preserve exact numbers and spellings. Dates are YYYY-MM-DD.
- fieldConfidence: 0 when empty, otherwise 0..1.

Certificate text:
"""
${text}
"""`;
}

const clamp01 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerces and validates the base answer — a schema constrains shape, not truth. */
export function parseCertificateResponse(raw) {
  const parsed = typeof raw === "string" ? parseJsonResponse(raw) : raw;
  const fields = {};
  for (const key of CERTIFICATE_FIELDS) fields[key] = String(parsed[key] ?? "").trim();

  if (!CERTIFICATE_TYPES.includes(fields.certificateType)) fields.certificateType = "other";
  for (const key of ["issueDate", "expiryDate"]) {
    if (fields[key] && !DATE_RE.test(fields[key])) fields[key] = "";
  }
  if (fields.percentage) {
    const n = fields.percentage.replace(/,/g, "").match(/\d+(\.\d+)?/);
    fields.percentage = n ? n[0] : "";
  }

  const confidence = {};
  const evidence = {};
  for (const key of CERTIFICATE_FIELDS) {
    confidence[key] = fields[key] ? clamp01(parsed.fieldConfidence?.[key]) : 0;
    evidence[key] = fields[key] ? String(parsed.fieldEvidence?.[key] ?? "").trim().slice(0, 200) : "";
  }
  const inferredFields = (Array.isArray(parsed.inferredFields) ? parsed.inferredFields : [])
    .filter((k) => CERTIFICATE_FIELDS.includes(k) && fields[k]);

  return { fields, confidence, evidence, inferredFields };
}

/** Enough to pre-fill a useful review form. */
export function isUsefulExtraction(r) {
  return Boolean(r?.fields?.holderName && r?.fields?.institutionName && r?.fields?.certificateType);
}

// ── The pipeline ──────────────────────────────────────────

/**
 * @param {string} filePath path to the uploaded PDF (caller cleans up)
 * @param {string} originalname original filename, for logs
 * @returns {Promise<{fields, extraData, confidence, evidence, inferredFields, strategy, pageCount, textLength}>}
 */
export async function extractCertificateMetadata(filePath, originalname = "certificate.pdf") {
  console.log(`\n[extract] ${originalname}`);
  const startedAt = Date.now();
  const deadline = startedAt + EXTRACTION_BUDGET_MS;

  if (!geminiConfigured()) {
    throw Object.assign(
      new Error("Extraction is not configured: GEMINI_API_KEY is missing in the backend environment"),
      { status: 503 }
    );
  }

  const strategyFailed = (label, err) => {
    if (isFatalModelError(err)) {
      console.error(`[extract] ${label} failed permanently: ${err.message}`);
      throw new Error(MANUAL_ENTRY);
    }
    console.warn(`[extract] ${label} failed: ${err.message}`);
  };

  // ── Stage 1: validation (original bytes preserved for hashing) ──
  const buffer = await timed("read+validate", async () => {
    const fs = await import("fs");
    return (await validatePdf(fs.readFileSync(filePath))).buffer;
  });

  await primeBrowserGlobals();
  await primePdfWorker();

  // ── Stage 2: JavaScript text extraction ──
  const parsed = await timed("text layer", () => extractPdfText(buffer));
  let text = isTextSufficient(parsed.text) ? parsed.text : joinPages(parsed.pages);
  let strategy = "text-layer";

  // ── Stage 3: local OCR fallback (pixels stay on this server) ──
  if (!isTextSufficient(text)) {
    console.log("[extract] text layer insufficient — falling back to local OCR");
    if (!ocrAvailable()) {
      console.warn("[extract] no OCR engine available");
    } else if (!canvasTextAvailable()) {
      console.warn("[extract] canvas cannot render pages safely");
    } else if (Date.now() < deadline) {
      try {
        const buffers = await timed("render pages", () => renderPdfPageBuffers(filePath));
        const { text: ocrText, engine } = await timed("local OCR", () => ocrImages(buffers));
        if (!ocrText || ocrText.trim().length < 40) {
          throw new Error("the OCR pass produced too little text to read");
        }
        text = cleanExtractedText(ocrText);
        strategy = "local-ocr";
        reportStrategy("local-ocr", `${engine}, ${text.length} characters`);
      } catch (err) {
        strategyFailed("local OCR", err);
      }
    }
  } else {
    reportStrategy("text-layer", `${text.length} characters read without rendering`);
  }

  if (!isTextSufficient(text)) throw new Error(MANUAL_ENTRY);

  // ── Stage 4: Gemini structures the TEXT (never images/PDF) ──
  let base;
  try {
    const source = strategy === "text-layer" ? "the certificate's own text layer" : "local OCR of scanned pages";
    const answer = await timed("gemini base", () =>
      generateStructuredText(basePrompt(text, source), buildBaseResponseSchema(), deadline)
    );
    base = parseCertificateResponse(answer);
  } catch (err) {
    strategyFailed("gemini structuring", err);
    throw new Error(MANUAL_ENTRY);
  }

  if (!isUsefulExtraction(base)) {
    console.warn("[extract] answer too sparse to pre-fill the form");
    throw new Error(MANUAL_ENTRY);
  }

  // ── Dynamic template extras (second targeted text call) ──
  const template = templateFor(base.fields.certificateType);
  const extraKeys = Object.keys(template.extraFields);
  let extraData = {};
  if (extraKeys.length > 0 && Date.now() < deadline) {
    try {
      const answer = await timed("gemini extras", () =>
        generateStructuredText(
          extraPrompt(text, base.fields.certificateType, template.extraFields),
          buildExtraFieldsSchema(template.extraFields),
          deadline
        )
      );
      const parsedExtra = parseJsonResponse(answer);
      for (const key of extraKeys) {
        const value = String(parsedExtra[key] ?? "").trim();
        if (value) {
          extraData[key] = value;
          base.confidence[key] = clamp01(parsedExtra.fieldConfidence?.[key]);
        }
      }
    } catch (err) {
      // Extras are optional — the base fields still stand.
      console.warn("[extract] template extras failed:", err.message);
    }
  }

  console.log(`[extract] ✓ ${strategy} succeeded in ${Date.now() - startedAt} ms`);
  return {
    ...base,
    extraData,
    strategy,
    pageCount: parsed.pageCount,
    textLength: text.length,
  };
}

/**
 * Releases the OCR worker before process exit — a live worker thread trips
 * a libuv assertion on Windows and can block serverless freeze.
 */
export async function shutdownExtraction() {
  await shutdownOcr();
}