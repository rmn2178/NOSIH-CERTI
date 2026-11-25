/**
 * Gemini client — TEXT ONLY, by construction.
 *
 * The NOSIH spec is explicit: JavaScript libraries extract the PDF's
 * contents first (text layer, then local OCR); Gemini receives the resulting
 * TEXT and structures it. The whole-PDF-base64 and rendered-image-vision
 * paths that existed in the land system are deleted, not disabled — this
 * module's public API accepts strings only, so an image or PDF part cannot
 * be sent even by accident. Pixels never leave the server.
 *
 * Reused from the audited NOSIH ai.js: retry with exponential backoff,
 * transient-vs-fatal error classification, a per-request deadline (never
 * module state — one process serves several extractions at once), and the
 * GEMINI_BASE_URL seam that lets a local stand-in prove the resilience
 * behaviour without spending API quota.
 */

import "../env.js"; // loads the repository-root .env — must come first
import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45000);
const GEMINI_MAX_ATTEMPTS = Number(process.env.GEMINI_MAX_ATTEMPTS || 3);
const GEMINI_BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_MS || 750);

let genAI = null;
function getGenAI() {
  if (!genAI) {
    if (!process.env.GEMINI_API_KEY) {
      const err = new Error("GEMINI_API_KEY not set in the root .env");
      err.status = 503;
      throw err;
    }
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

/** True when the extraction feature is configured at all. */
export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function getModel(schema, timeoutMs) {
  return getGenAI().getGenerativeModel(
    {
      model: GEMINI_MODEL,
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    },
    {
      timeout: timeoutMs,
      // Optional gateway / regional endpoint — also the stand-in seam.
      ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}),
    }
  );
}

/**
 * Whether a failure is worth retrying.
 * The HTTP status is read from the error object first: the SDK puts the
 * request URL in the message, and a bare substring test would read the
 * "500" inside a port number as a server error.
 */
export function isTransient(err) {
  const status = Number(err?.status ?? err?.response?.status);
  if (Number.isFinite(status) && status > 0) return status === 429 || status >= 500;

  const message = String(err?.message || err || "");
  return /\b(?:429|500|502|503|504)\b|unavailable|resource[_ ]exhausted|rate limit|too many requests|fetch failed|etimedout|econnreset|econnrefused|enotfound|socket hang up|network|timeout|abort/i.test(
    message
  );
}

/**
 * Whether no retry or fallback can recover: bad key, disabled API,
 * malformed request. Retrying these only spends the budget.
 */
export function isFatalModelError(err) {
  const status = Number(err?.status);
  if ([400, 401, 403, 404].includes(status)) return true;
  return /api[ _-]?key|permission|unauthenticated|billing|not set in the root \.env|invalid argument/i.test(
    String(err?.message || err || "")
  );
}

/**
 * Calls the model with a TEXT prompt, retrying transient failures.
 *
 * @param {string} prompt the full prompt text — a string, never parts with media
 * @param {object} schema the responseSchema
 * @param {number} deadline absolute ms after which no further attempt is made
 */
export async function generateStructuredText(prompt, schema, deadline = Infinity) {
  if (typeof prompt !== "string") {
    throw new Error("Gemini receives extracted text only — media parts are forbidden");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("the extraction budget is spent");

    try {
      const result = await getModel(schema, Math.min(GEMINI_TIMEOUT_MS, remaining)).generateContent([prompt]);
      return result.response.text();
    } catch (err) {
      lastError = err;
      const wait = GEMINI_BACKOFF_MS * 2 ** (attempt - 1);
      const exhausted = attempt === GEMINI_MAX_ATTEMPTS || Date.now() + wait >= deadline;
      if (!isTransient(err) || exhausted) throw err;

      const reason = String(err.message || err).split("\n")[0].slice(0, 120);
      console.warn(`[gemini] call failed (${reason}) — retry ${attempt + 1}/${GEMINI_MAX_ATTEMPTS} in ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/** Extracts the JSON object from a model answer (fenced or bare). */
export function parseJsonResponse(text) {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : cleaned);
  } catch {
    throw new Error("AI returned invalid JSON");
  }
}

export { GEMINI_MODEL, GEMINI_TIMEOUT_MS, GEMINI_MAX_ATTEMPTS, GEMINI_BACKOFF_MS };