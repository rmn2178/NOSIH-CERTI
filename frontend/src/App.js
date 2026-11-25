import React, { useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { CSSTransition, TransitionGroup } from "react-transition-group";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import IssuePage from "./pages/IssuePage";
import CertificatesPage from "./pages/CertificatesPage";
import CertificateDetailsPage from "./pages/CertificateDetailsPage";
import InstitutionsPage from "./pages/InstitutionsPage";
import VerifyPage from "./pages/VerifyPage";
import TamperPage from "./pages/TamperPage";

function AnimatedRoutes() {
  const location = useLocation();
  const nodeRef = useRef(null);

  return (
    <TransitionGroup component={null}>
      <CSSTransition
        key={location.pathname}
        nodeRef={nodeRef}
        classNames="page"
        timeout={260}
        unmountOnExit
      >
        <div ref={nodeRef} style={{ position: "relative", width: "100%" }}>
          <Routes location={location}>
            {/* Public — verification never requires an account */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/verify" element={<VerifyPage />} />
            <Route path="/tamper" element={<TamperPage />} />

            {/* Protected portal */}
            <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route
              path="/issue"
              element={<ProtectedRoute roles={["issuer", "institution_admin"]}><IssuePage /></ProtectedRoute>}
            />
            <Route path="/certificates" element={<ProtectedRoute><CertificatesPage /></ProtectedRoute>} />
            <Route path="/certificates/:certificateId" element={<ProtectedRoute><CertificateDetailsPage /></ProtectedRoute>} />
            <Route path="/institutions" element={<ProtectedRoute><InstitutionsPage /></ProtectedRoute>} />

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </CSSTransition>
    </TransitionGroup>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AnimatedRoutes />
    </BrowserRouter>
  );
}