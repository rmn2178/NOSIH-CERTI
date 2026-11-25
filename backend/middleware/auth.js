import "../env.js"; // loads the repository-root .env — must come first
import jwt from "jsonwebtoken";

// JWT_SECRET is audited by envCheck.js. The server keeps running when it is
// missing and answers with a readable error, instead of exiting at import
// time — which on Vercel shows up as FUNCTION_INVOCATION_FAILED on every
// route with no hint about the cause.

/** Legacy NOSIH 'admin' tokens keep working as platform admins. */
export function normalizeRole(role) {
  return role === "admin" ? "platform_admin" : role;
}

export const PLATFORM_ROLES = ["platform_admin"];
export const INSTITUTION_ROLES = ["platform_admin", "institution_admin", "issuer", "auditor"];

export function protect(req, res, next) {
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: JWT_SECRET is not set" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    req.userRole = normalizeRole(decoded.role);
    req.userInstitutionId = decoded.institutionId ?? null;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Role gate. Usage: requireRoles("platform_admin", "institution_admin") */
export function requireRoles(...roles) {
  const allowed = roles.map(normalizeRole);
  return (req, res, next) => {
    if (!allowed.includes(req.userRole)) {
      return res.status(403).json({ error: "Insufficient permissions for this operation" });
    }
    next();
  };
}

export const platformAdminOnly = requireRoles("platform_admin");

/** Platform admin OR institution admin (institution scoping is separate). */
export const institutionAdminOnly = requireRoles("platform_admin", "institution_admin");

/** Back-compat alias used by legacy routes until they are retired. */
export const adminOnly = platformAdminOnly;