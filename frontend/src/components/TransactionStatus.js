import React from "react";
import { Check, Loader2, ExternalLink, AlertTriangle, RefreshCw } from "lucide-react";
import { explorerTxUrl } from "../services/contract";
import { shortHex } from "../utils/certificateHelpers";

const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true };

const STEPS = [
  { key: "prepare", label: "Prepared" },
  { key: "sign", label: "Signed in MetaMask" },
  { key: "confirm", label: "Chain confirmation" },
  { key: "done", label: "Certificate registered" },
];

/**
 * Issuance transaction progress. `phase` is one of the step keys;
 * `error` shows a readable failure with an optional retry action.
 * The txHash is displayed the moment it exists — even on failure the user
 * must never lose the recovery anchor.
 */
export default function TransactionStatus({ phase, txHash, error, onRetry, retryLabel = "Retry", note }) {
  const activeIdx = STEPS.findIndex((s) => s.key === phase);

  return (
    <div className="tx-status">
      <ol className="tx-steps">
        {STEPS.map((step, i) => {
          const done = activeIdx > i || phase === "done";
          const active = activeIdx === i && phase !== "done";
          return (
            <li key={step.key} className={`tx-step ${done ? "done" : ""} ${active ? "active" : ""}`}>
              <span className="tx-step-marker">
                {done ? <Check {...ICON} /> : active ? <Loader2 {...ICON} className="spin" /> : i + 1}
              </span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>

      {txHash && (
        <div className="tx-hash-row">
          <span className="mono" title={txHash}>{shortHex(txHash, 18, 10)}</span>
          <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="btn btn-sm btn-outline">
            <ExternalLink {...ICON} /> View on explorer
          </a>
        </div>
      )}

      {note && !error && <p className="tx-note">{note}</p>}

      {error && (
        <div className="alert alert-error tx-error">
          <AlertTriangle {...ICON} />
          <span>{error}</span>
        </div>
      )}
      {error && onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          <RefreshCw {...ICON} /> {retryLabel}
        </button>
      )}
    </div>
  );
}