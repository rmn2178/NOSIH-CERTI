import React, { useEffect, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { fetchMe } from "../utils/api";
import { ROLE_LABELS } from "../utils/certificateHelpers";

/**
 * Role-aware route guard. Validates the session against /auth/me (fresh from
 * the database, so role/institution changes apply immediately) and refreshes
 * the cached user. `roles` restricts the route; everyone else sees a readable
 * denial — never a blank page or a silent redirect loop.
 */
export default function ProtectedRoute({ roles, children }) {
  const [state, setState] = useState({ status: "checking", user: null });

  useEffect(() => {
    let alive = true;
    const token = sessionStorage.getItem("token");
    if (!token) {
      setState({ status: "invalid", user: null });
      return;
    }
    fetchMe()
      .then((res) => {
        if (!alive) return;
        sessionStorage.setItem("user", JSON.stringify(res.data));
        setState({ status: "valid", user: res.data });
      })
      .catch(() => {
        if (!alive) return;
        sessionStorage.removeItem("token");
        sessionStorage.removeItem("user");
        setState({ status: "invalid", user: null });
      });
    return () => { alive = false; };
  }, []);

  if (state.status === "checking") return null; // brief blank while validating
  if (state.status === "invalid") return <Navigate to="/login" replace />;

  if (roles && !roles.includes(state.user?.role)) {
    return (
      <div className="access-denied">
        <div className="card access-denied-card">
          <h2>Not available for your role</h2>
          <p>
            This area requires {roles.map((r) => ROLE_LABELS[r] || r).join(" or ")}.
            You are signed in as {ROLE_LABELS[state.user?.role] || state.user?.role || "unknown"}.
          </p>
          <Link to="/" className="btn btn-primary">Back to dashboard</Link>
        </div>
      </div>
    );
  }

  return children;
}