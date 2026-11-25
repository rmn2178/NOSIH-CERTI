import axios from "axios";

/**
 * NOSIH API client.
 *
 * Authenticated calls carry the sessionStorage JWT; the public verification
 * endpoints work without one. Every error that reaches the UI must go through
 * apiErrorMessage (or blobErrorMessage for blob responses) — platform-level
 * failures answer `{ error: { code, message } }`, and rendering that object
 * directly crashes React (#31) into a blank page.
 */
const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || "/api",
  timeout: 60000,
});

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 globally — redirect to login. The login call itself is excluded:
// a wrong password must surface inline, not bounce the page (wiping the error).
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const isLoginAttempt = (err.config?.url || "").includes("/auth/login");
    if (err.response?.status === 401 && !isLoginAttempt) {
      sessionStorage.removeItem("token");
      sessionStorage.removeItem("user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default api;

/** Turns any API error into a string that is safe to render. */
export function apiErrorMessage(err, fallback = "Something went wrong") {
  const asText = (value) => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      if (typeof value.message === "string") return value.message.trim();
      if (typeof value.code === "string") return value.code.trim();
    }
    return "";
  };

  const data = err?.response?.data;
  const fromBody = asText(data?.error) || asText(data?.message);
  if (fromBody) return fromBody;
  if (typeof data === "string" && data.trim()) return data.trim();
  const fromError = asText(err);
  if (fromError) return fromError;
  return fallback;
}

/**
 * Same guarantee for responseType:"blob" calls — the error body arrives as a
 * Blob, so it must be read and parsed before it can be shown.
 */
export async function blobErrorMessage(err, fallback = "Something went wrong") {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      return apiErrorMessage({ response: { data: parsed } }, fallback);
    } catch {
      return fallback;
    }
  }
  return apiErrorMessage(err, fallback);
}

/** The signed-in user cached at login (fresh copy comes from /auth/me). */
export function sessionUser() {
  try {
    return JSON.parse(sessionStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

const multipart = { headers: { "Content-Type": "multipart/form-data" } };

// ── Auth ─────────────────────────────────────────────────
export const login = (email, password) => api.post("/auth/login", { email, password });
export const fetchMe = () => api.get("/auth/me");
export const registerUser = (payload) => api.post("/auth/register", payload);
export const updateMyWallet = (walletAddress) => api.patch("/auth/me/wallet", { walletAddress });

// ── Institutions ─────────────────────────────────────────
export const applyInstitution = (payload) => api.post("/institutions/apply", payload);
export const listInstitutions = (params) => api.get("/institutions", { params });
export const getMyInstitution = () => api.get("/institutions/mine");
export const getInstitution = (id) => api.get(`/institutions/${id}`);
export const updateInstitutionProfile = (id, payload) => api.patch(`/institutions/${id}`, payload);
export const setInstitutionStatus = (id, status, reason) =>
  api.patch(`/institutions/${id}/status`, { status, reason });
export const listIssuerWallets = (id) => api.get(`/institutions/${id}/wallets`);
export const addIssuerWallet = (id, walletAddress) =>
  api.post(`/institutions/${id}/wallets`, { walletAddress });
export const patchIssuerWallet = (id, walletId, payload) =>
  api.patch(`/institutions/${id}/wallets/${walletId}`, payload);
export const listInstitutionUsers = (id) => api.get(`/institutions/${id}/users`);
export const patchInstitutionUser = (id, userId, payload) =>
  api.patch(`/institutions/${id}/users/${userId}`, payload);

// ── Certificates (institution-scoped) ────────────────────
/** AI suggestions from the PDF — never proof; human review is mandatory. */
export const extractCertificate = (formData) =>
  api.post("/certificates/extract", formData, { ...multipart, timeout: 180000 });

/** Field contract for the review form (17 base fields + per-type templates). */
export const fetchTemplates = () => api.get("/certificates/meta/templates");

/**
 * PREPARE: encrypt → IPFS → intent. Returns the exact MetaMask call.
 * formData: document (PDF), metadata (JSON string), supersedesCertificateId?
 */
export const prepareIssuance = (formData) =>
  api.post("/certificates/issue/prepare", formData, { ...multipart, timeout: 180000 });

/** CONFIRM: the backend independently verifies the receipt before persisting. */
export const confirmIssuance = (certificateId, txHash) =>
  api.post("/certificates/issue/confirm", { certificateId, txHash }, { timeout: 120000 });

/** Handshake status / recovery for an in-flight issuance. */
export const fetchIntent = (certificateId) =>
  api.get(`/certificates/issue/intents/${certificateId}`);

export const listCertificates = (params) => api.get("/certificates", { params });
export const getCertificate = (certificateId) => api.get(`/certificates/${certificateId}`);

/** Decrypted PDF as a Blob (auth required — no plain link). */
export const fetchCertificateDocument = (certificateId) =>
  api.get(`/certificates/${certificateId}/document`, { responseType: "blob", timeout: 120000 });

export const revokeCertificate = (certificateId, reason) =>
  api.post(`/certificates/${certificateId}/revoke`, { reason }, { timeout: 120000 });

/** Reissuance prefill — the actual issuance goes through prepare again. */
export const startReissue = (certificateId) =>
  api.post(`/certificates/${certificateId}/reissue`, {}, { timeout: 60000 });

// ── Public verification (no auth) ────────────────────────
// Non-2xx answers (404 not-found, 503 indeterminate) still carry a JSON
// verdict payload — pages read err.response.data, not just the message.
export const verifyCertificatePublic = (certificateId) =>
  api.get(`/verify/${certificateId}`);

/** Mode A: no file (stored-document integrity). Mode B: formData.document. */
export const tamperCheckPublic = (certificateId, formData) =>
  api.post(`/verify/${certificateId}/tamper-check`, formData, {
    ...(formData ? multipart : {}),
    timeout: 120000,
  });

/** Public QR PNG URL — a phone camera opens the verify page directly. */
export const certificateQrUrl = (certificateId, download = false) =>
  `${api.defaults.baseURL}/verify/${certificateId}/qr${download ? "?download=1" : ""}`;

/** Fetches the QR PNG and saves it (navigations bypass the dev proxy). */
export async function downloadCertificateQr(certificateId) {
  const res = await api.get(`/verify/${certificateId}/qr`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${certificateId}-QR.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}