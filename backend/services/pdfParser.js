/**
 * PDF parsing — validation, JavaScript text extraction, page rendering.
 *
 * Stage 1–3 of the NOSIH extraction pipeline. Everything here runs on
 * the server; the only thing that may leave is the extracted TEXT (see
 * gemini.js). Native modules are loaded lazily so a platform-level binary
 * problem cannot kill the whole function at import time.
 *
 * The literal import specifiers (pdf.worker.mjs, @napi-rs/canvas) are
 * deployment-tracer hints carried over verbatim from the audited NOSIH
 * pipeline — production broke without them ("Setting up fake worker
 * failed", "DOMMatrix is not defined").
 */

import "../env.js"; // loads the repository-root .env — must come first
import fs from "fs";
import { createRequire } from "module";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "../config.js";

const require = createRequire(import.meta.url);

/** Minimum trimmed characters for the text layer to count as readable. */
export const PDF_TEXT_MIN_CHARS = Number(process.env.PDF_TEXT_MIN_CHARS || 200);

/** Hard page cap — validation rejects anything longer. */
export const MAX_PDF_PAGES = Number(process.env.MAX_PDF_PAGES || 10);

/** Longest text sent to the model (characters). */
const MAX_TEXT_CHARS = 60000;

// ── Lazy native / heavy modules ───────────────────────────

let pdfParsePromise = null;
function getPDFParse() {
  if (!pdfParsePromise) {
    pdfParsePromise = Promise.resolve(require("pdf-parse").PDFParse);
  }
  return pdfParsePromise;
}

let pdfToPngPromise = null;
function getPdfToPng() {
  if (!pdfToPngPromise) {
    pdfToPngPromise = import("pdf-to-png-converter").then((m) => m.pdfToPng);
  }
  return pdfToPngPromise;
}

let sharpPromise = null;
function getSharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then((m) => m.default ?? m);
  return sharpPromise;
}

/**
 * PDF.js needs its worker module before it can read a PDF. Importing it here
 * gives the file tracer a literal specifier to follow. The worker must NOT
 * be handed to PDF.js by hand — pdf-parse bundles its own copy and a worker
 * from a different version is refused ("The API version does not match the
 * Worker version").
 */
let pdfWorkerPromise = null;
export function primePdfWorker() {
  if (!pdfWorkerPromise) {
    pdfWorkerPromise = import("pdfjs-dist/legacy/build/pdf.worker.mjs").catch((err) => {
      console.warn("[pdf] PDF.js worker could not be preloaded:", err.message);
    });
  }
  return pdfWorkerPromise;
}

/**
 * PDF.js reads DOMMatrix, ImageData and Path2D at module scope. Setting the
 * globals from @napi-rs/canvas BEFORE PDF.js loads means its own runtime
 * require (which a serverless tracer cannot follow) never happens.
 */
let canvasPromise = null;
export async function primeBrowserGlobals() {
  if (globalThis.DOMMatrix && globalThis.ImageData && globalThis.Path2D) return;
  if (!canvasPromise) {
    canvasPromise = import("@napi-rs/canvas")
      .then((canvas) => {
        globalThis.DOMMatrix ??= canvas.DOMMatrix;
        globalThis.ImageData ??= canvas.ImageData;
        globalThis.Path2D ??= canvas.Path2D;
        console.log("[pdf] browser globals primed for PDF.js");
      })
      .catch((err) => {
        console.warn("[pdf] @napi-rs/canvas is unavailable:", err.message);
      });
  }
  return canvasPromise;
}

// ── Stage 1: validation ───────────────────────────────────

/**
 * Validates an uploaded certificate PDF. Throws a 400-class error with a
 * readable message on any failure. The ORIGINAL buffer is returned untouched
 * — it is what gets SHA-256 hashed and encrypted during issuance.
 *
 * @param {Buffer} buffer the exact uploaded bytes
 * @returns {Promise<{buffer: Buffer, pageCount: number, sizeBytes: number}>}
 */
export async function validatePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("No PDF file received"), { status: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`PDF is too large (max ${MAX_UPLOAD_MB} MB)`), { status: 413 });
  }
  // Magic bytes: a PDF starts with %PDF- within the first 1024 bytes.
  const head = buffer.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) {
    throw Object.assign(new Error("File is not a PDF (magic bytes missing)"), { status: 400 });
  }

  let parser;
  try {
    const PDFParse = await getPDFParse();
    parser = new PDFParse({ data: buffer });
    const info = await parser.getInfo();
    const pageCount = Number(info?.total ?? info?.numPages ?? 0);
    if (!pageCount || pageCount < 1) {
      throw Object.assign(new Error("PDF is malformed (no readable pages)"), { status: 400 });
    }
    if (pageCount > MAX_PDF_PAGES) {
      throw Object.assign(
        new Error(`PDF has ${pageCount} pages; the limit is ${MAX_PDF_PAGES}`),
        { status: 400 }
      );
    }
    return { buffer, pageCount, sizeBytes: buffer.length };
  } catch (err) {
    if (err.status) throw err;
    throw Object.assign(new Error(`PDF is malformed or unreadable: ${err.message}`), { status: 400 });
  } finally {
    try { await parser?.destroy(); } catch { /* ignore */ }
  }
}

// ── Stage 2: JavaScript text extraction ───────────────────

/**
 * Extracts the text layer with pdf-parse (pdf.js under the hood).
 * Returns per-page blocks in reading order plus the joined text.
 * Never throws for a text-less (scanned) PDF — that is a normal outcome.
 *
 * @returns {Promise<{text: string, pages: Array<{num: number, text: string}>, pageCount: number}>}
 */
export async function extractPdfText(buffer) {
  let parser;
  try {
    const PDFParse = await getPDFParse();
    parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    const pages = (parsed.pages ?? []).map((p) => ({ num: p.num, text: String(p.text ?? "").trim() }));
    const pageCount = Number(parsed.total ?? pages.length ?? 0);
    const text = cleanExtractedText(parsed.text ?? pages.map((p) => p.text).join("\n\n"));
    return { text, pages, pageCount };
  } catch (err) {
    console.warn("[pdf] text extraction failed:", err.message);
    return { text: "", pages: [], pageCount: 0 };
  } finally {
    try { await parser?.destroy(); } catch { /* ignore */ }
  }
}

/** Whether the extracted text is sufficient to skip OCR. */
export function isTextSufficient(text) {
  return String(text ?? "").trim().length >= PDF_TEXT_MIN_CHARS;
}

/**
 * Normalizes extracted text: unified line endings, collapses runs of blank
 * lines and horizontal whitespace, keeps page markers intact.
 */
export function cleanExtractedText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/** Combines per-page text into one document with stable page markers. */
export function joinPages(pages) {
  return cleanExtractedText(
    pages
      .filter((p) => p.text)
      .map((p) => `--- page ${p.num} ---\n${p.text}`)
      .join("\n\n")
  );
}

// ── Stage 3 support: page rendering for local OCR ─────────

/**
 * Renders pages to JPEG buffers for Tesseract. JPEG encodes several times
 * faster than PNG and the OCR engine reads it happily. Pixels stay here —
 * these buffers are NEVER sent to any external service.
 *
 * @param {string} filePath path to the PDF on disk
 * @param {number} maxPages page cap (defaults to MAX_PDF_PAGES)
 */
export async function renderPdfPageBuffers(filePath, maxPages = MAX_PDF_PAGES) {
  await primeBrowserGlobals();
  await primePdfWorker();
  const pdfToPng = await getPdfToPng();
  const sharp = await getSharp();
  const pages = await pdfToPng(filePath, {
    viewportScale: 2.0,
    pagesToProcess: Array.from({ length: maxPages }, (_, i) => i + 1),
  });
  const out = [];
  for (const page of pages.slice(0, maxPages)) {
    const jpeg = await sharp(page.content)
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
    out.push(jpeg);
  }
  return out;
}

/** Reads a file into a buffer (upload temp files are cleaned by the caller). */
export function readPdfFile(filePath) {
  return fs.readFileSync(filePath);
}