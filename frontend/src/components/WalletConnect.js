import React, { useEffect, useState } from "react";
import { Wallet, ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";
import {
  hasMetaMask,
  connectAuthorizedIssuer,
  onWalletChange,
  AMOY_CHAIN_ID,
} from "../services/wallet";
import { shortHex } from "../utils/certificateHelpers";

const ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true };

/**
 * MetaMask connection gate for issuance.
 *
 * Enforces the full pre-sign contract from wallet.js: the connected account
 * must equal the authorized issuer wallet on file, and the wallet must be on
 * Polygon Amoy. The private key never leaves MetaMask — this component only
 * ever receives a signer handle.
 */
export default function WalletConnect({ expectedWallet, onReady, busy }) {
  const [state, setState] = useState({ status: "idle", account: null, error: null });

  // Account/chain switches invalidate a previous connection.
  useEffect(() => {
    return onWalletChange(() => {
      setState((s) => (s.status === "connected" ? { status: "idle", account: null, error: null } : s));
    });
  }, []);

  async function connect() {
    setState({ status: "connecting", account: null, error: null });
    try {
      const { signer, account } = await connectAuthorizedIssuer(expectedWallet);
      setState({ status: "connected", account, error: null });
      onReady?.({ signer, account });
    } catch (err) {
      setState({ status: "error", account: null, error: err });
    }
  }

  if (!hasMetaMask()) {
    return (
      <div className="wallet-card">
        <div className="alert alert-error">
          MetaMask was not detected. Install the MetaMask browser extension, reload this page,
          and connect the wallet your institution authorized.
        </div>
        <a className="btn btn-secondary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
          Get MetaMask
        </a>
      </div>
    );
  }

  return (
    <div className="wallet-card">
      <div className="wallet-row">
        <Wallet {...ICON} />
        <div className="wallet-meta">
          <strong>Issuer wallet</strong>
          <small className="mono" title={expectedWallet}>
            {expectedWallet ? shortHex(expectedWallet, 14, 8) : "assigned at prepare"}
          </small>
        </div>
        <span className="badge badge-neutral">Polygon Amoy · {AMOY_CHAIN_ID}</span>
      </div>

      {state.status === "connected" && (
        <div className="alert alert-success wallet-connected">
          <ShieldCheck {...ICON} />
          <span>
            Connected as <span className="mono" title={state.account}>{shortHex(state.account, 14, 8)}</span>
            {" "}— account matches and network is Amoy.
          </span>
        </div>
      )}

      {state.status === "error" && (
        <div className="alert alert-error wallet-error">
          <ShieldAlert {...ICON} />
          <span>{state.error?.message || "Wallet connection failed"}</span>
        </div>
      )}

      {state.status !== "connected" && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={connect}
          disabled={busy || state.status === "connecting"}
        >
          {state.status === "connecting" ? "Waiting for MetaMask…" :
            state.status === "error" ? (<><RefreshCw {...ICON} /> Retry connection</>) :
            "Connect MetaMask"}
        </button>
      )}

      <p className="wallet-note">
        Signing happens inside MetaMask. Your private key never leaves the wallet,
        and the server cannot issue on your behalf.
      </p>
    </div>
  );
}