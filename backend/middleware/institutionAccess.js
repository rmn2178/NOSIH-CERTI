import "../env.js"; // loads the repository-root .env — must come first
import { supabase } from "../supabase.js";
import { normalizeRole } from "./auth.js";

/**
 * Institution scoping — the single source of truth for "who may touch which
 * institution's data". The client-supplied institution id is NEVER trusted:
 * membership comes from the freshly loaded users row, not from the request
 * body or the (possibly stale) JWT claim.
 */

/**
 * Loads the current user + their institution from the database on every
 * request. Deactivated accounts and role changes take effect immediately,
 * without waiting for the 8h JWT to expire.
 */
export async function loadCurrentUser(req, res, next) {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*, institutions!institution_id(*)")
      .eq("id", req.userId)
      .eq("active", true)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!user) return res.status(401).json({ error: "Account not found or deactivated" });

    req.currentUser = user;
    req.userRole = normalizeRole(user.role); // authoritative over the JWT claim
    req.userInstitutionId = user.institution_id ?? null;
    req.userInstitution = user.institutions ?? null;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Resolves the :id route param (uuid OR INST-XXXXXXXX) to an institution and
 * enforces access: platform admins see everything; everyone else only their
 * own institution. Attaches req.institution (raw row).
 */
export async function requireInstitutionMember(req, res, next) {
  try {
    const key = String(req.params.id ?? "");
    const column = key.startsWith("INST-") ? "institution_id" : "id";
    if (column === "id" && !/^[0-9a-f-]{36}$/i.test(key)) {
      return res.status(400).json({ error: "Invalid institution id" });
    }

    const { data: institution, error } = await supabase
      .from("institutions")
      .select("*")
      .eq(column, key)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!institution) return res.status(404).json({ error: "Institution not found" });

    const isPlatformAdmin = req.userRole === "platform_admin";
    const isMember = req.userInstitutionId && req.userInstitutionId === institution.id;
    if (!isPlatformAdmin && !isMember) {
      return res.status(403).json({ error: "Access denied: this institution is not yours" });
    }

    req.institution = institution;
    next();
  } catch (err) {
    next(err);
  }
}

/** Gate for issuance-class operations: the institution must be approved. */
export function requireApprovedInstitution(req, res, next) {
  const institution = req.institution ?? req.userInstitution;
  if (!institution) {
    return res.status(403).json({ error: "No institution associated with this account" });
  }
  if (institution.verification_status !== "approved") {
    return res.status(403).json({
      error: `Institution is not approved (status: ${institution.verification_status}). Issuance requires platform approval.`,
    });
  }
  next();
}

/** Attaches the caller's OWN institution (for /mine-style routes). */
export function attachOwnInstitution(req, res, next) {
  if (!req.userInstitution) {
    return res.status(404).json({ error: "No institution associated with this account" });
  }
  req.institution = req.userInstitution;
  next();
}