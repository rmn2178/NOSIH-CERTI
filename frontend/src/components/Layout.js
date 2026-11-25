import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, FileUp, FolderOpen, Building2, ScanSearch, FileSearch } from "lucide-react";
import logo from "../assets/nosih-logo.png";
import { sessionUser } from "../utils/api";
import { ROLE_LABELS } from "../utils/certificateHelpers";

const NAV_ICON = { size: 18, strokeWidth: 1.75, "aria-hidden": true };

export default function Layout({ title, children }) {
  const navigate = useNavigate();
  const user = sessionUser() || {};

  function logout() {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("user");
    navigate("/login");
  }

  const navItems = [
    { to: "/", icon: <LayoutDashboard {...NAV_ICON} />, label: "Dashboard" },
    ...( ["issuer", "institution_admin"].includes(user.role)
      ? [{ to: "/issue", icon: <FileUp {...NAV_ICON} />, label: "Issue Certificate" }]
      : [] ),
    { to: "/certificates", icon: <FolderOpen {...NAV_ICON} />, label: "Certificates" },
    { to: "/institutions", icon: <Building2 {...NAV_ICON} />, label: "Institutions" },
    { to: "/verify", icon: <ScanSearch {...NAV_ICON} />, label: "Verify" },
    { to: "/tamper", icon: <FileSearch {...NAV_ICON} />, label: "Tamper Check" },
  ];

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <img src={logo} alt="NOSIH logo" className="brand-logo" />
          <span>NOSIH</span>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <small>{user.email}</small>
            <span className="role-badge">{ROLE_LABELS[user.role] || user.role}</span>
            {user.institution?.name && <small className="user-institution">{user.institution.name}</small>}
          </div>
          <button onClick={logout} className="logout-btn">Sign Out</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="page-header">
          <h1>{title}</h1>
        </header>
        <div className="page-body">{children}</div>
      </main>
    </div>
  );
}