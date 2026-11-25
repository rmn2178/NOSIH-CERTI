import React, { useState } from "react";
import { Ban, X } from "lucide-react";
import { revokeCertificate, apiErrorMessage } from "../utils/api";

const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true };

/**
 * Revocation confirmation modal — a reason is REQUIRED (3–1000 chars).
 * The reason stays private in the audit log; only its keyed hash goes
 * on-chain. Revocation is permanent and cannot be undone.
 */
export default function RevokeModal({ certificate, onClose, onRevoked }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const trimmed = reason.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= 1000;

  async function submit(e) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await revokeCertificate(certificate.certificateId, trimmed);
      onRevoked?.(res.data);
    } catch (err) {
      setError(apiErrorMessage(err, "Revocation failed"));
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Revoke certificate">
      <div className="modal-card">
        <div className="modal-header">
          <h2><Ban {...ICON} /> Revoke {certificate.certificateId}</h2>
          <button type="button" className="copy-btn" onClick={onClose} disabled={busy} title="Close">
            <X {...ICON} />
          </button>
        </div>

        <p className="modal-warning">
          Revocation is permanent and is written to the blockchain. Verification will
          return REVOKED even when the document itself is unchanged. This cannot be undone —
          a corrected certificate must be issued as a new one.
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="revoke-reason">Reason (required, kept private)</label>
            <textarea
              id="revoke-reason"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Certificate issued with an incorrect grade; holder requested cancellation"
              maxLength={1000}
              disabled={busy}
              required
            />
            <small>{trimmed.length}/1000 — minimum 3 characters. Only a keyed hash of this reason goes on-chain.</small>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={!valid || busy}>
              {busy ? "Revoking on-chain…" : "Revoke permanently"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}