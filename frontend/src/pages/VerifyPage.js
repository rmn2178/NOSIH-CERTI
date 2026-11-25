import React, { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ScanSearch, FileSearch, ArrowRight } from "lucide-react";
import VerificationResult from "../components/VerificationResult";
import { verifyCertificatePublic, apiErrorMessage } from "../utils/api";
import logo from "../assets/nosih-logo.png";
import "./styles.css";

const CERT_RE = /^CERT-[0-9A-F]{8}$/i;

/**
 * PUBLIC verification — no account needed. Chain-authoritative: a database
 * row alone can never produce an authentic verdict, and a chain outage is
 * shown as INDETERMINATE (503), never as success.
 */
export default function VerifyPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [input, setInput] = useState(searchParams.get("certificateId") || "");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const runVerify = useCallback(async (rawId) => {
    const id = String(rawId || "").trim().toUpperCase();
    if (!CERT_RE.test(id)) {
      setError("Enter a certificate ID in the form CERT-XXXXXXXX (printed under the QR code).");
      setResult(null);
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await verifyCertificatePublic(id);
      setResult(res.data);
    } catch (err) {
      // 404 / 503 still carry a full verdict payload — render it, not a crash.
      const payload = err.response?.data;
      if (payload?.verdict) setResult(payload);
      else setError(apiErrorMessage(err, "Verification failed"));
    } finally {
      setBusy(false);
    }
  }, []);

  // QR codes open /verify?certificateId=CERT-XXXXXXXX — verify immediately.
  useEffect(() => {
    const id = searchParams.get("certificateId");
    if (id) runVerify(id);
  }, []);

  function submit(e) {
    e.preventDefault();
    const id = input.trim().toUpperCase();
    setSearchParams(id ? { certificateId: id } : {});
    runVerify(id);
  }

  function verifyAnother(id) {
    setInput(id);
    setSearchParams({ certificateId: id });
    runVerify(id);
  }

  return (
    <div className="verify-wrapper">
      <header className="verify-header">
        <img src={logo} alt="NOSIH logo" className="logo-img" />
        <h1>NOSIH Verification</h1>
        <p>Check any certificate against the blockchain record — no account required.</p>
      </header>

      <div className="verify-card">
        <form onSubmit={submit} className="input-row">
          <input
            className="verify-input mono"
            placeholder="CERT-XXXXXXXX"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Certificate ID"
            maxLength={13}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <ScanSearch size={16} strokeWidth={1.75} aria-hidden /> {busy ? "Checking chain…" : "Verify"}
          </button>
        </form>
        <p className="verify-hint">
          The ID is printed under the QR code on the certificate. Scanning the QR opens this
          page with the check already running.
        </p>

        {error && <div className="alert alert-error">{error}</div>}
        <VerificationResult payload={result} onVerifyAnother={verifyAnother} />

        {result && (
          <div className="verify-actions">
            <Link className="btn btn-secondary" to={`/tamper?certificateId=${result.certificateId}`}>
              <FileSearch size={16} strokeWidth={1.75} aria-hidden /> Check document integrity
            </Link>
          </div>
        )}
      </div>

      <footer className="verify-footer">
        <Link to="/login">Institution sign in <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></Link>
        <span>NOSIH · hashes on Polygon Amoy · documents encrypted on IPFS</span>
      </footer>
    </div>
  );
}