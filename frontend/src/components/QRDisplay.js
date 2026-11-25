import React, { useState } from "react";
import { Download, Copy, Check } from "lucide-react";
import { certificateQrUrl, downloadCertificateQr } from "../utils/api";
import { copyText } from "../utils/certificateHelpers";

const ICON = { size: 14, strokeWidth: 1.75, "aria-hidden": true };

/**
 * Certificate QR — encodes the PUBLIC verify URL, so a phone camera opens
 * the verification page directly. Prefers the stored data URI; falls back
 * to the public PNG endpoint.
 */
export default function QRDisplay({ certificateId, qrCodeData, verifyUrl, compact }) {
  const [copied, setCopied] = useState(false);
  const src = qrCodeData || certificateQrUrl(certificateId);
  const link = verifyUrl || `${window.location.origin}/verify?certificateId=${certificateId}`;

  async function copyLink() {
    if (await copyText(link)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className={`qr-container ${compact ? "qr-compact" : ""}`}>
      <img src={src} alt={`Verification QR for ${certificateId}`} className="qr-image" />
      <div className="qr-meta">
        <span className="mono qr-id">{certificateId}</span>
        <small>Scan to verify — opens the public verification page.</small>
        <div className="qr-actions">
          <button type="button" className="btn btn-sm btn-outline" onClick={() => downloadCertificateQr(certificateId)}>
            <Download {...ICON} /> Download QR
          </button>
          <button type="button" className="btn btn-sm btn-outline" onClick={copyLink}>
            {copied ? <Check {...ICON} /> : <Copy {...ICON} />} {copied ? "Copied" : "Copy verify link"}
          </button>
        </div>
      </div>
    </div>
  );
}