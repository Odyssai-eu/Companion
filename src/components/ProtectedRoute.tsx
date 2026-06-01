import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "~/hooks/useAuth";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(null);

  useEffect(() => {
    // Only check setup status on a fresh install (no user loaded yet).
    if (loading || user) {
      setSetupNeeded(false);
      return;
    }
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((d: { needed: boolean }) => setSetupNeeded(d.needed))
      .catch(() => setSetupNeeded(false));
  }, [loading, user]);

  if (loading || setupNeeded === null) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gray-50">
        <span className="font-mono text-[11px] text-gray-400">…</span>
      </div>
    );
  }

  if (setupNeeded) {
    return <Navigate to="/setup" replace />;
  }

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <>{children}</>;
}
