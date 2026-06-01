/**
 * First-run setup wizard. Shown automatically when the DB is empty.
 * Three steps: (1) create operator account, (2) optionally pair engine,
 * (3) done. Steps 2+ are optional — can always be done later in Settings.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

type Step = "account" | "done";

export default function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("account");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/setup/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { detail?: string };
        throw new Error(body.detail ?? `Setup failed (${res.status})`);
      }
      setStep("done");
    } catch (err: unknown) {
      setError((err as Error).message ?? "Setup failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="font-display text-[28px] font-light text-navy">
            Welcome to Companion
          </h1>
          <p className="mt-2 text-[14px] text-gray-500">
            Set up your operator account to get started.
          </p>
        </div>

        {step === "account" && (
          <form
            onSubmit={handleAccount}
            className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
          >
            <h2 className="font-mono text-[12px] uppercase tracking-widest text-gray-400">
              Step 1 — Create operator account
            </h2>

            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] text-gray-500">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
                className="rounded-lg border border-gray-200 px-3 py-2 text-[14px] focus:border-cyan focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] text-gray-500">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@yourcompany.com"
                required
                className="rounded-lg border border-gray-200 px-3 py-2 text-[14px] focus:border-cyan focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] text-gray-500">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8+ characters"
                required
                minLength={8}
                className="rounded-lg border border-gray-200 px-3 py-2 text-[14px] focus:border-cyan focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] text-gray-500">
                Confirm password
              </label>
              <input
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                placeholder="Repeat password"
                required
                className="rounded-lg border border-gray-200 px-3 py-2 text-[14px] focus:border-cyan focus:outline-none"
              />
            </div>

            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-600">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting || !name || !email || !password || !password2}
              className="mt-1 rounded-lg bg-navy py-2.5 text-[14px] font-medium text-white hover:opacity-95 disabled:opacity-50"
            >
              {submitting ? "Creating account…" : "Create operator account →"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm text-center">
            <div className="text-[32px]">✓</div>
            <h2 className="font-display text-[20px] font-light text-navy">
              You're all set
            </h2>
            <p className="text-[13px] text-gray-500">
              Your operator account is created. Pair an inference engine and
              invite users from{" "}
              <span className="font-mono">Settings → Inference</span> and{" "}
              <span className="font-mono">Settings → Admin</span>.
            </p>
            <button
              onClick={() => navigate("/")}
              className="mt-2 rounded-lg bg-navy py-2.5 text-[14px] font-medium text-white hover:opacity-95"
            >
              Open Companion →
            </button>
          </div>
        )}

        <p className="mt-6 text-center font-mono text-[11px] text-gray-400">
          This screen only appears once — on a fresh install with no users.
        </p>
      </div>
    </div>
  );
}
