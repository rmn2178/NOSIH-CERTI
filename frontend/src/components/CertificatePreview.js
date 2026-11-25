import React, { useEffect, useState } from "react";
import { Download } from "lucide-react";

/**
 * Source-PDF preview. Works with a File (issue flow) or a Blob (decrypted
 * document from the API). Uses an object URL and always revokes it.
 */
export default function CertificatePreview({ file, title = "Certificate PDF", height = 520 }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  if (!file || !url) return null;

  return (
    <div className="pdf-preview">
      <div className="pdf-preview-bar">
        <span>{title}</span>
        <a className="btn btn-sm btn-outline" href={url} download={file.name || "certificate.pdf"}>
          <Download size={14} strokeWidth={1.75} aria-hidden /> Download
        </a>
      </div>
      <object data={url} type="application/pdf" width="100%" height={height} aria-label={title}>
        <p className="pdf-preview-fallback">
          Inline preview is not available in this browser.{" "}
          <a href={url} download={file.name || "certificate.pdf"}>Download the PDF</a> instead.
        </p>
      </object>
    </div>
  );
}