import "../env.js"; // loads the repository-root .env — must come first
import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import Joi from "joi";
import { supabase, userFromRow, isUniqueViolation } from "../supabase.js";
import { protect, requireRoles, normalizeRole } from "../middleware/auth.js";
import { loadCurrentUser } from "../middleware/institutionAccess.js";
import { asyncHandler } from "../middleware/errorHandler.js";

const router = Router();
const BCRYPT_ROUNDS = 12;

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(128).required(),
  role: Joi.string().valid("platform_admin", "institution_admin", "issuer", "auditor").required(),
  institutionId: Joi.string().allow("", null), // uuid or INST-XXXXXXXX
  walletAddress: Joi.string().pattern(WALLET_RE).allow("", null),
  organizationName: Joi.string().max(200).allow("", null),
});

const walletSchema = Joi.object({
  walletAddress: Joi.string().pattern(WALLET_RE).required(),
});

function validate(schema, body) {
  const { error, value } = schema.validate(body ?? {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    const err = new Error(error.details.map((d) => d.message).join("; "));
    err.status = 400;
    throw err;
  }
  return value;
}

// POST /api/auth/login
router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = validate(loginSchema, req.body);

  const { data: user, error } = await supabase
    .from("users")
    .select("*, institutions!institution_id(*)")
    .eq("email", String(email).toLowerCase())
    .eq("active", true)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: "Invalid credentials" });

  const role = normalizeRole(user.role);
  const token = jwt.sign(
    { id: user.id, role, email: user.email, institutionId: user.institution_id ?? null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );

  res.json({ token, user: userFromRow(user) });
}));

// POST /api/auth/register
// platform_admin: creates any role; non-platform roles require an institution.
// institution_admin: creates issuer/auditor accounts inside their OWN institution.
router.post(
  "/register",
  protect,
  loadCurrentUser,
  requireRoles("platform_admin", "institution_admin"),
  asyncHandler(async (req, res) => {
    const input = validate(registerSchema, req.body);
    const isPlatformAdmin = req.userRole === "platform_admin";

    let role = input.role;
    let institutionUuid = null;

    if (!isPlatformAdmin) {
      if (!["issuer", "auditor"].includes(role)) {
        return res.status(403).json({ error: "Institution admins can only create issuer or auditor accounts" });
      }
      if (!req.userInstitutionId) {
        return res.status(403).json({ error: "Your account has no institution" });
      }
      institutionUuid = req.userInstitutionId; // never trust a client-supplied id here
    } else if (role !== "platform_admin") {
      if (!input.institutionId) {
        return res.status(400).json({ error: "institutionId is required for non-platform roles" });
      }
      const column = input.institutionId.startsWith("INST-") ? "institution_id" : "id";
      const { data: institution, error } = await supabase
        .from("institutions")
        .select("id")
        .eq(column, input.institutionId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!institution) return res.status(404).json({ error: "Institution not found" });
      institutionUuid = institution.id;
    }

    const normalizedEmail = String(input.email).toLowerCase();
    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email: normalizedEmail,
        password_hash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        wallet_address: input.walletAddress ? input.walletAddress.toLowerCase() : null,
        organization_name: input.organizationName || null,
        role,
        institution_id: institutionUuid,
      })
      .select("id")
      .single();

    if (error) {
      const status = isUniqueViolation(error) ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }

    res.status(201).json({ message: "Account created", userId: user.id, role, institutionId: institutionUuid });
  })
);

// GET /api/auth/me — fresh from the database (role/institution changes apply immediately)
router.get("/me", protect, loadCurrentUser, (req, res) => {
  res.json(userFromRow(req.currentUser));
});

// PATCH /api/auth/me/wallet — issuers/admins set their own MetaMask address.
// The issuer_wallets binding + on-chain authorization remain admin-controlled.
router.patch(
  "/me/wallet",
  protect,
  loadCurrentUser,
  requireRoles("institution_admin", "issuer"),
  asyncHandler(async (req, res) => {
    const { walletAddress } = validate(walletSchema, req.body);
    const { error } = await supabase
      .from("users")
      .update({ wallet_address: walletAddress.toLowerCase() })
      .eq("id", req.userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: "Wallet address updated", walletAddress: walletAddress.toLowerCase() });
  })
);

export default router;