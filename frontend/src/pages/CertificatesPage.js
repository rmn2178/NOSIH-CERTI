import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import Layout from "../components/Layout";
import { listCertificates, listInstitutions, apiErrorMessage, sessionUser } from "../utils/api";
import {
  typeLabel, statusBadgeClass, STATUS_LABELS, TYPE_LABELS, formatDate,
} from "../utils/certificateHelpers";

const PAGE_SIZE = 25;

/** Institution-scoped certificate registry (platform admins can scope per institution). */
export default function CertificatesPage() {
  const user = sessionUser() || {};
  const isPlatformAdmin = user.role === "platform_admin";
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [institutionId, setInstitutionId] = useState("");
  const [institutions, setInstitutions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isPlatformAdmin) {
      listInstitutions()
        .then((res) => setInstitutions(res.data.institutions || []))
        .catch(() => {}); // filter is optional — the list still works without it
    }
  }, [isPlatformAdmin]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const params = { page, limit: PAGE_SIZE };
    if (q.trim()) params.q = q.trim();
    if (status) params.status = status;
    if (type) params.type = type;
    if (isPlatformAdmin && institutionId) params.institutionId = institutionId;

    const timer = setTimeout(() => {
      listCertificates(params)
        .then((res) => {
          if (!alive) return;
          setRows(res.data.certificates || []);
          setTotal(res.data.total ?? 0);
        })
        .catch((err) => { if (alive) setError(apiErrorMessage(err, "Could not load certificates")); })
        .finally(() => { if (alive) setLoading(false); });
    }, q ? 300 : 0); // debounce typing

    return () => { alive = false; clearTimeout(timer); };
  }, [q, status, type, institutionId, page, isPlatformAdmin]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Layout title="Certificates">
      <div className="toolbar">
        <div className="search-input">
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <input
            placeholder="Search holder, certificate ID or number…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </div>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {isPlatformAdmin && (
          <select value={institutionId} onChange={(e) => { setInstitutionId(e.target.value); setPage(1); }}>
            <option value="">All institutions</option>
            {institutions.map((i) => (
              <option key={i.id} value={i.institutionId}>{i.name}</option>
            ))}
          </select>
        )}
        <span className="total-count">{total} certificate{total === 1 ? "" : "s"}</span>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No certificates match. Issued certificates appear here immediately after chain confirmation.</p>
        ) : (
          <div className="table-wrapper">
            <table className="cert-table">
              <thead>
                <tr>
                  <th>Certificate ID</th>
                  <th>Holder</th>
                  <th>Type</th>
                  <th>Number</th>
                  {isPlatformAdmin && <th>Institution</th>}
                  <th>Issue date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.certificateId}
                    className={`row-click ${c.status === "revoked" ? "row-revoked" : ""}`}
                    onClick={() => navigate(`/certificates/${c.certificateId}`)}
                  >
                    <td className="id-cell mono">{c.certificateId}</td>
                    <td>{c.holderName}</td>
                    <td>{typeLabel(c.certificateType)}</td>
                    <td className="mono">{c.certificateNumber || "—"}</td>
                    {isPlatformAdmin && <td>{c.institution?.name || "—"}</td>}
                    <td>{formatDate(c.issueDate || c.createdAt)}</td>
                    <td><span className={statusBadgeClass(c.status)}>{STATUS_LABELS[c.status] || c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="pagination">
            <button type="button" className="btn btn-sm btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft size={14} strokeWidth={1.75} aria-hidden /> Previous
            </button>
            <span>Page {page} of {pages}</span>
            <button type="button" className="btn btn-sm btn-outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        )}
      </div>
    </Layout>
  );
}