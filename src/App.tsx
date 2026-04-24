import { Navigate, Route, Routes } from "react-router";
import ProtectedRoute from "./components/ProtectedRoute";
import ChatLayout from "./layouts/ChatLayout";
import SettingsLayout from "./layouts/SettingsLayout";
import LoginPage from "./pages/auth/LoginPage";
import SignupPage from "./pages/auth/SignupPage";
import ProjectPage from "./pages/ProjectPage";
import AccessibilityPage from "./pages/settings/AccessibilityPage";
import ComingSoonPage from "./pages/settings/ComingSoonPage";
import ServerDetailPage from "./pages/settings/ServerDetailPage";
import ServersPage from "./pages/settings/ServersPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ChatLayout />
          </ProtectedRoute>
        }
      />
      <Route
        path="/c/:id"
        element={
          <ProtectedRoute>
            <ChatLayout />
          </ProtectedRoute>
        }
      />

      <Route
        path="/projects/:id"
        element={
          <ProtectedRoute>
            <ProjectPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/settings/servers" replace />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="servers/:id" element={<ServerDetailPage />} />
        <Route path="profile" element={<ComingSoonPage title="Profile" />} />
        <Route path="security" element={<ComingSoonPage title="Security" />} />
        <Route path="engines" element={<ComingSoonPage title="Engines" />} />
        <Route path="devices" element={<ComingSoonPage title="Devices & sync" />} />
        <Route path="appearance" element={<ComingSoonPage title="Appearance" />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="shortcuts" element={<ComingSoonPage title="Shortcuts" />} />
        <Route path="add-ons" element={<ComingSoonPage title="Add-ons" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
