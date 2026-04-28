import { Navigate, Route, Routes } from "react-router";
import ProtectedRoute from "./components/ProtectedRoute";
import ChatLayout from "./layouts/ChatLayout";
import SettingsLayout from "./layouts/SettingsLayout";
import LoginPage from "./pages/auth/LoginPage";
import SignupPage from "./pages/auth/SignupPage";
import ProjectPage from "./pages/ProjectPage";
import AccessibilityPage from "./pages/settings/AccessibilityPage";
import AddonsPage from "./pages/settings/AddonsPage";
import AppearancePage from "./pages/settings/AppearancePage";
import ComingSoonPage from "./pages/settings/ComingSoonPage";
import DevicesPage from "./pages/settings/DevicesPage";
import HelpPage from "./pages/settings/HelpPage";
import InferencePage from "./pages/settings/InferencePage";
import LearningCenterPage from "./pages/settings/LearningCenterPage";
import ProfilePage from "./pages/settings/ProfilePage";
import ShortcutsPage from "./pages/settings/ShortcutsPage";

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
        <Route index element={<Navigate to="/settings/inference" replace />} />
        <Route path="inference" element={<InferencePage />} />
        <Route path="learning" element={<LearningCenterPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="security" element={<ComingSoonPage title="Security" />} />
        {/* Old paths redirect to /inference for backward compat */}
        <Route path="servers" element={<Navigate to="/settings/inference" replace />} />
        <Route path="engines" element={<Navigate to="/settings/inference" replace />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="appearance" element={<AppearancePage />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="shortcuts" element={<ShortcutsPage />} />
        <Route path="add-ons" element={<AddonsPage />} />
        <Route path="help" element={<HelpPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
