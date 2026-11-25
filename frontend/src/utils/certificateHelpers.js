/**
 * Shared certificate presentation helpers — labels, badges, formatting.
 * Field keys match the backend contract (certificateTemplates.js /
 * certificateFromRow) exactly; nothing here invents data.
 */

export const FIELD_LABELS = {
  certificateType: "Certificate type",
  certificateNumber: "Certificate number",
  holderName: "Holder name",
  holderIdentifier: "Holder identifier (roll / reg. no.)",
  institutionName: "Institution name",
  institutionAddress: "Institution address",
  courseName: "Course / programme",
  qualification: "Qualification",
  qualificationLevel: "Qualification level",
  specialization: "Specialization",
  grade: "Grade / class",
  percentage: "Percentage",
  issueDate: "Issue date",
  expiryDate: "Expiry date",
  academicYear: "Academic year",
  signatoryName: "Signatory name",
  signatoryDesignation: "Signatory designation",
};

export const TYPE_LABELS = {
  undergraduate_degree: "Undergraduate degree",
  postgraduate_degree: "Postgraduate degree",
  diploma: "Diploma",
  transcript: "Academic transcript",
  professional_training: "Professional training",
  technical_certification: "Technical certification",
  course_completion: "Course completion",
  internship: "Internship",
  achievement: "Achievement / award",
  other: "Other certificate",
};

export const STATUS_LABELS = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  superseded: "Superseded",
};

export const STATUS_BADGE = {
  active: "badge badge-active",
  revoked: "badge badge-revoked",
  expired: "badge badge-warning",
  superseded: "badge badge-neutral",
};

export const INSTITUTION_STATUS_LABELS = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  suspended: "Suspended",
};

export const INSTITUTION_STATUS_BADGE = {
  pending: "badge badge-warning",
  approved: "badge badge-active",
  rejected: "badge badge-revoked",
  suspended: "badge badge-revoked",
};

export const ROLE_LABELS = {
  platform_admin: "Platform admin",
  institution_admin: "Institution admin",
  issuer: "Issuer",
  auditor: "Auditor",
  admin: "Platform admin", // legacy rows normalize server-side too
};

export function typeLabel(type) {
  return TYPE_LABELS[type] || type || "—";
}

export function statusBadgeClass(status) {
  return STATUS_BADGE[status] || "badge badge-neutral";
}

/** YYYY-MM-DD → readable date; anything else passes through or dashes. */
export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** 0x1234…abcd for wallets and hashes (full value stays in title/copy). */
export function shortHex(value, lead = 10, tail = 6) {
  const s = String(value || "");
  if (s.length <= lead + tail + 1) return s || "—";
  return `${s.slice(0, lead)}…${s.slice(-tail)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Confidence 0..1 → { label, className } for the review-form badges. */
export function confidenceInfo(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (v >= 0.85) return { label: `${Math.round(v * 100)}%`, className: "confidence-high" };
  if (v >= 0.5) return { label: `${Math.round(v * 100)}%`, className: "confidence-medium" };
  return { label: `${Math.round(v * 100)}%`, className: "confidence-low" };
}

/** camelCase extra-field key → "Camel case" label. */
export function extraFieldLabel(key) {
  const spaced = String(key).replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Can this role revoke? (D2 — owning-institution check happens server-side.) */
export function canRevoke(user, certificate) {
  if (!user || !certificate) return false;
  if (certificate.status === "revoked" || certificate.status === "superseded") return false;
  if (user.role === "platform_admin") return true;
  return user.role === "institution_admin" && user.institutionId === certificate.institutionId;
}

/** Can this role start a reissue? (Backend: issuer / institution_admin only.) */
export function canReissue(user, certificate) {
  if (!user || !certificate) return false;
  if (!["issuer", "institution_admin"].includes(user.role)) return false;
  if (certificate.status === "revoked" || certificate.supersededByCertificateId) return false;
  return user.institutionId === certificate.institutionId;
}