import React, { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Ban, RefreshCw, Eye, ExternalLink, History, Copy, Check,
} from "lucide-react";
import Layout from "../components/Layout";
import QRDisplay from "../components/QRDisplay";
import RevokeModal from "../components/RevokeModal";
import CertificatePreview from "../components/CertificatePreview";
import {
  getCertificate, fetchCertificateDocument, startReissue,
  apiErrorMessage, blobErrorMessage, sessionUser,
} from "../utils/api";
import { explorerTxUrl } from "../services/contract";
import {
  FIELD_LABELS, TYPE_LABELS, STATUS_LABELS, statusBadgeClass,
  formatDate, formatDateTime, shortHex, copyText, extraFieldLabel,
  canRevoke, canReissue,
} from "../utils/certificateHelpers";

const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true };

const EVENT_LABELS = {
  issued: "Issued",
  verified: "Verified (public)",
  revoked: "Revoked",
  reissued: "Reissued",
  superseded: "Superseded",
  expired: "Expired",
};

/** Full certificate record: metadata, chain proof, document, audit trail, actions. */
export default function CertificateDetailsPage() {
  const { certificateId } = useParams();
  const user = sessionUser() || {};
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [doc, setDoc] = useState(null);
  const [docBusy, setDocBusy] = useState(false);
  const [showRevoke, setShowRevoke] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(() => {
    getCertificate(certificateId)
      .then((res) => setData(res.data))
      .catch((err) => setError(apiErrorMessage(err, "Could not load the certificate")));
  }, [certificateId]);

  useEffect(() => { load(); }, [load]);

  async function viewDocument() {
    setDocBusy(true);
    setActionError("");
    try {
      const res = await fetchCertificateDocument(certificateId);
      setDoc(new Blob([res.data], { type: "application/pdf" }));
    } catch (err) {
      setActionError(await blobErrorMessage(err, "Could not fetch the document"));
    } finally {
      setDocBusy(false);
    }
  }

  async function reissue() {
    setActionError("");
    try {
      const res = await startReissue(certificateId);
      navigate("/issue", { state: { reissue: res.data } });
    } catch (err) {
      setActionError(apiErrorMessage(err, "Could not start the reissuance"));
    }
  }

  async function copy(value, key) {
    if (await copyText(value)) {
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    }
  }

  if (error) {
    return (
      <Layout title="Certificate">
        <div className="alert alert-error">{error}</div>
        <Link to="/certificates" className="btn btn-secondary"><ArrowLeft {...ICON} /> Back to certificates</Link>
      </Layout>
    );
  }
  if (!data) return <Layout title="Certificate"><p className="muted">Loading…</p></Layout>;

  const c = data.certificate;
  const events = data.events || [];
  const extraEntries = Object.entries(c.extraData || {}).filter(([, v]) => v);

  const HashRow = ({ label, value, copyKey }) => value ? (
    <tr>
      <td>{label}</td>
      <td className="hash-cell">
        <span className="mono" title={value}>{shortHex(value, 18, 10)}</span>
        <button type="button" className="copy-btn" title="Copy" onClick={() => copy(value, copyKey)}>
          {copied === copyKey ? <Check size={13} strokeWidth={1.75} aria-hidden /> : <Copy size={13} strokeWidth={1.75} aria-hidden />}
        </button>
      </td>
    </tr>
  ) : null;

  return (
    <Layout title={c.certificateId}>
      <div className="details-header">
        <Link to="/certificates" className="btn btn-sm btn-outline"><ArrowLeft {...ICON} /> All certificates</Link>
        <span className={statusBadgeClass(c.status)}>{STATUS_LABELS[c.status] || c.status}</span>
        <span className="badge badge-neutral">{TYPE_LABELS[c.certificateType] || c.certificateType}</span>
        <div className="details-actions">
          <button type="button" className="btn btn-sm btn-secondary" onClick={viewDocument} disabled={docBusy}>
            <Eye {...ICON} /> {docBusy ? "Decrypting…" : "View document"}
          </button>
          {canReissue(user, c) && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={reissue}>
              <RefreshCw {...ICON} /> Reissue
            </button>
          )}
          {canRevoke(user, c) && (
            <button type="button" className="btn btn-sm btn-danger" onClick={() => setShowRevoke(true)}>
              <Ban {...ICON} /> Revoke
            </button>
          )}
        </div>
      </div>

      {actionError && <div className="alert alert-error">{actionError}</div>}

      {c.status === "revoked" && (
        <div className="revoked-section">
          Revoked {formatDateTime(c.revokedAt)}
          {c.revokeReason && <> — reason (private): {c.revokeReason}</>}
          {c.revokedTxHash && (
            <> · <a href={explorerTxUrl(c.revokedTxHash)} target="_blank" rel="noreferrer">revocation transaction <ExternalLink size={13} strokeWidth={1.75} aria-hidden /></a></>
          )}
        </div>
      )}
      {c.supersededByCertificateId && (
        <div className="alert alert-warning">
          Superseded by <Link to={`/certificates/${c.supersededByCertificateId}`} className="mono">{c.supersededByCertificateId}</Link>.
        </div>
      )}
      {c.supersedesCertificateId && (
        <div className="alert alert-success">
          This certificate supersedes <Link to={`/certificates/${c.supersedesCertificateId}`} className="mono">{c.supersedesCertificateId}</Link>.
        </div>
      )}

      <div className="details-columns">
        <div className="details-main">
          <div className="card">
            <h3 className="section-title">Metadata</h3>
            <table className="details-table">
              <tbody>
                {Object.keys(FIELD_LABELS).map((key) => {
                  const value = key === "certificateType" ? (TYPE_LABELS[c[key]] || c[key]) : c[key];
                  if (!value) return null;
                  return (
                    <tr key={key}>
                      <td>{FIELD_LABELS[key]}</td>
                      <td>{DATE_KEYS.has(key) ? formatDate(value) : String(value)}</td>
                    </tr>
                  );
                })}
                {c.institution?.name && (
                  <tr><td>Issuing institution</td><td>{c.institution.name} <span className="mono">({c.institution.institutionId})</span></td></tr>
                )}
              </tbody>
            </table>
            {extraEntries.length > 0 && (
              <>
                <h3 className="section-title">Type-specific details</h3>
                <table className="details-table">
                  <tbody>
                    {extraEntries.map(([k, v]) => (
                      <tr key={k}><td>{extraFieldLabel(k)}</td><td>{v}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div className="card">
            <h3 className="section-title">Blockchain proof</h3>
            <table className="details-table">
              <tbody>
                <tr>
                  <td>Issuance transaction</td>
                  <td className="hash-cell">
                    <span className="mono" title={c.txHash}>{shortHex(c.txHash, 18, 10)}</span>
                    <a href={explorerTxUrl(c.txHash)} target="_blank" rel="noreferrer" className="copy-btn" title="Explorer">
                      <ExternalLink size={13} strokeWidth={1.75} aria-hidden />
                    </a>
                  </td>
                </tr>
                <tr><td>Block</td><td className="mono">{c.blockNumber}</td></tr>
                <tr><td>Issued on-chain</td><td>{formatDateTime(c.issuedAt)}</td></tr>
                {c.chainExpiresAt ? <tr><td>Expires (chain)</td><td>{formatDateTime(c.chainExpiresAt * 1000)}</td></tr> : null}
                <HashRow label="Issuer wallet" value={c.issuerWallet} copyKey="wallet" />
                <HashRow label="Document SHA-256" value={c.documentHash} copyKey="doc" />
                <HashRow label="Metadata hash" value={c.metadataHash} copyKey="meta" />
                <HashRow label="Certificate ID hash" value={c.certificateIdHash} copyKey="idhash" />
                <tr>
                  <td>IPFS CID (ciphertext)</td>
                  <td className="hash-cell">
                    <span className="mono" title={c.ipfsCid}>{shortHex(c.ipfsCid, 16, 8)}</span>
                    <button type="button" className="copy-btn" title="Copy" onClick={() => copy(c.ipfsCid, "cid")}>
                      {copied === "cid" ? <Check size={13} strokeWidth={1.75} aria-hidden /> : <Copy size={13} strokeWidth={1.75} aria-hidden />}
                    </button>
                  </td>
                </tr>
                {c.originalFilename && <tr><td>Original file</td><td>{c.originalFilename}</td></tr>}
              </tbody>
            </table>
          </div>

          {doc && (
            <div className="card">
              <CertificatePreview file={doc} title={`Decrypted original — ${c.certificateId}`} height={640} />
            </div>
          )}

          <div className="card">
            <h3 className="section-title"><History {...ICON} /> Audit trail</h3>
            {events.length === 0 ? (
              <p className="muted">No events recorded.</p>
            ) : (
              <ol className="event-timeline">
                {events.map((ev) => (
                  <li key={ev.id} className={`event-item event-${ev.eventType}`}>
                    <div className="event-head">
                      <strong>{EVENT_LABELS[ev.eventType] || ev.eventType}</strong>
                      <small>{formatDateTime(ev.createdAt)}</small>
                    </div>
                    {ev.reason && <p className="event-reason">{ev.reason}</p>}
                    {ev.transactionHash && (
                      <a className="mono event-tx" href={explorerTxUrl(ev.transactionHash)} target="_blank" rel="noreferrer">
                        {shortHex(ev.transactionHash, 14, 8)} <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
                      </a>
                    )}
                    {ev.details?.supersededBy && <small className="mono">→ {ev.details.supersededBy}</small>}
                    {ev.details?.supersedes && <small className="mono">supersedes {ev.details.supersedes}</small>}
                    {ev.eventType === "verified" && ev.details?.verdict && (
                      <small>verdict: {ev.details.verdict}</small>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className="details-side">
          <div className="card">
            <h3 className="section-title">Public verification</h3>
            <QRDisplay certificateId={c.certificateId} qrCodeData={c.qrCodeData} verifyUrl={c.verifyUrl} compact />
            <Link className="btn btn-sm btn-outline full-width" to={`/verify?certificateId=${c.certificateId}`}>
              Open public verify page
            </Link>
          </div>
        </div>
      </div>

      {showRevoke && (
        <RevokeModal
          certificate={c}
          onClose={() => setShowRevoke(false)}
          onRevoked={() => { setShowRevoke(false); load(); }}
        />
      )}
    </Layout>
  );
}

const DATE_KEYS = new Set(["issueDate", "expiryDate"]);