import "../env.js"; // loads the repository-root .env — must come first
import { MAX_UPLOAD_MB } from "../config.js";
import { isUniqueViolation } from "../supabase.js";

/**
 * Central Express error handler. Keeps every failure a readable JSON error
 * (the frontend's apiErrorMessage sanitizer depends on { error: string }).
 * Multer, Joi and Postgres constraint violations get precise status codes.
 */
export function errorHandler(err, _req, res, _next) {
  console.error("[Error]", err.message);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_MB} MB)` });
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: "Unexpected upload field name" });
  }
  if (err.isJoi || err.name === "ValidationError") {
    const detail = err.details?.map((d) => d.message).join("; ") || err.message;
    return res.status(400).json({ error: detail });
  }
  if (isUniqueViolation(err)) {
    return res.status(409).json({ error: "A record with these unique values already exists" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large" });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
}

/** Wraps an async route handler so rejections reach errorHandler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);