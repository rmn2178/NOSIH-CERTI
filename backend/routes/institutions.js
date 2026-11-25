import "../env.js"; // loads the repository-root .env — must come first
import { Router } from "express";
import bcrypt from "bcryptjs";
import Joi from "joi";
import {
  supabase,
  institutionFromRow,
  issuerWalletFromRow,
  userFromRow,
  isUniqueViolation,
} from "../supabase.js";
import { protect, platformAdminOnly, institutionAdminOnly } from "../middleware/auth.js";
import {
  loadCurrentUser,
  requireInstitutionMember,
  requireApprovedInstitution,
  attachOwnInstitution,
} from "../middleware/institutionAccess.js";
import { asyncHandler } from "../middleware/errorHandler.js";
import {
  generateInstitutionId,
  computeInstitutionIdentityHash,
} from "../services/certificateIdentity.js";

const router = Router();
const BCRYPT_ROUNDS = 12;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function validate(schema, body) {
  const { error, value } = schema.validate(body ?? {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    const err = new Error(error.details.map((d) => d.message).join("; "));
    err.status = 400;
    throw err;
  }
  return value;
}

const applySchema = Joi.object({
  name: Joi.string().min(2).max(200).required(),
  legalName: Joi.string().max(200).allow("", null),
  registrationNumber: Joi.string().min(2).max(100).required(),
  website: Joi.string().uri({ scheme: ["http", "https"] }).max(300).allow("", null),
  address: Joi.string().max(500).allow("", null),
  adminEmail: Joi.string().email().required(),
  adminPassword: Joi.string().min(8).max(128).required(),
});

const profileSchema = Joi.object({
  name: Joi.string().min(2).max(200),
  legalName: Joi.string().max(200).allow("", null),
  website: Joi.string().uri({ scheme: ["http", "https"] }).max(300).allow("", null),
  address: Joi.string().max(500).allow("", null),
}).min(1);

const statusSchema = Joi.object({
  status: Joi.string().valid("pending", "approved", "rejected", "suspended").required(),
  reason: Joi.string().max(1000).allow("", null),
});

const walletSchema = Joi.object({
  walletAddress: Joi.string().pattern(WALLET_RE).required(),
});

const walletPatchSchema = Joi.object({
  active: Joi.boolean(),
  authorizationTxHash: Joi.string().pattern(TX_HASH_RE).allow("", null),
}).min(1);

const userPatchSchema = Joi.object({
  active: Joi.boolean(),
  walletAddress: Joi.string().pattern(WALLET_RE).allow("", null),
  role: Joi.string().valid("institution_admin", "issuer", "auditor"),
}).min(1);

// ── POST /api/institutions/apply (public) ─────────────────
// Institution self-registration: creates a PENDING institution plus its
// first institution_admin account. Nothing can be issued until a platform
// admin approves the institution.
router.post("/apply", asyncHandler(async (req, res) => {
  const input = validate(applySchema, req.body);
  const adminEmail = input.adminEmail.toLowerCase();

  const { data: existingUser } = await supabase
    .from("users").select("id").eq("email", adminEmail).maybeSingle();
  if (existingUser) return res.status(409).json({ error: "Admin email already registered" });

  const { data: existingInst } = await supabase
    .from("institutions").select("id").eq("registration_number", input.registrationNumber).maybeSingle();
  if (existingInst) return res.status(409).json({ error: "An institution with this registration number already exists" });

  const institutionId = generateInstitutionId();
  const institutionIdHash = computeInstitutionIdentityHash(institutionId);

  const { data: institution, error: instError } = await supabase
    .from("institutions")
    .insert({
      institution_id: institutionId,
      institution_id_hash: institutionIdHash,
      name: input.name,
      legal_name: input.legalName || null,
      registration_number: input.registrationNumber,
      website: input.website || null,
      address: input.address || null,
      verification_status: "pending",
    })
    .select("*")
    .single();

  if (instError) {
    const status = isUniqueViolation(instError) ? 409 : 500;
    return res.status(status).json({ error: instError.message });
  }

  const { data: admin, error: userError } = await supabase
    .from("users")
    .insert({
      email: adminEmail,
      password_hash: await bcrypt.hash(input.adminPassword, BCRYPT_ROUNDS),
      role: "institution_admin",
      institution_id: institution.id,
      organization_name: input.name,
    })
    .select("*")
    .single();

  if (userError) {
    // Compensating cleanup of the institution row created moments ago.
    await supabase.from("institutions").delete().eq("id", institution.id);
    const status = isUniqueViolation(userError) ? 409 : 500;
    return res.status(status).json({ error: userError.message });
  }

  res.status(201).json({
    message: "Application submitted. A platform admin must approve the institution before issuance.",
    institution: institutionFromRow(institution),
    admin: userFromRow(admin),
  });
}));

// ── GET /api/institutions ─────────────────────────────────
// platform_admin: every institution (optional ?status= filter).
// Everyone else: only their own.
router.get("/", protect, loadCurrentUser, asyncHandler(async (req, res) => {
  if (req.userRole === "platform_admin") {
    let query = supabase.from("institutions").select("*").order("created_at", { ascending: false });
    const status = String(req.query.status ?? "");
    if (["pending", "approved", "rejected", "suspended"].includes(status)) {
      query = query.eq("verification_status", status);
    }
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ institutions: data.map(institutionFromRow) });
  }

  if (!req.userInstitution) return res.json({ institutions: [] });
  res.json({ institutions: [institutionFromRow(req.userInstitution)] });
}));

// ── GET /api/institutions/mine ────────────────────────────
router.get("/mine", protect, loadCurrentUser, attachOwnInstitution, (req, res) => {
  res.json({ institution: institutionFromRow(req.institution) });
});

// ── GET /api/institutions/:id ─────────────────────────────
router.get("/:id", protect, loadCurrentUser, requireInstitutionMember, asyncHandler(async (req, res) => {
  const [{ data: wallets }, { data: users }] = await Promise.all([
    supabase.from("issuer_wallets").select("*").eq("institution_id", req.institution.id).order("created_at"),
    supabase.from("users").select("*, institutions!institution_id(*)").eq("institution_id", req.institution.id).order("created_at"),
  ]);
  res.json({
    institution: institutionFromRow(req.institution),
    wallets: (wallets ?? []).map(issuerWalletFromRow),
    users: (users ?? []).map(userFromRow),
  });
}));

// ── PATCH /api/institutions/:id — profile edit ────────────
router.patch(
  "/:id",
  protect, loadCurrentUser, institutionAdminOnly, requireInstitutionMember,
  asyncHandler(async (req, res) => {
    const input = validate(profileSchema, req.body);
    const patch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.legalName !== undefined) patch.legal_name = input.legalName || null;
    if (input.website !== undefined) patch.website = input.website || null;
    if (input.address !== undefined) patch.address = input.address || null;

    const { data, error } = await supabase
      .from("institutions").update(patch).eq("id", req.institution.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ institution: institutionFromRow(data) });
  })
);

// ── PATCH /api/institutions/:id/status — platform decision ──
router.patch(
  "/:id/status",
  protect, loadCurrentUser, platformAdminOnly, requireInstitutionMember,
  asyncHandler(async (req, res) => {
    const { status, reason } = validate(statusSchema, req.body);
    const patch = {
      verification_status: status,
      status_reason: reason || null,
      approved_by: status === "approved" ? req.userId : null,
      approved_at: status === "approved" ? new Date().toISOString() : null,
    };
    const { data, error } = await supabase
      .from("institutions").update(patch).eq("id", req.institution.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ institution: institutionFromRow(data) });
  })
);

// ── GET /api/institutions/:id/wallets ─────────────────────
router.get("/:id/wallets", protect, loadCurrentUser, requireInstitutionMember, asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("issuer_wallets").select("*").eq("institution_id", req.institution.id).order("created_at");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ wallets: data.map(issuerWalletFromRow) });
}));

// ── POST /api/institutions/:id/wallets ────────────────────
// Registers a wallet as an issuer for this institution (DB association).
// The on-chain authorizeIssuer transaction is a separate platform-admin
// step (scripts/addIssuer.js); its receipt is recorded via PATCH below.
router.post(
  "/:id/wallets",
  protect, loadCurrentUser, institutionAdminOnly, requireInstitutionMember, requireApprovedInstitution,
  asyncHandler(async (req, res) => {
    const { walletAddress } = validate(walletSchema, req.body);
    const wallet = walletAddress.toLowerCase();

    const { data, error } = await supabase
      .from("issuer_wallets")
      .insert({
        institution_id: req.institution.id,
        wallet_address: wallet,
        authorized_by: req.userId,
      })
      .select("*")
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: "This wallet is already registered to an institution (one wallet, one institution)" });
      }
      return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
      message: "Wallet registered. On-chain authorization (authorizeIssuer) is still required before issuance.",
      wallet: issuerWalletFromRow(data),
    });
  })
);

// ── PATCH /api/institutions/:id/wallets/:walletId ─────────
router.patch(
  "/:id/wallets/:walletId",
  protect, loadCurrentUser, institutionAdminOnly, requireInstitutionMember,
  asyncHandler(async (req, res) => {
    const input = validate(walletPatchSchema, req.body);

    const { data: existing, error: findError } = await supabase
      .from("issuer_wallets").select("*")
      .eq("id", req.params.walletId).eq("institution_id", req.institution.id).maybeSingle();
    if (findError) return res.status(500).json({ error: findError.message });
    if (!existing) return res.status(404).json({ error: "Wallet not found in this institution" });

    const patch = {};
    if (input.active !== undefined) patch.active = input.active;
    if (input.authorizationTxHash !== undefined) patch.authorization_tx_hash = input.authorizationTxHash || null;

    const { data, error } = await supabase
      .from("issuer_wallets").update(patch).eq("id", existing.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ wallet: issuerWalletFromRow(data) });
  })
);

// ── GET /api/institutions/:id/users ───────────────────────
router.get(
  "/:id/users",
  protect, loadCurrentUser, institutionAdminOnly, requireInstitutionMember,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from("users").select("*, institutions!institution_id(*)").eq("institution_id", req.institution.id).order("created_at");
    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: data.map(userFromRow) });
  })
);

// ── PATCH /api/institutions/:id/users/:userId ─────────────
// institution_admin: activate/deactivate + set wallets for their own staff.
// Role changes are platform-admin-only and stay inside institution roles.
router.patch(
  "/:id/users/:userId",
  protect, loadCurrentUser, institutionAdminOnly, requireInstitutionMember,
  asyncHandler(async (req, res) => {
    const input = validate(userPatchSchema, req.body);

    const { data: target, error: findError } = await supabase
      .from("users").select("*")
      .eq("id", req.params.userId).eq("institution_id", req.institution.id).maybeSingle();
    if (findError) return res.status(500).json({ error: findError.message });
    if (!target) return res.status(404).json({ error: "User not found in this institution" });

    if (input.role !== undefined && req.userRole !== "platform_admin") {
      return res.status(403).json({ error: "Only platform admins can change roles" });
    }
    if (target.id === req.userId && input.active === false) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }

    const patch = {};
    if (input.active !== undefined) patch.active = input.active;
    if (input.walletAddress !== undefined) patch.wallet_address = input.walletAddress ? input.walletAddress.toLowerCase() : null;
    if (input.role !== undefined) patch.role = input.role;

    const { data, error } = await supabase
      .from("users").update(patch).eq("id", target.id).select("*, institutions!institution_id(*)").single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ user: userFromRow(data) });
  })
);

export default router;