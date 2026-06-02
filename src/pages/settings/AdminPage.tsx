/**
 * Admin — settings sub-page consolidating Users + Guest tokens.
 *
 * Replaces the previous `/admin` full-page with four tabs (Users, Nodes &
 * Groups, Files / Sync, Guest tokens). Nodes / Groups / Sync moved out of
 * Companion scope into the mlx-odyss.eu inference engine — see D-18 in
 * the decisions log. Only user lifecycle + guest-token minting belong to
 * the client app itself.
 *
 * Gated to admin / organiser roles. Non-privileged users get a quiet
 * empty state — there's no link to /settings/admin in their SettingsNav
 * either, so this is defence in depth.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "~/hooks/useAuth";
import { copyToClipboard } from "~/lib/clipboard";
import {
  api,
  type ApiAdminUser,
  type ApiAuditEntry,
  type ApiGuestToken,
  type ApiTeam,
  type ApiTeamMember,
  type AuthRole,
} from "~/lib/api";

export default function AdminPage() {
  const auth = useAuth();
  if (auth.loading) {
    return <span className="font-mono text-[11px] text-gray-400">…</span>;
  }
  if (!auth.user) return null;
  const role = auth.role;
  const isAdminish = role === "admin" || role === "organiser";
  if (!isAdminish) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-[36px] font-light text-navy">
          Admin
        </h1>
        <p className="max-w-[560px] text-[15px] text-gray-600">
          You don't have admin access. Ask your organisation's administrator
          to invite you with the right role.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Admin
        </span>
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
            Users &amp; access.
          </h1>
          <RoleBadge role={role!} />
        </div>
        <p className="max-w-[640px] text-[15px] leading-[24px] text-gray-600">
          Manage who has access to this instance and mint short-lived guest
          tokens for outside collaborators. Compute fleet, file sync and
          model deployment live in the inference engine (mlx-odyss.eu).
        </p>
      </header>

      <UsersSection selfId={auth.user.id} />
      <TeamsSection />
      <GuestsSection />
      <AuditLogSection />
    </div>
  );
}

function RoleBadge({ role }: { role: AuthRole }) {
  return (
    <span className="rounded-full bg-[rgba(79,179,217,0.14)] px-2.5 py-0.5 font-mono text-[11px] font-medium text-navy">
      {role}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────

function UsersSection({ selfId }: { selfId: string }) {
  const [rows, setRows] = useState<ApiAdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ApiAdminUser | null>(null);
  const [resetting, setResetting] = useState<ApiAdminUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listAdminUsers();
      setRows(r.users);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleActive(u: ApiAdminUser) {
    if (u.id === selfId) return;
    if (!confirm(`${u.active ? "Deactivate" : "Activate"} ${u.email}?`)) return;
    try {
      await api.updateAdminUser(u.id, { active: !u.active });
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function deleteUser(u: ApiAdminUser) {
    if (u.id === selfId) return;
    if (!confirm(`Soft-delete ${u.email}?`)) return;
    try {
      await api.deleteAdminUser(u.id);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Users"
        subtitle="Invite, suspend, and manage roles."
        action={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex h-9 items-center gap-2 rounded-md bg-navy px-3.5 text-[13px] font-medium text-white hover:opacity-95"
          >
            <PlusIcon />
            Add user
          </button>
        }
      />

      {error && <ErrorBanner error={error} />}

      <div className="flex flex-col">
        {rows === null && (
          <p className="py-6 text-center font-mono text-[11px] text-gray-400">
            Loading…
          </p>
        )}
        {rows && rows.length === 0 && (
          <p className="py-6 text-center font-mono text-[11px] text-gray-400">
            No users.
          </p>
        )}
        {rows?.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={u.id === selfId}
            onEdit={() => setEditing(u)}
            onResetPwd={() => setResetting(u)}
            onToggleActive={() => toggleActive(u)}
            onDelete={() => deleteUser(u)}
          />
        ))}
      </div>

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await refresh();
          }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onSaved={() => setResetting(null)}
        />
      )}
    </section>
  );
}

/**
 * Card-style row used by both the Users and Guests lists. Wraps cleanly
 * inside the narrow Settings outlet (max-w-[960px] with side nav) — no
 * horizontal scrollbar, no fixed-width columns. Action buttons stack
 * below the metadata on narrow viewports via flex-wrap.
 */
function UserRow({
  user,
  isSelf,
  onEdit,
  onResetPwd,
  onToggleActive,
  onDelete,
}: {
  user: ApiAdminUser;
  isSelf: boolean;
  onEdit: () => void;
  onResetPwd: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] text-ink">{user.email}</span>
          {isSelf && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
              you
            </span>
          )}
          <RolePill role={user.role} />
          {user.active ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              active
            </span>
          ) : (
            <span className="text-[11px] text-gray-400">inactive</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0 text-[12px] text-gray-500">
          {user.name && <span>{user.name}</span>}
          <span className="font-mono text-[11px]">
            last seen {fmtDate(user.lastInteractionAt)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <RowBtn onClick={onEdit}>Edit</RowBtn>
        <RowBtn onClick={onResetPwd}>Reset pwd</RowBtn>
        {!isSelf && (
          <>
            <RowBtn onClick={onToggleActive}>
              {user.active ? "Deactivate" : "Activate"}
            </RowBtn>
            <RowBtn danger onClick={onDelete}>
              Delete
            </RowBtn>
          </>
        )}
      </div>
    </div>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AuthRole>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createAdminUser({
        email: email.trim().toLowerCase(),
        name: name.trim() || undefined,
        password,
        role,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email">
          <TextInput value={email} onChange={setEmail} type="email" required autoFocus />
        </Field>
        <Field label="Name">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Password" hint="At least 8 chars.">
          <TextInput value={password} onChange={setPassword} type="password" required />
        </Field>
        <Field label="Role">
          <RoleSelect value={role} onChange={setRole} />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions onCancel={onClose} submitLabel={busy ? "Creating…" : "Create"} submitting={busy} />
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: ApiAdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(user.name ?? "");
  const [role, setRole] = useState<AuthRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateAdminUser(user.id, {
        name: name.trim(),
        role,
        active,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Role">
          <RoleSelect value={role} onChange={setRole} />
        </Field>
        <Field label="Active">
          <Toggle value={active} onChange={setActive} />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions onCancel={onClose} submitLabel={busy ? "Saving…" : "Save"} submitting={busy} />
      </form>
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onSaved,
}: {
  user: ApiAdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateAdminUser(user.id, { password });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset password for ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New password" hint="At least 8 chars.">
          <TextInput value={password} onChange={setPassword} type="password" required autoFocus />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions onCancel={onClose} submitLabel={busy ? "Saving…" : "Set password"} submitting={busy} />
      </form>
    </Modal>
  );
}

function RolePill({ role }: { role: AuthRole }) {
  const styles: Record<AuthRole, string> = {
    admin: "bg-rose-100 text-rose-700",
    organiser: "bg-amber-100 text-amber-700",
    user: "bg-gray-100 text-gray-700",
    guest: "bg-cyan/20 text-cyan",
  };
  return (
    <span className={`rounded px-2 py-0.5 font-mono text-[11px] font-medium ${styles[role]}`}>
      {role}
    </span>
  );
}

function RoleSelect({ value, onChange }: { value: AuthRole; onChange: (v: AuthRole) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as AuthRole)}
      className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
    >
      <option value="user">user</option>
      <option value="organiser">organiser</option>
      <option value="admin">admin</option>
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Guest tokens
// ─────────────────────────────────────────────────────────────────────────

function GuestsSection() {
  const [rows, setRows] = useState<ApiGuestToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMint, setShowMint] = useState(false);
  const [minted, setMinted] = useState<{ token: string; row: ApiGuestToken } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listGuestTokens();
      setRows(r.tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function extend(t: ApiGuestToken, days: number) {
    try {
      await api.extendGuestToken(t.id, days);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function revoke(t: ApiGuestToken) {
    if (!confirm(`Revoke token "${t.label ?? t.id.slice(0, 8)}"?`)) return;
    try {
      await api.revokeGuestToken(t.id);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Guest tokens"
        subtitle="Share a chat session with someone outside your team. Budget-capped, time-bound, revocable."
        action={
          <button
            type="button"
            onClick={() => setShowMint(true)}
            className="flex h-9 items-center gap-2 rounded-md bg-navy px-3.5 text-[13px] font-medium text-white hover:opacity-95"
          >
            <PlusIcon />
            Mint guest token
          </button>
        }
      />

      {error && <ErrorBanner error={error} />}

      <div className="flex flex-col">
        {rows === null && (
          <p className="py-6 text-center font-mono text-[11px] text-gray-400">
            Loading…
          </p>
        )}
        {rows && rows.length === 0 && (
          <p className="py-6 text-center font-mono text-[11px] text-gray-400">
            No guest tokens yet.
          </p>
        )}
        {rows?.map((t) => (
          <GuestRow
            key={t.id}
            token={t}
            onExtend={(days) => extend(t, days)}
            onRevoke={() => revoke(t)}
          />
        ))}
      </div>

      {showMint && (
        <MintGuestModal
          onClose={() => setShowMint(false)}
          onMinted={async (result) => {
            setShowMint(false);
            setMinted(result);
            await refresh();
          }}
        />
      )}
      {minted && (
        <MintedTokenModal token={minted.token} onClose={() => setMinted(null)} />
      )}
    </section>
  );
}

function GuestRow({
  token,
  onExtend,
  onRevoke,
}: {
  token: ApiGuestToken;
  onExtend: (days: number) => void;
  onRevoke: () => void;
}) {
  const revoked = !!token.revokedAt;
  const expired =
    !!token.expiresAt && new Date(token.expiresAt).getTime() < Date.now();
  const dead = revoked || expired;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 border-b border-gray-100 py-3 last:border-b-0 ${
        dead ? "opacity-50" : ""
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink">
            {token.label || (
              <span className="text-gray-400">(no label)</span>
            )}
          </span>
          {revoked && (
            <span className="text-[10px] text-red-600">revoked</span>
          )}
          {!revoked && expired && (
            <span className="text-[10px] text-gray-500">expired</span>
          )}
          <span className="font-mono text-[11px] text-gray-500">
            {token.tokensUsed.toLocaleString()} /{" "}
            {token.tokenBudget === 0 ? "∞" : token.tokenBudget.toLocaleString()}
          </span>
          <span className="font-mono text-[11px] text-gray-400">
            scope {token.scope}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 text-[11px] text-gray-500">
          <span className="font-mono">
            expires {fmtDate(token.expiresAt)}
          </span>
          <span className="font-mono">
            created {fmtDate(token.createdAt)}
          </span>
        </div>
      </div>
      {!revoked && (
        <div className="flex flex-wrap items-center gap-1">
          <RowBtn onClick={() => onExtend(7)}>+7d</RowBtn>
          <RowBtn onClick={() => onExtend(30)}>+30d</RowBtn>
          <RowBtn danger onClick={onRevoke}>
            Revoke
          </RowBtn>
        </div>
      )}
    </div>
  );
}

function MintGuestModal({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (r: { token: string; row: ApiGuestToken }) => void;
}) {
  const [label, setLabel] = useState("");
  const [tokenBudget, setTokenBudget] = useState(50000);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.mintGuestToken({
        label: label.trim() || undefined,
        tokenBudget,
        expiresInDays,
      });
      onMinted(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Mint guest token" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Label">
          <TextInput value={label} onChange={setLabel} placeholder="e.g. Mickaël demo" autoFocus />
        </Field>
        <Field label="Token budget" hint="0 = unlimited.">
          <input
            type="number"
            min={0}
            value={tokenBudget}
            onChange={(e) => setTokenBudget(Number(e.target.value))}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-cyan"
          />
        </Field>
        <Field label="Expires in (days)">
          <input
            type="number"
            min={1}
            max={365}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-cyan"
          />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions onCancel={onClose} submitLabel={busy ? "Minting…" : "Mint"} submitting={busy} />
      </form>
    </Modal>
  );
}

function MintedTokenModal({ token, onClose }: { token: string; onClose: () => void }) {
  const url = `${window.location.origin}/g/${token}`;
  const [copied, setCopied] = useState<"url" | "token" | null>(null);
  async function copy(value: string, kind: "url" | "token") {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }
  return (
    <Modal title="Token minted" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          This is the only time you'll see this token. Copy it now — once
          dismissed, it's gone forever.
        </div>
        <Field label="Token">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px]">
              {token}
            </code>
            <button
              type="button"
              onClick={() => copy(token, "token")}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              {copied === "token" ? "Copied!" : "Copy"}
            </button>
          </div>
        </Field>
        <Field label="Share URL">
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px]">
              {url}
            </code>
            <button
              type="button"
              onClick={() => copy(url, "url")}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              {copied === "url" ? "Copied!" : "Copy"}
            </button>
          </div>
        </Field>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-[24px] font-light text-navy">{title}</h2>
        {subtitle && <p className="text-[13px] text-gray-600">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

function ErrorBanner({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 font-mono text-[12px] text-red-700">
      {error}
    </div>
  );
}

function RowBtn({
  children,
  onClick,
  danger,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
        danger
          ? "border-red-200 text-red-600 hover:bg-red-50"
          : "border-gray-200 text-gray-700 hover:bg-gray-50"
      }`}
    >
      {children}
    </button>
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
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.04em] text-gray-500">{label}</span>
      {children}
      {hint && <span className="font-mono text-[11px] text-gray-400">{hint}</span>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
  required,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`flex h-6 w-11 items-center rounded-full px-0.5 transition-colors ${
        value ? "justify-end bg-navy" : "justify-start bg-gray-200"
      }`}
    >
      <div className="h-5 w-5 rounded-full bg-white shadow-sm" />
    </button>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h3 className="font-display text-[18px] font-light text-navy">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 hover:text-ink"
          >
            <XIcon />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({
  onCancel,
  submitLabel,
  submitting,
}: {
  onCancel: () => void;
  submitLabel: string;
  submitting?: boolean;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </div>
  );
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

// ── Audit log section ─────────────────────────────────────────────────────

function AuditLogSection() {
  const [entries, setEntries] = useState<ApiAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ event: "", resourceType: "", from: "", to: "" });

  useEffect(() => {
    setLoading(true);
    api.listAuditLog({ limit: 100, ...filter })
      .then((r) => setEntries(r.entries))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter]);

  const exportUrl = api.auditExportUrl(filter.from || undefined, filter.to || undefined);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[28px] font-light text-navy">Audit log</h2>
        <a
          href={exportUrl}
          download
          className="rounded-md border border-gray-200 px-3 py-1.5 font-mono text-[11px] text-gray-600 hover:border-cyan hover:text-navy"
        >
          Export CSV
        </a>
      </div>
      <p className="text-[13px] text-gray-500">
        Enterprise access log — memory reads, tool invocations, decisions, auth events.
        For DPO export, use the CSV button above.
      </p>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: "event", placeholder: "Event type (e.g. memory.read)" },
          { key: "resourceType", placeholder: "Resource type" },
          { key: "from", placeholder: "From (YYYY-MM-DD)", type: "date" },
          { key: "to", placeholder: "To (YYYY-MM-DD)", type: "date" },
        ].map(({ key, placeholder, type }) => (
          <input
            key={key}
            type={type ?? "text"}
            placeholder={placeholder}
            value={filter[key as keyof typeof filter]}
            onChange={(e) =>
              setFilter((f) => ({ ...f, [key]: e.target.value }))
            }
            className="rounded border border-gray-200 px-2 py-1 font-mono text-[11px] focus:border-cyan focus:outline-none"
          />
        ))}
      </div>

      {loading && <p className="font-mono text-[11px] text-gray-400">Loading…</p>}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 font-mono text-[10px] uppercase tracking-wider text-gray-500">
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Event</th>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Resource</th>
              <th className="px-3 py-2 text-left">IP</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                  No entries matching the current filter.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-[11px] text-gray-400 whitespace-nowrap">
                  {new Date(e.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  <span className={`rounded px-1.5 py-0.5 ${
                    e.event.startsWith("memory") ? "bg-cyan/10 text-cyan-700"
                    : e.event.startsWith("tool") ? "bg-amber-50 text-amber-700"
                    : e.event.startsWith("login") ? "bg-gray-100 text-gray-600"
                    : "bg-gray-50 text-gray-500"
                  }`}>
                    {e.event}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-gray-600">
                  {e.userId ? e.userId.slice(0, 8) + "…" : "—"}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-gray-500">
                  {e.resourceType ? `${e.resourceType}` : "—"}
                  {e.resourceId ? ` · ${e.resourceId.slice(0, 8)}…` : ""}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-gray-400">
                  {e.ip ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Teams section ─────────────────────────────────────────────────────────

function TeamsSection() {
  const [teams, setTeams] = useState<ApiTeam[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<ApiTeamMember[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listTeams().then((r) => setTeams(r.teams)).catch(() => {});
  }, []);

  async function selectTeam(id: string) {
    setSelected(id);
    const r = await api.getTeam(id).catch(() => null);
    if (r) setMembers(r.members);
  }

  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const r = await api.createTeam({ name: newName });
      setTeams((prev) => [...prev, r.team]);
      setNewName("");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteTeam(id: string) {
    await api.deleteTeam(id);
    setTeams((prev) => prev.filter((t) => t.id !== id));
    if (selected === id) { setSelected(null); setMembers([]); }
  }

  const selectedTeam = teams.find((t) => t.id === selected);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[28px] font-light text-navy">Teams</h2>
      <p className="text-[13px] text-gray-500">
        Teams share a LightRAG memory collection. Conversations in a team project
        query both personal and team memory in parallel.
      </p>

      <div className="flex gap-4">
        <div className="flex flex-col gap-2 min-w-[180px]">
          {teams.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => selectTeam(t.id)}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-[13px] ${
                selected === t.id
                  ? "border-cyan bg-cyan/5 text-navy"
                  : "border-gray-200 hover:border-cyan text-ink"
              }`}
            >
              <span className="truncate">{t.name}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void handleDeleteTeam(t.id); }}
                className="ml-2 text-gray-300 hover:text-red-400 text-[12px]"
              >×</button>
            </button>
          ))}
          <form onSubmit={createTeam} className="flex gap-1 mt-1">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New team…"
              className="flex-1 rounded border border-gray-200 px-2 py-1 text-[12px] focus:border-cyan focus:outline-none"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:border-cyan disabled:opacity-50"
            >+</button>
          </form>
        </div>

        {selectedTeam && (
          <div className="flex-1 flex flex-col gap-3 rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[12px] font-medium text-navy">{selectedTeam.name}</span>
              <button
                type="button"
                onClick={() => void api.nemoSyncTeam(selectedTeam.id).catch(() => {})}
                className="rounded border border-gray-200 px-2 py-1 font-mono text-[10px] text-gray-500 hover:border-cyan"
              >Sync memory</button>
            </div>
            <div className="flex flex-col gap-1">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center justify-between text-[12px]">
                  <span className="text-gray-600">{m.email}</span>
                  <span className="font-mono text-[10px] text-gray-400">{m.role}</span>
                </div>
              ))}
              {members.length === 0 && (
                <p className="text-[12px] text-gray-400">No members yet.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
