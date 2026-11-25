import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, FileUp, Sparkles, PenLine, ShieldCheck, ExternalLink, AlertTriangle,
} from "lucide-react";
import Layout from "../components/Layout";
import CertificateUpload from "../components/CertificateUpload";
import CertificatePreview from "../components/CertificatePreview";
import WalletConnect from "../components/WalletConnect";
import TransactionStatus from "../components/TransactionStatus";
import QRDisplay from "../components/QRDisplay";
import {
  extractCertificate, fetchTemplates, prepareIssuance, confirmIssuance, startReissue,
  apiErrorMessage, sessionUser,
} from "../utils/api";
import { issueCertificate, explorerTxUrl } from "../services/contract";
import { classifyWalletError } from "../services/wallet";
import {
  FIELD_LABELS, TYPE_LABELS, confidenceInfo, extraFieldLabel, formatDateTime,
} from "../utils/certificateHelpers";

const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true };

const EMPTY_FIELDS = {
  certificateType: "other", certificateNumber: "", holderName: "", holderIdentifier: "",
  institutionName: "", institutionAddress: "", courseName: "", qualification: "",
  qualificationLevel: "", specialization: "", grade: "", percentage: "",
  issueDate: "", expiryDate: "", academicYear: "", signatoryName: "", signatoryDesignation: "",
};

const DATE_FIELDS = new Set(["issueDate", "expiryDate"]);
const REQUIRED_FIELDS = new Set(["certificateType", "holderName"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Issuance flow (brief §9): upload → extract → HUMAN REVIEW → prepare →
 * MetaMask sign → independent backend confirmation → receipt.
 *
 * The server never signs. A certificate row exists only after the backend
 * has verified the on-chain receipt against the prepared intent.
 */
export default function IssuePage() {
  const user = sessionUser() || {};
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const [phase, setPhase] = useState("upload");
  const [file, setFile] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [fields, setFields] = useState({
    ...EMPTY_FIELDS,
    institutionName: user.institution?.name || "",
    institutionAddress: user.institution?.address || "",
  });
  const [extraData, setExtraData] = useState({});
  const [ai, setAi] = useState(null); // {confidence, evidence, inferredFields, strategy, disclaimer}
  const [reissue, setReissue] = useState(null); // startReissue response
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [prepare, setPrepare] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const [certificate, setCertificate] = useState(null);
  const [confirmError, setConfirmError] = useState("");
  const signerRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Field contract + optional reissue prefill.
  useEffect(() => {
    fetchTemplates()
      .then((res) => setTemplates(res.data))
      .catch((err) => setError(apiErrorMessage(err, "Could not load the field contract")));

    const prefill = location.state?.reissue;
    const reissueId = prefill?.supersedesCertificateId || searchParams.get("reissue");
    if (prefill) {
      applyReissue(prefill);
    } else if (reissueId) {
      startReissue(reissueId)
        .then((res) => applyReissue(res.data))
        .catch((err) => setError(apiErrorMessage(err, "Could not load the reissuance prefill")));
    }
  }, []);

  function applyReissue(data) {
    setReissue(data);
    setFields((f) => ({ ...f, ...data.fields }));
    setExtraData(data.extraData || {});
    setNotice(`Reissuing ${data.supersedesCertificateId}: upload the corrected PDF. The original stays on-chain untouched; verifying it will point to the new certificate.`);
  }

  function setField(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  // ── Upload → extraction ────────────────────────────────
  async function runExtraction() {
    if (!file) return;
    setPhase("extracting");
    setError("");
    try {
      const form = new FormData();
      form.append("document", file);
      const res = await extractCertificate(form);
      if (!aliveRef.current) return;
      const d = res.data;
      setFields((f) => ({ ...f, ...d.fields }));
      setExtraData(d.extraData || {});
      setAi({
        confidence: d.confidence || {}, evidence: d.evidence || {},
        inferredFields: d.inferredFields || [], strategy: d.strategy,
        disclaimer: d.disclaimer,
      });
      setNotice("");
      setPhase("review");
    } catch (err) {
      if (!aliveRef.current) return;
      // Extraction failure never blocks issuance — manual entry is always possible.
      setAi(null);
      setNotice(`Automatic extraction failed (${apiErrorMessage(err, "unknown error")}). Enter the metadata manually — every field is editable.`);
      setPhase("review");
    }
  }

  function manualEntry() {
    setAi(null);
    setNotice("Manual entry: fill every field from the source document. Nothing is guessed.");
    setPhase("review");
  }

  // ── Review → prepare ───────────────────────────────────
  const reviewValid =
    fields.holderName.trim().length >= 2 &&
    (templates?.types || Object.keys(TYPE_LABELS)).includes(fields.certificateType);

  async function runPrepare() {
    if (!file || !reviewValid) return;
    setPhase("preparing");
    setError("");
    try {
      const form = new FormData();
      form.append("document", file);
      form.append("metadata", JSON.stringify({ ...fields, extraData }));
      if (reissue?.supersedesCertificateId) {
        form.append("supersedesCertificateId", reissue.supersedesCertificateId);
      }
      const res = await prepareIssuance(form);
      if (!aliveRef.current) return;
      setPrepare(res.data);
      setPhase("wallet");
    } catch (err) {
      if (!aliveRef.current) return;
      setError(apiErrorMessage(err, "Prepare failed"));
      setPhase("review");
    }
  }

  // ── Wallet → sign → confirm ────────────────────────────
  async function onWalletReady({ signer }) {
    signerRef.current = signer;
    setPhase("signing");
    setError("");
    setNotice("");
    try {
      const { txHash: hash } = await issueCertificate(signer, prepare.issueArgs);
      if (!aliveRef.current) return;
      setTxHash(hash);
      setPhase("confirming");
      await runConfirm(prepare.certificateId, hash);
    } catch (err) {
      if (!aliveRef.current) return;
      const werr = classifyWalletError(err);
      setError(werr.message);
      if (werr.code === "USER_REJECTED") {
        setNotice("Nothing was signed or sent. The prepared intent is still valid — sign again whenever you are ready.");
      }
      // Nothing was broadcast — the intent stays prepared and signing can retry.
      setPhase("wallet");
    }
  }

  async function runConfirm(certificateId, hash) {
    setConfirmError("");
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const res = await confirmIssuance(certificateId, hash);
        if (!aliveRef.current) return;
        setCertificate(res.data.certificate);
        setPhase("receipt");
        return;
      } catch (err) {
        if (!aliveRef.current) return;
        const status = err.response?.status;
        const data = err.response?.data;
        if (status === 202 || (status === 503 && attempt < 6)) {
          // Pending receipt / temporary chain outage — retry safely.
          await sleep(5000);
          continue;
        }
        if (status === 500 && data?.recovery) {
          setConfirmError(
            `${data.error} Transaction ${hash} is safe on-chain — use Retry confirm.`
          );
          return; // stay on confirming with a retry button
        }
        // 409 rejected / 410 expired / anything else: readable failure.
        setConfirmError(apiErrorMessage(err, "Confirmation failed"));
        setPhase("failed");
        return;
      }
    }
    setConfirmError("The receipt is still pending after two minutes. The transaction is safe on-chain — use Retry confirm.");
  }

  // ── Render ─────────────────────────────────────────────
  const extraKeys = Array.from(new Set([
    ...Object.keys(templates?.templates?.[fields.certificateType]?.extraFields || {}),
    ...Object.keys(extraData),
  ]));

  const ttlText = prepare?.intentExpiresAt
    ? `Prepared intent expires ${formatDateTime(prepare.intentExpiresAt)} — sign before then.`
    : "";

  return (
    <Layout title={reissue ? `Reissue ${reissue.supersedesCertificateId}` : "Issue Certificate"}>
      <div className="issue-flow">
        {/* Step rail */}
        <ol className="issue-rail">
          {[["upload", "Upload"], ["review", "Review"], ["wallet", "Sign"], ["receipt", "Receipt"]].map(([key, label]) => {
            const order = ["upload", "extracting", "review", "preparing", "wallet", "signing", "confirming", "receipt"];
            const active = order.indexOf(phase) >= order.indexOf(key) &&
              !(key === "upload" && order.indexOf(phase) > 1) &&
              !(key === "review" && order.indexOf(phase) > 3) &&
              !(key === "wallet" && order.indexOf(phase) > 6);
            const current =
              (key === "upload" && ["upload", "extracting"].includes(phase)) ||
              (key === "review" && ["review", "preparing"].includes(phase)) ||
              (key === "wallet" && ["wallet", "signing", "confirming"].includes(phase)) ||
              (key === "receipt" && phase === "receipt");
            return (
              <li key={key} className={`${active ? "active" : ""} ${current ? "current" : ""}`}>{label}</li>
            );
          })}
        </ol>

        {reissue && phase !== "receipt" && (
          <div className="alert alert-success">
            Reissuing <span className="mono">{reissue.supersedesCertificateId}</span> ({reissue.target?.holderName}). {reissue.note}
          </div>
        )}
        {notice && <div className="alert alert-success">{notice}</div>}
        {error && phase !== "confirming" && <div className="alert alert-error">{error}</div>}

        {/* ── UPLOAD ── */}
        {phase === "upload" && (
          <div className="card">
            <h3 className="section-title">Source certificate</h3>
            <CertificateUpload file={file} onFile={setFile} />
            {file && (
              <div className="issue-upload-actions">
                <button type="button" className="btn btn-primary" onClick={reissue ? () => setPhase("review") : runExtraction}>
                  {reissue
                    ? (<><ArrowRight {...ICON} /> Continue with previous metadata</>)
                    : (<><Sparkles {...ICON} /> Extract metadata with AI</>)}
                </button>
                {!reissue && (
                  <button type="button" className="btn btn-secondary" onClick={manualEntry}>
                    <PenLine {...ICON} /> Enter manually
                  </button>
                )}
              </div>
            )}
            <p className="issue-hint">
              The original PDF is hashed exactly as uploaded, encrypted, and pinned to IPFS.
              Only hashes reach the blockchain — never names or identifiers.
            </p>
          </div>
        )}

        {/* ── EXTRACTING ── */}
        {phase === "extracting" && (
          <div className="card extract-phase">
            <div className="extract-loader" aria-hidden />
            <h3>Reading the certificate…</h3>
            <p className="muted">
              Text layer first; scanned pages are OCR-processed locally. Only extracted TEXT
              is sent to the AI — the document image never leaves the server.
            </p>
          </div>
        )}

        {/* ── REVIEW ── */}
        {(phase === "review" || phase === "preparing") && (
          <div className="review-layout">
            <div className="card review-form">
              <h3 className="section-title">Review every field</h3>
              {ai?.disclaimer && <div className="alert alert-warning">{ai.disclaimer}</div>}
              {!ai && !reissue && (
                <div className="alert alert-warning">
                  Fields were not auto-extracted. Verify each value against the source PDF before issuing.
                </div>
              )}

              <div className="form-grid">
                <div className="field">
                  <label>{FIELD_LABELS.certificateType} *</label>
                  <select value={fields.certificateType} onChange={(e) => setField("certificateType", e.target.value)}>
                    {(templates?.types || Object.keys(TYPE_LABELS)).map((t) => (
                      <option key={t} value={t}>{templates?.templates?.[t]?.label || TYPE_LABELS[t] || t}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>{FIELD_LABELS.holderName} *</label>
                  <input value={fields.holderName} onChange={(e) => setField("holderName", e.target.value)} maxLength={200} />
                  <FieldAi fieldKey="holderName" ai={ai} />
                </div>
                {Object.keys(EMPTY_FIELDS).filter((k) => !REQUIRED_FIELDS.has(k)).map((key) => (
                  <div className="field" key={key}>
                    <label>{FIELD_LABELS[key]}</label>
                    <input
                      type={DATE_FIELDS.has(key) ? "date" : "text"}
                      value={fields[key]}
                      onChange={(e) => setField(key, e.target.value)}
                      title={templates?.descriptions?.[key] || ""}
                    />
                    <FieldAi fieldKey={key} ai={ai} />
                  </div>
                ))}
              </div>

              {extraKeys.length > 0 && (
                <>
                  <h3 className="section-title">Type-specific details</h3>
                  <div className="form-grid">
                    {extraKeys.map((key) => (
                      <div className="field" key={key}>
                        <label>{extraFieldLabel(key)}</label>
                        <input
                          value={extraData[key] || ""}
                          onChange={(e) => setExtraData((d) => ({ ...d, [key]: e.target.value }))}
                          title={templates?.templates?.[fields.certificateType]?.extraFields?.[key] || ""}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {!reviewValid && (
                <div className="alert alert-error">Holder name (min 2 characters) and certificate type are required.</div>
              )}

              <div className="issue-upload-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setPhase("upload")} disabled={phase === "preparing"}>
                  <ArrowLeft {...ICON} /> Back
                </button>
                <button type="button" className="btn btn-primary" onClick={runPrepare} disabled={!reviewValid || phase === "preparing"}>
                  {phase === "preparing" ? "Encrypting + pinning to IPFS…" : (<>Approve &amp; prepare issuance <ArrowRight {...ICON} /></>)}
                </button>
              </div>
            </div>

            <div className="review-side">
              <CertificatePreview file={file} title="Source document" height={640} />
            </div>
          </div>
        )}

        {/* ── WALLET ── */}
        {phase === "wallet" && prepare && (
          <div className="card">
            <h3 className="section-title">Sign with the authorized issuer wallet</h3>
            <p className="muted">
              Prepared <span className="mono">{prepare.certificateId}</span> — encrypted document pinned
              to IPFS (<span className="mono">{prepare.issueArgs.ipfsCID}</span>). {ttlText}
            </p>
            <WalletConnect expectedWallet={prepare.issuerWallet} onReady={onWalletReady} />
          </div>
        )}

        {/* ── SIGNING / CONFIRMING ── */}
        {(phase === "signing" || phase === "confirming") && prepare && (
          <div className="card">
            <h3 className="section-title">
              {phase === "signing" ? "Confirm the transaction in MetaMask" : "Verifying the on-chain receipt"}
            </h3>
            <TransactionStatus
              phase={phase === "signing" ? "sign" : "confirm"}
              txHash={txHash}
              error={confirmError}
              onRetry={confirmError ? () => { setPhase("confirming"); runConfirm(prepare.certificateId, txHash); } : null}
              retryLabel="Retry confirm"
              note={phase === "signing"
                ? "MetaMask is showing the issueCertificate transaction. Review it and confirm — nothing is sent until you approve."
                : "The backend independently checks the receipt, the event fields and the issuer against the prepared intent."}
            />
          </div>
        )}

        {/* ── FAILED ── */}
        {phase === "failed" && (
          <div className="card">
            <div className="alert alert-error"><AlertTriangle {...ICON} /> {confirmError || "Issuance failed."}</div>
            {txHash && (
              <p className="muted">
                Transaction <span className="mono">{txHash}</span>{" "}
                <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer"><ExternalLink size={13} strokeWidth={1.75} aria-hidden /> explorer</a>
              </p>
            )}
            <button type="button" className="btn btn-primary" onClick={() => window.location.assign("/issue")}>
              Start a new issuance
            </button>
          </div>
        )}

        {/* ── RECEIPT ── */}
        {phase === "receipt" && certificate && (
          <div className="card receipt-card">
            <div className="status-banner status-valid">
              <ShieldCheck size={26} strokeWidth={1.75} aria-hidden />
              <div>
                <strong>Certificate issued and confirmed on-chain</strong>
                <small className="mono">{certificate.certificateId}</small>
              </div>
            </div>
            <div className="receipt-grid">
              <QRDisplay
                certificateId={certificate.certificateId}
                qrCodeData={certificate.qrCodeData}
                verifyUrl={certificate.verifyUrl}
              />
              <div className="receipt-meta">
                <table className="details-table">
                  <tbody>
                    <tr><td>Holder</td><td>{certificate.holderName}</td></tr>
                    <tr><td>Type</td><td>{TYPE_LABELS[certificate.certificateType] || certificate.certificateType}</td></tr>
                    <tr><td>Issued</td><td>{formatDateTime(certificate.issuedAt)}</td></tr>
                    <tr><td>Block</td><td className="mono">{certificate.blockNumber}</td></tr>
                    <tr>
                      <td>Transaction</td>
                      <td>
                        <a href={explorerTxUrl(certificate.txHash)} target="_blank" rel="noreferrer" className="mono">
                          {certificate.txHash?.slice(0, 18)}… <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
                        </a>
                      </td>
                    </tr>
                    {certificate.supersedesCertificateId && (
                      <tr><td>Supersedes</td><td className="mono">{certificate.supersedesCertificateId}</td></tr>
                    )}
                  </tbody>
                </table>
                <div className="issue-upload-actions">
                  <Link className="btn btn-primary" to={`/certificates/${certificate.certificateId}`}>
                    View certificate <ArrowRight {...ICON} />
                  </Link>
                  <button type="button" className="btn btn-secondary" onClick={() => window.location.assign("/issue")}>
                    <FileUp {...ICON} /> Issue another
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

/** Per-field AI confidence + inferred flag + supporting fragment (tooltip). */
function FieldAi({ fieldKey, ai }) {
  if (!ai) return null;
  const conf = confidenceInfo(ai.confidence?.[fieldKey]);
  const inferred = ai.inferredFields?.includes(fieldKey);
  const fragment = ai.evidence?.[fieldKey];
  if (!conf && !inferred && !fragment) return null;
  return (
    <small className="field-ai" title={fragment ? `Source text: “${fragment}”` : undefined}>
      {conf && <span className={`confidence ${conf.className}`}>{conf.label}</span>}
      {inferred && <span className="confidence confidence-inferred">inferred</span>}
      {fragment && <span className="confidence-evidence">“{fragment.slice(0, 60)}{fragment.length > 60 ? "…" : ""}”</span>}
    </small>
  );
}