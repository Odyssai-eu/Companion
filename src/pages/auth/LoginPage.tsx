import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import Wordmark from "~/components/Wordmark";
import { useAuth } from "~/hooks/useAuth";

export default function LoginPage() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <AuthShell><Pending /></AuthShell>;
  if (user) {
    const next = new URLSearchParams(location.search).get("next") ?? "/";
    return <Navigate to={next} replace />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      const next = new URLSearchParams(location.search).get("next") ?? "/";
      navigate(next, { replace: true });
    } catch (e) {
      setError(humanError((e as Error).message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
            Welcome back
          </span>
          <h1 className="font-display text-[32px] leading-[40px] font-light text-navy">
            Sign in.
          </h1>
        </div>

        <Field label="Email or username">
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[12px] text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="flex h-10 items-center justify-center rounded-lg bg-navy px-4 text-[14px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-center text-[13px] text-gray-600">
          Don't have an account?{" "}
          <Link
            to="/signup"
            className="font-medium text-cyan hover:underline"
          >
            Create one
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-gray-50 px-4 py-16">
      <div className="flex w-full max-w-[380px] flex-col gap-8">
        <Wordmark />
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-[0_1px_2px_rgba(10,10,10,0.04)]">
          {children}
        </div>
        <p className="text-center font-mono text-[11px] text-gray-400">
          Your conversations stay on your hardware.
        </p>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-gray-400">{hint}</span>}
    </label>
  );
}

function Pending() {
  return (
    <div className="flex h-32 items-center justify-center font-mono text-[11px] text-gray-400">
      …
    </div>
  );
}

function humanError(msg: string): string {
  if (msg.includes("invalid_credentials")) return "Wrong email or password.";
  if (msg.includes("email_taken")) return "Email already registered.";
  return msg;
}
