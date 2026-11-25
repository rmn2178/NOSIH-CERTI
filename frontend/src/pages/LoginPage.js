import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ScanSearch } from "lucide-react";
import { login, applyInstitution, apiErrorMessage } from "../utils/api";
import logo from "../assets/nosih-logo.png";
import "./styles.css";

/**
 * Sign-in for staff, plus the PUBLIC institution application form.
 * Applying creates a pending institution and its first institution_admin —
 * nothing can be issued until a platform admin approves it.
 */
export default function LoginPage() {
  const [mode, setMode] = useState("login"); // login | apply
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState(null);
  const [app, setApp] = useState({
    name: "", legalName: "", registrationNumber: "", website: "", address: "",
    adminEmail: "", adminPassword: "",
  });
  const navigate = useNavigate();

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await login(email, password);
      sessionStorage.setItem("token", res.data.token);
      sessionStorage.setItem("user", JSON.stringify(res.data.user));
      navigate("/");
    } catch (err) {
      setError(apiErrorMessage(err, "Login failed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleApply(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const payload = { ...app, website: app.website || undefined };
      const res = await applyInstitution(payload);
      setApplied(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Application failed"));
    } finally {
      setLoading(false);
    }
  }

  const setField = (key) => (e) => setApp((s) => ({ ...s, [key]: e.target.value }));

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <div className="auth-logo">
          <img src={logo} alt="NOSIH logo" className="logo-img" />
          <h1>NOSIH</h1>
          <p>Decentralized Certificate Authentication</p>
        </div>

        {applied ? (
          <div>
            <div className="alert alert-success">
              Application submitted for <strong>{applied.institution?.name}</strong>
              {" "}(<span className="mono">{applied.institution?.institutionId}</span>).
              A platform admin must approve the institution before certificates can be issued.
              Sign in with the admin account you just created once it is approved.
            </div>
            <button type="button" className="btn btn-primary full-width" onClick={() => { setApplied(null); setMode("login"); }}>
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
              <button type="button" role="tab" aria-selected={mode === "login"} className={`auth-tab ${mode === "login" ? "active" : ""}`} onClick={() => { setMode("login"); setError(""); }}>
                Sign in
              </button>
              <button type="button" role="tab" aria-selected={mode === "apply"} className={`auth-tab ${mode === "apply" ? "active" : ""}`} onClick={() => { setMode("apply"); setError(""); }}>
                Register institution
              </button>
            </div>

            {mode === "login" ? (
              <form onSubmit={handleLogin}>
                <div className="field">
                  <label>Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@institution.edu" autoComplete="username" />
                </div>
                <div className="field">
                  <label>Password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" autoComplete="current-password" />
                </div>
                {error && <div className="alert alert-error">{error}</div>}
                <button type="submit" className="btn btn-primary full-width" disabled={loading}>
                  {loading ? "Signing in…" : "Sign in"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleApply}>
                <p className="auth-group">Institution</p>
                <div className="field">
                  <label>Institution name</label>
                  <input value={app.name} onChange={setField("name")} required minLength={2} maxLength={200} placeholder="National Institute of Technology" />
                </div>
                <div className="field">
                  <label>Registration number</label>
                  <input value={app.registrationNumber} onChange={setField("registrationNumber")} required minLength={2} maxLength={100} placeholder="Official registration / charter number" />
                </div>
                <div className="field">
                  <label>Website (optional)</label>
                  <input type="url" value={app.website} onChange={setField("website")} placeholder="https://…" />
                </div>
                <div className="field">
                  <label>Address (optional)</label>
                  <input value={app.address} onChange={setField("address")} maxLength={500} placeholder="City, state / country" />
                </div>
                <p className="auth-group">Admin account</p>
                <div className="field">
                  <label>Admin email</label>
                  <input type="email" value={app.adminEmail} onChange={setField("adminEmail")} required placeholder="admin@institution.edu" autoComplete="email" />
                </div>
                <div className="field">
                  <label>Admin password</label>
                  <input type="password" value={app.adminPassword} onChange={setField("adminPassword")} required minLength={8} maxLength={128} autoComplete="new-password" placeholder="At least 8 characters" />
                </div>
                {error && <div className="alert alert-error">{error}</div>}
                <button type="submit" className="btn btn-primary full-width" disabled={loading}>
                  {loading ? "Submitting…" : "Submit application"}
                </button>
                <p className="auth-note">
                  Applications are reviewed by the platform. Issuance stays disabled until approval.
                </p>
              </form>
            )}
          </>
        )}

        <div className="auth-links">
          <Link to="/verify"><ScanSearch size={15} strokeWidth={1.75} aria-hidden /> Public verification portal</Link>
        </div>
      </div>
    </div>
  );
}