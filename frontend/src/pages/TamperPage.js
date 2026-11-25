import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  FileSearch, ShieldCheck, ShieldX, ShieldAlert, ArrowLeft, ScanSearch,
} from "lucide-react";
import CertificateUpload from "../components/CertificateUpload";
import { tamperCheckPublic, apiErrorMessage } from "../utils/api";
import { shortHex, formatDateTime } from "../utils/certificateHelpers";
import logo from "../assets/nosih-logo.png";
import "./styles.css";

const CERT_RE = /^CERT-[0-9A-F]{8}$/i;
const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true };

/** Verdict → presentation. Keys match the backend tamper verdicts exactly. */
const STYLE = {
  intact: { cls: "status-valid", Icon: ShieldCheck, text: "The stored document decrypts, authenticates and matches the chain fingerprint byte-for-byte." },
  "exact-match": { cls: "status-valid", Icon: ShieldCheck, text: "The uploaded PDF is byte-for-byte the document registered on-chain." },
  "stored-document-mismatch": { cls: "status-invalid", Icon: ShieldX, text: "The stored document does NOT match the chain fingerprint. Treat the stored copy as compromised." },
  modified: { cls: "status-invalid", Icon: ShieldX, text: "The uploaded PDF does NOT match the registered document. It has been modified or was never registered." },
  "registered-under-different-id": { cls: "status-invalid", Icon: ShieldAlert, text: "This exact document IS registered — but under a different certificate ID. The ID you entered does not own this document." },
  revoked: { cls: "status-revoked", Icon: ShieldX, text: "The document matches the registered hash, but the certificate has been REVOKED. Do not accept it." },
  expired: { cls: "status-warning", Icon: ShieldAlert, text: "The document matches, but the certificate has expired." },
  superseded: { cls: "status-warning", Icon: ShieldAlert, text: "The document matches, but this certificate was superseded by a newer one." },
  "not-found": { cls: "status-invalid", Icon: ShieldAlert, text: "This certificate ID is not registered on-chain." },
};

/**
 * PUBLIC document-integrity check.
 * Mode A (no file): stored ciphertext → decrypt → rehash vs chain.
 * Mode B (uploaded PDF): SHA-256 of the exact bytes vs the CHAIN hash.
 * No AI is involved in integrity checking.
 */
export default function TamperPage() {
  const [searchParams] = useSearchParams();
  const [input, setInput] = useState(searchParams.get("certificateId") || "");
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const id = input.trim().toUpperCase();
    if (!CERT_RE.test(id)) {
      setError("Enter a certificate ID in the form CERT-XXXXXXXX.");
      setResult(null);
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      let form;
      if (file) {
        form = new FormData();
        form.append("document", file);
      }
      const res = await tamperCheckPublic(id, form);
      setResult(res.data);
    } catch (err) {
      const payload = err.response?.data;
      if (payload?.verdict) setResult(payload);
      else setError(apiErrorMessage(err, "Integrity check failed"));
    } finally {
      setBusy(false);
    }
  }

  const style = result ? (STYLE[result.verdict] || STYLE["not-found"]) : null;

  return (
    <div className="verify-wrapper">
      <header className="verify-header">
        <img src={logo} alt="NOSIH logo" className="logo-img" />
        <h1>Document Integrity Check</h1>
        <p>Prove a PDF is the exact registered document — hashes only, no AI.</p>
      </header>

      <div className="verify-card">
        <form onSubmit={submit}>
          <div className="input-row">
            <input
              className="verify-input mono"
              placeholder="CERT-XXXXXXXX"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Certificate ID"
              maxLength={13}
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <FileSearch {...ICON} /> {busy ? "Checking…" : file ? "Compare uploaded PDF" : "Check stored document"}
            </button>
          </div>

          <div className="tamper-upload">
            <CertificateUpload
              file={file}
              onFile={setFile}
              disabled={busy}
              hint="Optional — upload the PDF you received to compare it against the chain fingerprint (Mode B). Without a file, the stored encrypted original is checked (Mode A)."
            />
          </div>
        </form>

        {error && <div className="alert alert-error">{error}</div>}

        {result && style && (
          <div className="verify-result">
            <div className={`status-banner ${style.cls}`}>
              <style.Icon size={26} strokeWidth={1.75} aria-hidden />
              <div>
                <strong>{result.verdictLabel || result.label || result.verdict}</strong>
                <small className="mono">{result.certificateId}</small>
              </div>
            </div>
            <p className="tamper-explain">{style.text}</p>

            {result.registeredCertificateId && (
              <div className="alert alert-warning">
                The document belongs to <Link className="mono" to={`/verify?certificateId=${result.registeredCertificateId}`}>{result.registeredCertificateId}</Link>.
              </div>
            )}
            {result.supersededByCertificateId && (
              <div className="alert alert-warning">
                Replaced by <Link className="mono" to={`/verify?certificateId=${result.supersededByCertificateId}`}>{result.supersededByCertificateId}</Link>.
              </div>
            )}

            {(result.uploadedHash || result.chainDocumentHash) && (
              <div className="hash-comparison">
                {result.uploadedHash && (
                  <div className="hash-row">
                    <span className="hash-label">Uploaded PDF SHA-256</span>
                    <span className={`hash-val mono ${result.match === true ? "match" : result.match === false ? "mismatch" : ""}`} title={result.uploadedHash}>
                      {shortHex(result.uploadedHash, 24, 12)}
                    </span>
                  </div>
                )}
                {result.chainDocumentHash && (
                  <div className="hash-row">
                    <span className="hash-label">Chain-registered SHA-256</span>
                    <span className="hash-val original mono" title={result.chainDocumentHash}>
                      {shortHex(result.chainDocumentHash, 24, 12)}
                    </span>
                  </div>
                )}
                {result.match === true && <div className="hash-match-indicator">Hashes match exactly</div>}
                {result.match === false && result.chainDocumentHash && <div className="hash-match-indicator mismatch">Hashes differ</div>}
              </div>
            )}

            {result.mode === "stored-document" && result.documentSource && (
              <p className="muted">
                Source: {String(result.documentSource).includes("/ipfs/") || String(result.documentSource).startsWith("http") ? "IPFS (encrypted mirror)" : "private storage cache"} —
                contents were decrypted server-side for hashing only and are never exposed by this check.
              </p>
            )}
            {result.revoked && result.verdict !== "revoked" && (
              <div className="revoked-section">Note: this certificate is revoked on-chain.</div>
            )}
            <p className="verify-disclaimer">
              {result.disclaimer} {result.verifiedAt && <>Checked {formatDateTime(result.verifiedAt)}.</>}
            </p>
          </div>
        )}

        <div className="verify-actions">
          <Link className="btn btn-secondary" to={input ? `/verify?certificateId=${input.trim().toUpperCase()}` : "/verify"}>
            <ScanSearch {...ICON} /> Full verification
          </Link>
        </div>
      </div>

      <footer className="verify-footer">
        <Link to="/verify"><ArrowLeft {...ICON} /> Back to verification</Link>
        <span>NOSIH · integrity is proven with hashes, never with AI</span>
      </footer>
    </div>
  );
}