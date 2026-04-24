import { useEffect, useState } from "react";
import { useAuth } from "~/hooks/useAuth";
import { api } from "~/lib/api";

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === user?.name) return;
    setSavingName(true);
    setNameError(null);
    try {
      await api.updateProfile({ name: name.trim() });
      await refresh();
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch (e) {
      setNameError((e as Error).message);
    } finally {
      setSavingName(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Account
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Profile.
        </h1>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-[20px] font-light text-navy">
          Identity
        </h2>
        <form
          onSubmit={saveName}
          className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4"
        >
          <Field label="Email">
            <input
              value={user?.email ?? ""}
              disabled
              className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-[13px] text-gray-600 outline-none"
            />
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
            />
          </Field>
          <div className="flex items-center justify-end gap-3">
            {nameError && (
              <span className="text-[12px] text-red-600">{nameError}</span>
            )}
            {nameSaved && (
              <span className="text-[12px] text-emerald-600">Saved ✓</span>
            )}
            <button
              type="submit"
              disabled={savingName || !name.trim() || name.trim() === user?.name}
              className="flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-40"
            >
              {savingName ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      </section>

      <ChangePasswordSection />
    </div>
  );
}

function ChangePasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setSaved(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("invalid_current_password")) {
        setError("Current password is wrong.");
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[20px] font-light text-navy">
        Change password
      </h2>
      <form
        onSubmit={submit}
        className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4"
      >
        <Field label="Current password">
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {error && <span className="text-[12px] text-red-600">{error}</span>}
          {saved && <span className="text-[12px] text-emerald-600">Updated ✓</span>}
          <button
            type="submit"
            disabled={submitting}
            className="flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Update password"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-gray-400">{hint}</span>}
    </label>
  );
}
