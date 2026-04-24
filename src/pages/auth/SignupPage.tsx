import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useAuth } from "~/hooks/useAuth";
import { AuthShell, Field } from "./LoginPage";

export default function SignupPage() {
  const { user, signup, loading } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) {
    return (
      <AuthShell>
        <div className="flex h-32 items-center justify-center font-mono text-[11px] text-gray-400">
          …
        </div>
      </AuthShell>
    );
  }
  if (user) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signup(email, password, name.trim() || undefined);
      navigate("/", { replace: true });
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
            Get started
          </span>
          <h1 className="font-display text-[32px] leading-[40px] font-light text-navy">
            Create your account.
          </h1>
        </div>

        <Field label="Name" hint="How you want to be addressed. Optional.">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>

        <Field label="Password" hint="At least 8 characters.">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
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
          {submitting ? "Creating…" : "Create account"}
        </button>

        <p className="text-center text-[13px] text-gray-600">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-cyan hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

function humanError(msg: string): string {
  if (msg.includes("email_taken")) return "Email already registered.";
  return msg;
}
