import { Navigate, Route, Routes } from "react-router";
import ProtectedRoute from "./components/ProtectedRoute";
import ChatLayout from "./layouts/ChatLayout";
import SettingsLayout from "./layouts/SettingsLayout";
import LoginPage from "./pages/auth/LoginPage";
import SignupPage from "./pages/auth/SignupPage";
import FilesPage from "./pages/FilesPage";
import GuestEntry from "./pages/GuestEntry";
import ProjectPage from "./pages/ProjectPage";
import ProjectsListPage from "./pages/ProjectsListPage";
import AccessibilityPage from "./pages/settings/AccessibilityPage";
import AddonsPage from "./pages/settings/AddonsPage";
import AdminPage from "./pages/settings/AdminPage";
import AppearancePage from "./pages/settings/AppearancePage";
// ComingSoonPage no longer routed for Security — section retired
// 2026-05-19 per a UX refactor.
import ExternalAgentsPage from "./pages/settings/ExternalAgentsPage";
import UserGuidePage from "./pages/settings/UserGuidePage";
import InferencePage from "./pages/settings/InferencePage";
import McpServersPage from "./pages/settings/McpServersPage";
import SkillsPage from "./pages/settings/SkillsPage";
import ProfilePage from "./pages/settings/ProfilePage";
import ShortcutsPage from "./pages/settings/ShortcutsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/g/:token" element={<GuestEntry />} />

      {/* /admin → /settings/admin permanent redirect (Admin Extended
       *  consolidated into Settings → Preferences in May 2026). */}
      <Route path="/admin" element={<Navigate to="/settings/admin" replace />} />

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
        path="/projects"
        element={
          <ProtectedRoute>
            <ProjectsListPage />
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
        path="/files"
        element={
          <ProtectedRoute>
            <FilesPage />
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
        <Route path="profile" element={<ProfilePage />} />
        {/* Retired 2026-05-19 — redirect old bookmarks to Profile so a
            user landing on /settings/security doesn't get a 404. */}
        <Route path="security" element={<Navigate to="/settings/profile" replace />} />
        <Route path="devices" element={<Navigate to="/settings/profile" replace />} />
        <Route path="learning" element={<Navigate to="/settings/help" replace />} />
        {/* Old paths redirect to /inference for backward compat */}
        <Route path="servers" element={<Navigate to="/settings/inference" replace />} />
        <Route path="engines" element={<Navigate to="/settings/inference" replace />} />
        <Route path="appearance" element={<AppearancePage />} />
        <Route path="accessibility" element={<AccessibilityPage />} />
        <Route path="shortcuts" element={<ShortcutsPage />} />
        <Route path="add-ons" element={<AddonsPage />} />
        <Route path="external-agents" element={<ExternalAgentsPage />} />
        <Route path="mcp-servers" element={<McpServersPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="user-guide" element={<UserGuidePage />} />
        <Route path="user-guide/:slug" element={<UserGuidePage />} />
        <Route path="help" element={<Navigate to="/settings/user-guide" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
