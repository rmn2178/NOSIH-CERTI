/**
 * NOSIH public verification routes — NO authentication, rate-limited.
 *
 * GET  /api/verify/:certificateId               chain-authoritative verdict
 * POST /api/verify/:certificateId/tamper-check  Mode A (no file) / Mode B (PDF)
 * GET  /api/verify/:certificateId/qr            QR PNG for the verify page
 *
 * Every verdict comes from the CHAIN first. A database row alone never makes
 * a certificate authentic; an unreachable chain answers 503 INDETERMINATE.
 * Integrity checks are pure SHA-256 — no AI, no decrypted content exposure.
 */

import "../env.js"; // loads the repository-root .env — must come first
import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { MAX_UPLOAD_BYTES } from "../config.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import {
  verifyCertificate,
  tamperCheckStored,
  tamperCheckUploaded,
} from "../services/verification.js";
import { generateCertificateQr } from "../services/qr.js";
import { isCertificateId } from "../services/certificateIdentity.js";

const router = Router();

// ~60 requests/min/IP by default (brief §18). Tunable for deployments.
const verifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.VERIFY_RATE_LIMIT_PER_MIN || 60),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ error: "Too many verification requests — wait a minute and retry." }),
});
router.use(verifyLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_, file, cb) =>
    file.mimetype === "application/pdf"
      ? cb(null, true)
      : cb(Object.assign(new Error("Only PDF documents are accepted"), { status: 400 }), false),
});

// ── Verdict ──────────────────────────────────────────────
// The 'verified' audit event is written asynchronously by the service.

router.get(
  "/:certificateId",
  asyncHandler(async (req, res) => {
    const { httpStatus, payload } = await verifyCertificate(req.params.certificateId);
    res.status(httpStatus).json(payload);
  })
);

// ── Tamper check (Mode A: id only · Mode B: id + uploaded PDF) ──

router.post(
  "/:certificateId/tamper-check",
  upload.single("document"),
  asyncHandler(async (req, res) => {
    const result = req.file
      ? await tamperCheckUploaded(req.params.certificateId, req.file.buffer)
      : await tamperCheckStored(req.params.certificateId);
    res.json(result);
  })
);

// ── QR (public — it only encodes the public verify URL) ──

router.get(
  "/:certificateId/qr",
  asyncHandler(async (req, res) => {
    const id = String(req.params.certificateId ?? "").toUpperCase();
    if (!isCertificateId(id)) {
      return res.status(400).json({ error: "Certificate ID must look like CERT-XXXXXXXX" });
    }
    const { png } = await generateCertificateQr(id, req);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename="${id}-QR.png"`);
    res.send(png);
  })
);

export default router;