import React from "react";
import {
  ShieldCheck, ShieldX, ShieldAlert, Clock, ArrowRight, ExternalLink, Check, X, BadgeCheck,
} from "lucide-react";
import { explorerTxUrl } from "../services/contract";
import {
  FIELD_LABELS, typeLabel, formatDate, formatDateTime, shortHex,
} from "../utils/certificateHelpers";

const ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true };

/** Verdict → banner presentation. Keys match backend VERDICTS exactly. */
const VERDICT_STYLE = {
  "authentic-active": { cls: "status-valid", Icon: ShieldCheck },
  revoked: { cls: "status-revoked", Icon: ShieldX },
  expired: { cls: "status-warning", Icon: Clock },
  superseded: { cls: "status-warning", Icon: ArrowRight },
  "document-mismatch": { cls: "status-invalid", Icon: ShieldX },
  "metadata-mismatch": { cls: "status-invalid", Icon: ShieldX },
  "issuer-unauthorized": { cls: "status-invalid", Icon: ShieldX },
  "db-chain-mismatch": { cls: "status-invalid", Icon: ShieldAlert },
  "not-found": { cls: "status-invalid", Icon: ShieldAlert },
  "blockchain-unavailable": { cls: "status-warning", Icon: ShieldAlert },
};

function Flag({ label, ok }) {
  return (
    <span className={`verify-flag ${ok ? "ok" : "bad"}`}>
      {ok ? <Check size={14} strokeWidth={1.75} aria-hidden /> : <X size={14} strokeWidth={1.75} aria-hidden />}
      {label}
    </span>
  );
}

/**
 * Renders the public verification payload (chain-authoritative).
 * `onVerifyAnother(certificateId)` lets superseded verdicts jump to the
 * replacement certificate. Never renders holder identifiers or extras —
 * the backend payload does not contain them.
 */
export default function VerificationResult({ payload, onVerifyAnother }) {
  if (!payload) return null;
  const style = VERDICT_STYLE[payload.verdict] || VERDICT_STYLE["not-found"];
  const { Icon } = style;
  const cert = payload.certificate;

  return (
    <div className="verify-result">
      <div className={`status-banner ${style.cls}`}>
        <Icon size={26} strokeWidth={1.75} aria-hidden />
        <div>
          <strong>{payload.verdictLabel || payload.verdict}</strong>
          <small className="mono">{payload.certificateId}</small>
        </div>
      </div>

      {payload.verdict === "blockchain-unavailable" && (
        <div className="alert alert-error">
          {payload.error || "The blockchain could not be reached. This result is INDETERMINATE — the certificate is NOT confirmed authentic. Retry in a moment."}
        </div>
      )}

      {payload.superseded && payload.supersededByCertificateId && (
        <div className="alert alert-success supersede-note">
          <span>This certificate was replaced by <span className="mono">{payload.supersededByCertificateId}</span>.</span>
          {onVerifyAnother && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => onVerifyAnother(payload.supersededByCertificateId)}>
              Verify the replacement <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
      )}

      {payload.found && (
        <div className="verify-flags">
          <Flag label="Document hash matches chain" ok={payload.documentHashMatch} />
          <Flag label="Metadata hash matches chain" ok={payload.metadataHashMatch} />
          <Flag label="Issuer authorized on-chain" ok={payload.issuerAuthorized} />
        </div>
      )}

      <div className="result-sections">
        {cert && (
          <section className="result-section">
            <h3>Certificate</h3>
            <table className="details-table">
              <tbody>
                <tr><td>{FIELD_LABELS.holderName}</td><td>{cert.holderName || "—"}</td></tr>
                <tr><td>{FIELD_LABELS.certificateType}</td><td>{typeLabel(cert.certificateType)}</td></tr>
                {cert.certificateNumber && <tr><td>{FIELD_LABELS.certificateNumber}</td><td className="mono">{cert.certificateNumber}</td></tr>}
                {cert.courseName && <tr><td>{FIELD_LABELS.courseName}</td><td>{cert.courseName}</td></tr>}
                {cert.qualification && <tr><td>{FIELD_LABELS.qualification}</td><td>{cert.qualification}</td></tr>}
                {cert.qualificationLevel && <tr><td>{FIELD_LABELS.qualificationLevel}</td><td>{cert.qualificationLevel}</td></tr>}
                {cert.specialization && <tr><td>{FIELD_LABELS.specialization}</td><td>{cert.specialization}</td></tr>}
                {cert.grade && <tr><td>{FIELD_LABELS.grade}</td><td>{cert.grade}</td></tr>}
                {cert.percentage && <tr><td>{FIELD_LABELS.percentage}</td><td>{cert.percentage}</td></tr>}
                {cert.academicYear && <tr><td>{FIELD_LABELS.academicYear}</td><td>{cert.academicYear}</td></tr>}
                <tr><td>{FIELD_LABELS.issueDate}</td><td>{formatDate(cert.issueDate)}</td></tr>
                {cert.expiryDate && <tr><td>{FIELD_LABELS.expiryDate}</td><td>{formatDate(cert.expiryDate)}</td></tr>}
                {cert.signatoryName && <tr><td>{FIELD_LABELS.signatoryName}</td><td>{cert.signatoryName}{cert.signatoryDesignation ? ` — ${cert.signatoryDesignation}` : ""}</td></tr>}
              </tbody>
            </table>
          </section>
        )}

        {payload.institution && (
          <section className="result-section">
            <h3>Institution</h3>
            <div className="institution-line">
              <strong>{payload.institution.name}</strong>
              <span className="mono">{payload.institution.institutionId}</span>
              {payload.institution.verified
                ? <span className="badge badge-active"><BadgeCheck size={13} strokeWidth={1.75} aria-hidden /> Verified institution</span>
                : <span className="badge badge-warning">Not platform-verified</span>}
            </div>
          </section>
        )}

        {payload.found && (
          <section className="result-section">
            <h3>Blockchain proof</h3>
            <table className="details-table">
              <tbody>
                {payload.issuerWallet && (
                  <tr><td>Issuer wallet</td><td className="hash-cell mono" title={payload.issuerWallet}>{shortHex(payload.issuerWallet, 16, 8)}</td></tr>
                )}
                {payload.transactionHash && (
                  <tr>
                    <td>Issuance transaction</td>
                    <td className="hash-cell">
                      <span className="mono" title={payload.transactionHash}>{shortHex(payload.transactionHash, 16, 8)}</span>{" "}
                      <a href={explorerTxUrl(payload.transactionHash)} target="_blank" rel="noreferrer">
                        <ExternalLink size={13} strokeWidth={1.75} aria-hidden /> explorer
                      </a>
                    </td>
                  </tr>
                )}
                {payload.blockNumber != null && <tr><td>Block</td><td className="mono">{payload.blockNumber}</td></tr>}
                {payload.issuedAt && <tr><td>Issued on-chain</td><td>{formatDateTime(payload.issuedAt)}</td></tr>}
                {payload.expiresAt && <tr><td>Expires (chain)</td><td>{formatDateTime(payload.expiresAt)}</td></tr>}
                {payload.documentHash && (
                  <tr><td>Document SHA-256</td><td className="hash-cell mono" title={payload.documentHash}>{shortHex(payload.documentHash, 18, 10)}</td></tr>
                )}
                <tr><td>Network</td><td>Polygon Amoy · chain {payload.chainId}</td></tr>
                {payload.contractAddress && (
                  <tr><td>Registry contract</td><td className="hash-cell mono" title={payload.contractAddress}>{shortHex(payload.contractAddress, 16, 8)}</td></tr>
                )}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {payload.revoked && (
        <div className="revoked-section">
          This certificate has been REVOKED by the issuing authority. Even if the document
          bytes match the registered hash, a revoked certificate must not be accepted.
        </div>
      )}

      <p className="verify-disclaimer">
        {payload.disclaimer || "Verification checks the blockchain record. It is not a judgement of the holder's identity."}
        {payload.verifiedAt && <> Checked {formatDateTime(payload.verifiedAt)}.</>}
      </p>
    </div>
  );
}