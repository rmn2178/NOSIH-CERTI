import React, { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { FileUp, FileText, X } from "lucide-react";
import { formatBytes } from "../utils/certificateHelpers";

const ICON = { size: 20, strokeWidth: 1.75, "aria-hidden": true };

/**
 * PDF-only certificate dropzone. The server re-validates magic bytes, size
 * and page count — this is convenience, not the security boundary.
 */
export default function CertificateUpload({ file, onFile, disabled, hint }) {
  const onDrop = useCallback(
    (accepted) => { if (accepted?.[0]) onFile(accepted[0]); },
    [onFile]
  );

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    disabled,
    maxSize: 15 * 1024 * 1024,
  });

  if (file) {
    return (
      <div className="upload-selected">
        <FileText {...ICON} />
        <div className="upload-selected-meta">
          <strong>{file.name}</strong>
          <small>{formatBytes(file.size)} · PDF</small>
        </div>
        {!disabled && (
          <button type="button" className="copy-btn" title="Remove file" onClick={() => onFile(null)}>
            <X {...ICON} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div {...getRootProps()} className={`dropzone ${isDragActive ? "dropzone-active" : ""} ${disabled ? "dropzone-disabled" : ""}`}>
        <input {...getInputProps()} />
        <FileUp size={28} strokeWidth={1.75} aria-hidden />
        <p>{isDragActive ? "Drop the certificate PDF here" : "Drag a certificate PDF here, or click to browse"}</p>
        <small>{hint || "PDF only · text or scanned · the original file is hashed exactly as uploaded"}</small>
      </div>
      {fileRejections?.[0]?.errors?.[0] && (
        <div className="alert alert-error">
          {fileRejections[0].errors[0].code === "file-too-large"
            ? "File is too large (max 15 MB)."
            : "Only PDF files are accepted."}
        </div>
      )}
    </div>
  );
}