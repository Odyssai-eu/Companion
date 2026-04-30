/**
 * Admin Extended — four-tab admin panel for users, nodes & groups, file
 * sync, and guest tokens. Mounted at `/admin`. Gated to admin / organiser
 * roles by the route in App.tsx; non-admins land on the empty state below.
 *
 * Kept in a single file deliberately — each tab is local and the surface is
 * desktop-primary. Components do their own data loading via the api object;
 * there's no global cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate } from "react-router";
import { useAuth } from "~/hooks/useAuth";
import {
  api,
  type ApiAdminGroup,
  type ApiAdminNode,
  type ApiAdminUser,
  type ApiGuestToken,
  type ApiSyncJob,
  type ApiSyncMatrixEntry,
  type AuthRole,
  streamSyncEvents,
  type SyncStreamEvent,
} from "~/lib/api";

type Tab = "users" | "nodes" | "sync" | "guests";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "users", label: "Users" },
  { id: "nodes", label: "Nodes & Groups" },
  { id: "sync", label: "Files / Sync" },
  { id: "guests", label: "Guest tokens" },
];

export default function AdminExtPage() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>("users");

  if (auth.loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-gray-50">
        <span className="font-mono text-[11px] text-gray-400">…</span>
      </div>
    );
  }
  if (!auth.user) {
    return <Navigate to="/login?next=%2Fadmin" replace />;
  }
  const role = auth.role;
  const isAdminish = role === "admin" || role === "organiser";

  if (!isAdminish) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center">
        <h1 className="font-display text-[36px] font-light text-navy">
          Admin Extended
        </h1>
        <p className="max-w-[440px] text-[14px] text-gray-600">
          You don't have admin access. Ask your organisation's administrator
          to invite you with the right role.
        </p>
        <Link
          to="/"
          className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          Back to chat
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-gray-50">
      <header className="flex flex-wrap items-center gap-4 border-b border-gray-200 bg-white px-6 py-4">
        <Link
          to="/"
          aria-label="Back to chat"
          className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 hover:text-ink"
        >
          <ChevronLeftIcon />
        </Link>
        <div className="flex flex-1 items-baseline gap-3">
          <h1 className="font-display text-[26px] font-light text-navy">
            Admin Extended
          </h1>
          <RoleBadge role={role!} />
        </div>
      </header>

      <div className="flex flex-1 min-h-0 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 bg-white px-3 py-2 md:flex-col md:gap-0.5 md:overflow-visible md:border-r md:border-b-0 md:px-3 md:py-6 md:w-[220px]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-3 py-2 text-left text-[13px] transition-colors ${
                tab === t.id
                  ? "bg-[rgba(79,179,217,0.12)] font-medium text-navy"
                  : "text-gray-600 hover:bg-gray-50 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1100px] px-5 py-8 md:px-10 md:py-10">
            {tab === "users" && <UsersTab selfId={auth.user.id} />}
            {tab === "nodes" && <NodesTab />}
            {tab === "sync" && <SyncTab />}
            {tab === "guests" && <GuestsTab />}
          </div>
        </main>
      </div>
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
// Users tab
// ─────────────────────────────────────────────────────────────────────────

function UsersTab({ selfId }: { selfId: string }) {
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
    refresh();
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
    <section className="flex flex-col gap-6">
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

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-[13px]">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.06em] text-gray-500">
            <tr>
              <Th>Email</Th>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Active</Th>
              <Th>Last seen</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={6} className="py-8 text-center font-mono text-[11px] text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center font-mono text-[11px] text-gray-400">
                  No users.
                </td>
              </tr>
            )}
            {rows?.map((u) => (
              <tr key={u.id} className="border-t border-gray-100">
                <Td>
                  <span className="font-mono">{u.email}</span>
                  {u.id === selfId && (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                      you
                    </span>
                  )}
                </Td>
                <Td>{u.name ?? <span className="text-gray-400">—</span>}</Td>
                <Td><RolePill role={u.role} /></Td>
                <Td>
                  {u.active ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      yes
                    </span>
                  ) : (
                    <span className="text-gray-400">no</span>
                  )}
                </Td>
                <Td>
                  <span className="font-mono text-[12px] text-gray-500">
                    {fmtDate(u.lastInteractionAt)}
                  </span>
                </Td>
                <Td className="text-right">
                  <div className="inline-flex gap-1">
                    <RowBtn onClick={() => setEditing(u)}>Edit</RowBtn>
                    <RowBtn onClick={() => setResetting(u)}>Reset pwd</RowBtn>
                    {u.id !== selfId && (
                      <>
                        <RowBtn onClick={() => toggleActive(u)}>
                          {u.active ? "Deactivate" : "Activate"}
                        </RowBtn>
                        <RowBtn danger onClick={() => deleteUser(u)}>Delete</RowBtn>
                      </>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
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
        email: email.trim(),
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
          <TextInput
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoFocus
          />
        </Field>
        <Field label="Name (optional)">
          <TextInput value={name} onChange={setName} />
        </Field>
        <Field label="Password" hint="Min. 8 characters.">
          <TextInput
            type="password"
            value={password}
            onChange={setPassword}
            required
          />
        </Field>
        <Field label="Role">
          <RoleSelect value={role} onChange={setRole} />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions
          onCancel={onClose}
          submitLabel={busy ? "Creating…" : "Create user"}
          submitting={busy}
        />
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
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateAdminUser>[1] = {};
      if (name.trim() !== (user.name ?? "")) patch.name = name.trim();
      if (role !== user.role) patch.role = role;
      if (active !== user.active) patch.active = active;
      if (password.trim()) patch.password = password;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      await api.updateAdminUser(user.id, patch);
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
        <Field label="New password (optional)">
          <TextInput
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Leave blank to keep current"
          />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions
          onCancel={onClose}
          submitLabel={busy ? "Saving…" : "Save"}
          submitting={busy}
        />
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
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
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
    <Modal title={`Reset password — ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New password" hint="Min. 8 characters.">
          <TextInput
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoFocus
          />
        </Field>
        {error && <ErrorBanner error={error} />}
        <ModalActions
          onCancel={onClose}
          submitLabel={busy ? "Saving…" : "Reset"}
          submitting={busy}
        />
      </form>
    </Modal>
  );
}

function RolePill({ role }: { role: AuthRole }) {
  const palette: Record<AuthRole, string> = {
    admin: "bg-navy/10 text-navy",
    organiser: "bg-cyan/10 text-navy",
    user: "bg-gray-100 text-gray-700",
    guest: "bg-amber-100 text-amber-800",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${palette[role]}`}>
      {role}
    </span>
  );
}

function RoleSelect({
  value,
  onChange,
}: {
  value: AuthRole;
  onChange: (v: AuthRole) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as AuthRole)}
      className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
    >
      <option value="admin">admin</option>
      <option value="organiser">organiser</option>
      <option value="user">user</option>
      <option value="guest">guest</option>
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Nodes & Groups tab
// ─────────────────────────────────────────────────────────────────────────

function NodesTab() {
  const [groups, setGroups] = useState<ApiAdminGroup[] | null>(null);
  const [nodes, setNodes] = useState<ApiAdminNode[] | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showPubkey, setShowPubkey] = useState(false);
  const [editing, setEditing] = useState<ApiAdminNode | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, n] = await Promise.all([
        api.listAdminGroups(),
        api.listAdminNodes(),
      ]);
      setGroups(g.groups);
      setNodes(n.nodes);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visibleNodes = useMemo(() => {
    if (!nodes) return [];
    if (selectedGroupId === "all") return nodes;
    return nodes.filter((n) =>
      n.groups.some((g) => g.id === selectedGroupId),
    );
  }, [nodes, selectedGroupId]);

  function markBusy(id: string, on: boolean) {
    setBusy((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function probe(n: ApiAdminNode) {
    markBusy(`probe:${n.id}`, true);
    setBanner(null);
    try {
      const r = await api.probeAdminNode(n.id);
      setBanner(
        r.ok
          ? `${n.name}: online (${(r.output ?? "").split("\n")[0] ?? ""})`
          : `${n.name}: ${r.error ?? "offline"}`,
      );
      await refresh();
    } catch (e) {
      setBanner(`${n.name}: ${(e as Error).message}`);
    } finally {
      markBusy(`probe:${n.id}`, false);
    }
  }

  async function setupSsh(n: ApiAdminNode) {
    markBusy(`ssh:${n.id}`, true);
    setBanner(null);
    try {
      await api.sshSetupAdminNode(n.id);
      setBanner(`${n.name}: SSH key installed`);
      await refresh();
    } catch (e) {
      setBanner(`${n.name}: ${(e as Error).message}`);
    } finally {
      markBusy(`ssh:${n.id}`, false);
    }
  }

  async function deleteNode(n: ApiAdminNode) {
    if (!confirm(`Delete node ${n.name}?`)) return;
    try {
      await api.deleteAdminNode(n.id);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <SectionHeader
        title="Nodes & Groups"
        subtitle="Stations on the user's server. Group them to target syncs."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPubkey(true)}
              className="flex h-9 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
              title="Show the orchestrator's SSH public key — paste it into a node's authorized_keys to authorize it manually"
            >
              SSH pubkey
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="flex h-9 items-center gap-2 rounded-md bg-navy px-3.5 text-[13px] font-medium text-white hover:opacity-95"
            >
              <PlusIcon />
              Add node
            </button>
          </div>
        }
      />

      {error && <ErrorBanner error={error} />}
      {banner && (
        <div className="rounded-md border border-gray-200 bg-white px-4 py-2 font-mono text-[12px] text-gray-700">
          {banner}
        </div>
      )}

      <div className="flex flex-col gap-6 md:flex-row">
        <GroupsSidebar
          groups={groups ?? []}
          selectedId={selectedGroupId}
          onSelect={setSelectedGroupId}
          onChanged={refresh}
        />

        <div className="flex-1 overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-[13px]">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.06em] text-gray-500">
              <tr>
                <Th>Name</Th>
                <Th>IP</Th>
                <Th>Groups</Th>
                <Th>Model path</Th>
                <Th>Status</Th>
                <Th>Last seen</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {nodes === null && (
                <tr>
                  <td colSpan={7} className="py-8 text-center font-mono text-[11px] text-gray-400">
                    Loading…
                  </td>
                </tr>
              )}
              {nodes !== null && visibleNodes.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center font-mono text-[11px] text-gray-400">
                    No nodes in this view.
                  </td>
                </tr>
              )}
              {visibleNodes.map((n) => (
                <tr key={n.id} className="border-t border-gray-100">
                  <Td>{n.name}</Td>
                  <Td><span className="font-mono">{n.ip}</span></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {n.groups.length === 0 ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        n.groups.map((g) => (
                          <span
                            key={g.id}
                            className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700"
                          >
                            {g.name}
                          </span>
                        ))
                      )}
                    </div>
                  </Td>
                  <Td>
                    <span className="font-mono text-[11px] text-gray-600">
                      {n.modelPath}
                    </span>
                  </Td>
                  <Td><NodeStatusPill node={n} /></Td>
                  <Td>
                    <span className="font-mono text-[12px] text-gray-500">
                      {fmtDate(n.lastSeenAt)}
                    </span>
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex gap-1">
                      <RowBtn
                        disabled={busy.has(`probe:${n.id}`)}
                        onClick={() => probe(n)}
                      >
                        {busy.has(`probe:${n.id}`) ? "…" : "Probe"}
                      </RowBtn>
                      {(!n.sshKeySetup || n.status === "offline" || n.status === "error") && (
                        <RowBtn
                          disabled={busy.has(`ssh:${n.id}`)}
                          onClick={() => setupSsh(n)}
                          title={
                            n.sshKeySetup
                              ? "Re-install the orchestrator's pubkey (key rotation / probe failed)"
                              : "Install the orchestrator's pubkey using the stored password"
                          }
                        >
                          {busy.has(`ssh:${n.id}`)
                            ? "…"
                            : n.sshKeySetup
                              ? "Re-setup"
                              : "Setup SSH"}
                        </RowBtn>
                      )}
                      <RowBtn onClick={() => setEditing(n)}>Edit</RowBtn>
                      <RowBtn danger onClick={() => deleteNode(n)}>Delete</RowBtn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <NodeModal
          mode="create"
          allGroups={groups ?? []}
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            setShowAdd(false);
            await refresh();
          }}
        />
      )}
      {showPubkey && <PubkeyModal onClose={() => setShowPubkey(false)} />}
      {editing && (
        <NodeModal
          mode="edit"
          node={editing}
          allGroups={groups ?? []}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function GroupsSidebar({
  groups,
  selectedId,
  onSelect,
  onChanged,
}: {
  groups: ApiAdminGroup[];
  selectedId: string | "all";
  onSelect: (id: string | "all") => void;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAdminGroup(newName.trim());
      setNewName("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string) {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await api.updateAdminGroup(id, renameValue.trim());
      setRenamingId(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(g: ApiAdminGroup) {
    if (!confirm(`Delete group "${g.name}"? Nodes stay; only the group is removed.`)) return;
    try {
      await api.deleteAdminGroup(g.id);
      if (selectedId === g.id) onSelect("all");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function seed() {
    try {
      await api.seedDefaultGroups();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <aside className="flex w-full shrink-0 flex-col gap-2 md:w-[220px]">
      <span className="px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-gray-500">
        Groups
      </span>
      <button
        type="button"
        onClick={() => onSelect("all")}
        className={`rounded-md px-3 py-1.5 text-left text-[13px] transition-colors ${
          selectedId === "all"
            ? "bg-[rgba(79,179,217,0.12)] font-medium text-navy"
            : "text-gray-700 hover:bg-gray-50"
        }`}
      >
        All nodes
      </button>
      <div className="flex flex-col gap-0.5">
        {groups.map((g) => (
          <div
            key={g.id}
            className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
              selectedId === g.id
                ? "bg-[rgba(79,179,217,0.12)] text-navy"
                : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            {renamingId === g.id ? (
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => rename(g.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(g.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                autoFocus
                className="flex-1 rounded border border-gray-200 bg-white px-2 py-0.5 text-[13px] outline-none focus:border-cyan"
              />
            ) : (
              <button
                type="button"
                onClick={() => onSelect(g.id)}
                onDoubleClick={() => {
                  setRenameValue(g.name);
                  setRenamingId(g.id);
                }}
                className="flex flex-1 items-baseline gap-2 truncate text-left"
                title="Double-click to rename"
              >
                <span className="truncate">{g.name}</span>
                <span className="font-mono text-[11px] text-gray-400">
                  {g.nodeCount}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => remove(g)}
              aria-label={`Delete ${g.name}`}
              className="text-gray-300 hover:text-red-500"
            >
              <XIcon />
            </button>
          </div>
        ))}
      </div>
      {groups.length === 0 && (
        <button
          type="button"
          onClick={seed}
          className="mt-2 rounded-md border border-dashed border-gray-300 px-3 py-2 text-[12px] text-gray-600 hover:bg-gray-50"
        >
          Seed defaults (exo, MLX)
        </button>
      )}
      <div className="mt-2 flex gap-1">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="New group…"
          className="flex-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[13px] outline-none focus:border-cyan"
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !newName.trim()}
          className="rounded-md bg-navy px-2.5 text-[13px] text-white hover:opacity-95 disabled:opacity-40"
        >
          +
        </button>
      </div>
      {error && <span className="font-mono text-[11px] text-red-600">{error}</span>}
    </aside>
  );
}

function NodeStatusPill({ node }: { node: ApiAdminNode }) {
  let color = "bg-gray-300 text-gray-600";
  let label: string = node.status || "unknown";
  if (!node.sshKeySetup) {
    color = "bg-amber-100 text-amber-800";
    label = "setup pending";
  } else if (node.status === "online") {
    color = "bg-emerald-100 text-emerald-800";
  } else if (node.status === "offline" || node.status === "error") {
    color = "bg-red-100 text-red-700";
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${color}`}>
      {label}
    </span>
  );
}

function NodeModal({
  mode,
  node,
  allGroups,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  node?: ApiAdminNode;
  allGroups: ApiAdminGroup[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(node?.name ?? "");
  const [ip, setIp] = useState(node?.ip ?? "");
  const [sshUser, setSshUser] = useState(node?.sshUser ?? "admin");
  const [sshPassword, setSshPassword] = useState("");
  const [modelPath, setModelPath] = useState(node?.modelPath ?? "~/.exo/models");
  const [groupIds, setGroupIds] = useState<Set<string>>(
    new Set(node?.groups.map((g) => g.id) ?? []),
  );
  const [setupKey, setSetupKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        const created = await api.createAdminNode({
          name: name.trim(),
          ip: ip.trim(),
          sshUser: sshUser.trim() || undefined,
          sshPassword: sshPassword || undefined,
          modelPath: modelPath.trim(),
          groupIds: Array.from(groupIds),
        });
        if (setupKey && created.node?.id) {
          try {
            await api.sshSetupAdminNode(created.node.id);
          } catch (err) {
            setError(`Node created, but SSH setup failed: ${(err as Error).message}`);
            onSaved();
            return;
          }
        }
      } else if (node) {
        const patch: Parameters<typeof api.updateAdminNode>[1] = {
          name: name.trim(),
          ip: ip.trim(),
          sshUser: sshUser.trim(),
          modelPath: modelPath.trim(),
          groupIds: Array.from(groupIds),
        };
        if (sshPassword) patch.sshPassword = sshPassword;
        await api.updateAdminNode(node.id, patch);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleGroup(id: string) {
    setGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const presets = ["~/.exo/models", "~/mlx-models", "~/.ollama/models"];

  return (
    <Modal
      title={mode === "create" ? "Add node" : `Edit ${node?.name}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <TextInput value={name} onChange={setName} required autoFocus />
        </Field>
        <Field label="IP / hostname" hint="e.g. ultra-96.lan or 192.168.86.42">
          <TextInput value={ip} onChange={setIp} required />
        </Field>
        <Field label="SSH user">
          <TextInput value={sshUser} onChange={setSshUser} />
        </Field>
        <Field
          label={mode === "edit" ? "SSH password (replace)" : "SSH password"}
          hint="Used once for the key bootstrap, then cleared."
        >
          <TextInput
            type="password"
            value={sshPassword}
            onChange={setSshPassword}
            placeholder={mode === "edit" ? "Leave blank to keep" : ""}
          />
        </Field>
        <Field label="Model path">
          <TextInput value={modelPath} onChange={setModelPath} required />
          <div className="mt-2 flex flex-wrap gap-1">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setModelPath(p)}
                className="rounded-full border border-gray-200 px-2.5 py-0.5 font-mono text-[11px] text-gray-600 hover:bg-gray-50"
              >
                {p}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Groups">
          {allGroups.length === 0 ? (
            <span className="font-mono text-[11px] text-gray-400">
              No groups yet. Create some in the sidebar.
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allGroups.map((g) => {
                const on = groupIds.has(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                      on
                        ? "border-navy bg-navy text-white"
                        : "border-gray-200 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
        {mode === "create" && (
          <label className="flex items-center gap-2 text-[12px] text-gray-700">
            <input
              type="checkbox"
              checked={setupKey}
              onChange={(e) => setSetupKey(e.target.checked)}
            />
            Setup SSH key now (uses the password above)
          </label>
        )}
        {error && <ErrorBanner error={error} />}
        <ModalActions
          onCancel={onClose}
          submitLabel={busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
          submitting={busy}
        />
      </form>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Files / Sync tab
// ─────────────────────────────────────────────────────────────────────────

function SyncTab() {
  const [matrix, setMatrix] = useState<ApiSyncMatrixEntry[] | null>(null);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [jobs, setJobs] = useState<ApiSyncJob[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adminNodes, setAdminNodes] = useState<ApiAdminNode[]>([]);
  const [groups, setGroups] = useState<ApiAdminGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("__all__");
  // Cells selected for batch delete: key = `${nodeId}::${modelName}`
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Pre-fill payload pushed into NewSyncModal when the user clicks the
  // per-row "Sync" button. Reset to null when the modal closes.
  const [syncPrefill, setSyncPrefill] = useState<{
    modelPath: string;
    sourceNodeId?: string;
    groupId?: string;
  } | null>(null);

  const refreshMatrix = useCallback(async () => {
    setMatrixLoading(true);
    setMatrixError(null);
    try {
      const r = await api.syncMatrix();
      setMatrix(r.matrix);
    } catch (e) {
      setMatrixError((e as Error).message);
    } finally {
      setMatrixLoading(false);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const r = await api.listSyncJobs({ limit: 50 });
      setJobs(r.jobs);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshNodesGroups = useCallback(async () => {
    try {
      const [n, g] = await Promise.all([
        api.listAdminNodes(),
        api.listAdminGroups(),
      ]);
      setAdminNodes(n.nodes);
      setGroups(g.groups);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshMatrix();
    refreshJobs();
    refreshNodesGroups();
    const t = setInterval(refreshJobs, 5000);
    return () => clearInterval(t);
  }, [refreshMatrix, refreshJobs, refreshNodesGroups]);

  const active = (jobs ?? []).filter(
    (j) => j.status === "queued" || j.status === "running",
  );
  const recent = (jobs ?? [])
    .filter((j) => j.status !== "queued" && j.status !== "running")
    .slice(0, 20);

  // Apply group filter — when a group is selected, hide nodes outside it.
  const visibleNodeIds = useMemo<Set<string>>(() => {
    if (selectedGroup === "__all__") {
      return new Set(adminNodes.map((n) => n.id));
    }
    return new Set(
      adminNodes
        .filter((n) => n.groups.some((g) => g.id === selectedGroup))
        .map((n) => n.id),
    );
  }, [selectedGroup, adminNodes]);

  // Filtered matrix: only nodes in the visible set.
  const filteredMatrix = useMemo(
    () => (matrix ?? []).filter((m) => visibleNodeIds.has(m.nodeId)),
    [matrix, visibleNodeIds],
  );

  // Build the model-centric view: rows = unique model names across the
  // visible nodes, with per-node presence + size.
  type ModelRow = {
    name: string;
    /** Pick the largest size we saw for this model across nodes — gives a
     *  stable "headline size" for the row. */
    headlineSize: number;
    /** sizeBytes per node id (only nodes that have it). */
    sizeByNode: Map<string, number>;
  };
  const modelRows = useMemo<ModelRow[]>(() => {
    const map = new Map<string, ModelRow>();
    for (const node of filteredMatrix) {
      for (const m of node.models) {
        const r = map.get(m.name) ?? {
          name: m.name,
          headlineSize: 0,
          sizeByNode: new Map(),
        };
        r.sizeByNode.set(node.nodeId, m.sizeBytes);
        if (m.sizeBytes > r.headlineSize) r.headlineSize = m.sizeBytes;
        map.set(m.name, r);
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => b.headlineSize - a.headlineSize,
    );
  }, [filteredMatrix]);

  // Drop selections that no longer exist (after filter change or refresh).
  useEffect(() => {
    setSelectedCells((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        const [nodeId, name] = k.split("::");
        const node = filteredMatrix.find((n) => n.nodeId === nodeId);
        if (node && node.models.some((m) => m.name === name)) {
          next.add(k);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filteredMatrix]);

  function toggleCell(nodeId: string, modelName: string) {
    setSelectedCells((prev) => {
      const k = `${nodeId}::${modelName}`;
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectRowAll(modelName: string) {
    setSelectedCells((prev) => {
      const next = new Set(prev);
      for (const node of filteredMatrix) {
        const has = node.models.some((m) => m.name === modelName);
        if (has) next.add(`${node.nodeId}::${modelName}`);
      }
      return next;
    });
  }

  async function deleteSelected() {
    if (selectedCells.size === 0) return;
    if (
      !confirm(
        `Delete ${selectedCells.size} model file(s) across the selected nodes? This is permanent.`,
      )
    )
      return;
    // Group selections by node so we issue one batch per node.
    const byNode = new Map<string, string[]>();
    for (const k of selectedCells) {
      const [nodeId, name] = k.split("::");
      const arr = byNode.get(nodeId) ?? [];
      arr.push(name);
      byNode.set(nodeId, arr);
    }
    setDeleting(true);
    try {
      await Promise.all(
        Array.from(byNode.entries()).map(([nodeId, names]) =>
          api.deleteNodeModels(nodeId, names).catch((e) => {
            console.warn("[admin-ext] delete failed for node", nodeId, e);
          }),
        ),
      );
      setSelectedCells(new Set());
      await refreshMatrix();
    } finally {
      setDeleting(false);
    }
  }

  function syncOneRow(row: ModelRow) {
    // Pick the source: the node with the largest copy of this model. If
    // a single group is currently filtered, scope the sync to that group.
    let bestNodeId = "";
    let bestSize = -1;
    for (const [nodeId, size] of row.sizeByNode.entries()) {
      if (size > bestSize) {
        bestSize = size;
        bestNodeId = nodeId;
      }
    }
    setSyncPrefill({
      modelPath: row.name,
      sourceNodeId: bestNodeId || undefined,
      groupId: selectedGroup === "__all__" ? undefined : selectedGroup,
    });
    setShowNew(true);
  }

  return (
    <section className="flex flex-col gap-8">
      <SectionHeader
        title="Files / Sync"
        subtitle="Push model files between nodes via rsync over SSH."
        action={
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="flex h-9 items-center gap-2 rounded-md bg-navy px-3.5 text-[13px] font-medium text-white hover:opacity-95"
          >
            <PlusIcon />
            New sync
          </button>
        }
      />

      {/* Models matrix — rows=models, cols=nodes, per-cell size + delete */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="font-display text-[18px] font-light text-navy">
              Models matrix
            </h3>
            <select
              value={selectedGroup}
              onChange={(e) => setSelectedGroup(e.target.value)}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              <option value="__all__">All groups</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.nodeCount})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            {selectedCells.size > 0 && (
              <button
                type="button"
                onClick={deleteSelected}
                disabled={deleting}
                className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
              >
                {deleting
                  ? "Deleting…"
                  : `Delete selected (${selectedCells.size})`}
              </button>
            )}
            <button
              type="button"
              onClick={refreshMatrix}
              disabled={matrixLoading}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {matrixLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        {matrixError && <ErrorBanner error={matrixError} />}
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-[13px]">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.06em] text-gray-500">
              <tr>
                <Th className="w-[44px]">{/* select-all */}</Th>
                <Th className="text-left normal-case tracking-normal">
                  <span className="text-[11px] font-medium text-gray-500 uppercase tracking-[0.06em]">
                    Model
                  </span>
                </Th>
                {filteredMatrix.map((node) => (
                  <Th key={node.nodeId} className="text-center">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="font-medium text-gray-700 normal-case">
                        {node.nodeName}
                      </span>
                      <span className="font-mono text-[10px] text-gray-400 normal-case tracking-normal">
                        {node.freeBytes != null
                          ? `${formatGB(node.freeBytes)} free`
                          : "offline"}
                      </span>
                    </div>
                  </Th>
                ))}
                <Th className="w-[80px] text-center">{/* sync */}</Th>
              </tr>
            </thead>
            <tbody>
              {modelRows.length === 0 && (
                <tr>
                  <td
                    colSpan={filteredMatrix.length + 3}
                    className="py-8 text-center font-mono text-[11px] text-gray-400"
                  >
                    No models discovered yet. Set up SSH keys on your nodes,
                    then refresh.
                  </td>
                </tr>
              )}
              {modelRows.map((row) => {
                const allCellKeys = filteredMatrix
                  .filter((n) => row.sizeByNode.has(n.nodeId))
                  .map((n) => `${n.nodeId}::${row.name}`);
                const allSelected =
                  allCellKeys.length > 0 &&
                  allCellKeys.every((k) => selectedCells.has(k));
                return (
                  <tr key={row.name} className="border-t border-gray-100">
                    <Td className="w-[44px] text-center">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => {
                          if (allSelected) {
                            setSelectedCells((prev) => {
                              const next = new Set(prev);
                              for (const k of allCellKeys) next.delete(k);
                              return next;
                            });
                          } else {
                            selectRowAll(row.name);
                          }
                        }}
                        title="Select all instances of this model"
                        className="h-4 w-4 cursor-pointer rounded border-gray-300 text-navy focus:ring-cyan"
                      />
                    </Td>
                    <Td className="text-left">
                      <div className="flex flex-col">
                        <span className="font-mono text-[12px] font-medium text-ink">
                          {row.name}
                        </span>
                        <span className="font-mono text-[10px] text-gray-400">
                          {formatGB(row.headlineSize)}
                        </span>
                      </div>
                    </Td>
                    {filteredMatrix.map((node) => {
                      const size = row.sizeByNode.get(node.nodeId);
                      const cellKey = `${node.nodeId}::${row.name}`;
                      const isSelected = selectedCells.has(cellKey);
                      if (size == null) {
                        return (
                          <Td key={node.nodeId} className="text-center text-gray-300">
                            –
                          </Td>
                        );
                      }
                      return (
                        <Td key={node.nodeId} className="text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="font-mono text-[12px] text-emerald-700">
                              {formatGB(size)}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleCell(node.nodeId, row.name)}
                                title={`Select ${row.name} on ${node.nodeName} for delete`}
                                className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 text-red-600 focus:ring-red-400"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  if (
                                    confirm(
                                      `Delete ${row.name} on ${node.nodeName}?`,
                                    )
                                  ) {
                                    api
                                      .deleteNodeModels(node.nodeId, [row.name])
                                      .then(() => refreshMatrix())
                                      .catch((e) =>
                                        alert(`Delete failed: ${(e as Error).message}`),
                                      );
                                  }
                                }}
                                title={`Delete ${row.name} on ${node.nodeName}`}
                                className="text-gray-300 hover:text-red-500"
                              >
                                <TrashIcon />
                              </button>
                            </div>
                          </div>
                        </Td>
                      );
                    })}
                    <Td className="w-[80px] text-center">
                      <button
                        type="button"
                        onClick={() => syncOneRow(row)}
                        className="rounded-md border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-cyan-700 hover:border-cyan hover:bg-cyan/5"
                        title={`Sync ${row.name} to other nodes`}
                      >
                        Sync
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Active jobs */}
      <div className="flex flex-col gap-3">
        <h3 className="font-display text-[18px] font-light text-navy">
          Active sync jobs
        </h3>
        {active.length === 0 ? (
          <span className="font-mono text-[11px] text-gray-400">
            No jobs running.
          </span>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((j) => (
              <SyncJobRow
                key={j.id}
                job={j}
                expanded={expanded === j.id}
                onToggle={() => setExpanded(expanded === j.id ? null : j.id)}
                onChanged={refreshJobs}
                live
              />
            ))}
          </div>
        )}
      </div>

      {/* Recent history */}
      <div className="flex flex-col gap-3">
        <h3 className="font-display text-[18px] font-light text-navy">
          Recent history
        </h3>
        {recent.length === 0 ? (
          <span className="font-mono text-[11px] text-gray-400">
            No jobs yet.
          </span>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((j) => (
              <SyncJobRow
                key={j.id}
                job={j}
                expanded={expanded === j.id}
                onToggle={() => setExpanded(expanded === j.id ? null : j.id)}
                onChanged={refreshJobs}
              />
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewSyncModal
          prefill={syncPrefill ?? undefined}
          onClose={() => {
            setShowNew(false);
            setSyncPrefill(null);
          }}
          onStarted={(jobId) => {
            setShowNew(false);
            setSyncPrefill(null);
            setExpanded(jobId);
            refreshJobs();
          }}
        />
      )}
    </section>
  );
}

function SyncJobRow({
  job,
  expanded,
  onToggle,
  onChanged,
  live,
}: {
  job: ApiSyncJob;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  live?: boolean;
}) {
  const [log, setLog] = useState<string>(job.liveLog ?? job.log ?? "");
  const [progress, setProgress] = useState(job.progress);
  const [status, setStatus] = useState(job.status);
  const [currentTarget, setCurrentTarget] = useState<string | null>(
    job.currentTarget ?? null,
  );
  const logRef = useRef<HTMLPreElement | null>(null);

  // Subscribe to SSE while expanded + still running.
  useEffect(() => {
    if (!expanded) return;
    if (status === "done" || status === "failed" || status === "canceled") {
      // Pull the stored log once for terminal jobs.
      api.getSyncJob(job.id)
        .then((r) => {
          setLog(r.job.liveLog ?? r.job.log ?? "");
          setStatus(r.job.status);
          setProgress(r.job.progress);
        })
        .catch(() => undefined);
      return;
    }
    const cleanup = streamSyncEvents(job.id, (ev: SyncStreamEvent) => {
      if (ev.type === "snapshot" || ev.type === "progress") {
        const e = ev as { progress?: number; currentTarget?: string | null };
        if (typeof e.progress === "number") setProgress(e.progress);
        if (e.currentTarget !== undefined) setCurrentTarget(e.currentTarget ?? null);
      } else if (ev.type === "log") {
        const line = (ev as { line?: string }).line ?? "";
        setLog((prev) => prev + line + "\n");
        // Auto-scroll on next paint.
        requestAnimationFrame(() => {
          if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
          }
        });
      } else if (ev.type === "status") {
        const s = (ev as { status?: ApiSyncJob["status"] }).status;
        if (s) setStatus(s);
        onChanged();
      }
    });
    return cleanup;
  }, [expanded, job.id, status, onChanged]);

  async function cancel() {
    if (!confirm("Cancel this sync job?")) return;
    try {
      await api.cancelSync(job.id);
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        <SyncStatusPill status={status} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-2 text-[13px]">
            <span className="font-mono text-[12px] text-gray-500">
              {job.id.slice(0, 8)}
            </span>
            <span className="text-ink">{job.modelPath}</span>
            {currentTarget && live && (
              <span className="font-mono text-[11px] text-gray-500">
                → {currentTarget}
              </span>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full bg-cyan transition-all"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-[11px] font-mono text-gray-500">
          <span>{fmtDate(job.createdAt)}</span>
          <span>
            {job.targetNodeIds.length} target{job.targetNodeIds.length === 1 ? "" : "s"}
          </span>
        </div>
        {live && status === "running" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              cancel();
            }}
            className="rounded-md border border-red-200 px-2.5 py-1 text-[11px] text-red-600 hover:bg-red-50"
          >
            Cancel
          </button>
        )}
      </button>
      {expanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
          <pre
            ref={logRef}
            className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded-md bg-white px-3 py-2 font-mono text-[11px] text-gray-700"
          >
            {log || "(no output yet)"}
          </pre>
        </div>
      )}
    </div>
  );
}

function SyncStatusPill({ status }: { status: ApiSyncJob["status"] }) {
  const palette: Record<ApiSyncJob["status"], string> = {
    queued: "bg-gray-100 text-gray-600",
    running: "bg-cyan/15 text-navy",
    done: "bg-emerald-100 text-emerald-800",
    failed: "bg-red-100 text-red-700",
    canceled: "bg-gray-100 text-gray-500",
  };
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${palette[status]}`}>
      {status}
    </span>
  );
}

function NewSyncModal({
  onClose,
  onStarted,
  prefill,
}: {
  onClose: () => void;
  onStarted: (jobId: string) => void;
  prefill?: {
    modelPath?: string;
    sourceNodeId?: string;
    groupId?: string;
  };
}) {
  const [nodes, setNodes] = useState<ApiAdminNode[]>([]);
  const [groups, setGroups] = useState<ApiAdminGroup[]>([]);
  const [sourceId, setSourceId] = useState<string>(prefill?.sourceNodeId ?? "");
  const [targetMode, setTargetMode] = useState<"group" | "nodes">(
    prefill?.groupId ? "group" : "nodes",
  );
  const [groupId, setGroupId] = useState<string>(prefill?.groupId ?? "");
  const [targetIds, setTargetIds] = useState<Set<string>>(new Set());
  const [modelPath, setModelPath] = useState(prefill?.modelPath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listAdminNodes(), api.listAdminGroups()])
      .then(([n, g]) => {
        const eligible = n.nodes.filter((x) => x.sshKeySetup);
        setNodes(eligible);
        setGroups(g.groups);
        if (!sourceId && eligible.length > 0) {
          setSourceId(prefill?.sourceNodeId ?? eligible[0].id);
        }
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleTarget(id: string) {
    setTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.startSync({
        sourceNodeId: sourceId,
        targetNodeIds:
          targetMode === "nodes" ? Array.from(targetIds) : undefined,
        groupId: targetMode === "group" ? groupId || undefined : undefined,
        modelPath: modelPath.trim() || "",
      });
      onStarted(r.jobId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New sync" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Source node">
          <select
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            required
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
          >
            {nodes.length === 0 && <option value="">— no SSH-ready nodes —</option>}
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.ip})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Target">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[13px] text-gray-700">
              <input
                type="radio"
                name="targetMode"
                checked={targetMode === "group"}
                onChange={() => setTargetMode("group")}
              />
              All in group
            </label>
            {targetMode === "group" && (
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="ml-6 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
              >
                <option value="">— pick a group —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.nodeCount})
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2 text-[13px] text-gray-700">
              <input
                type="radio"
                name="targetMode"
                checked={targetMode === "nodes"}
                onChange={() => setTargetMode("nodes")}
              />
              Specific nodes
            </label>
            {targetMode === "nodes" && (
              <div className="ml-6 flex max-h-[180px] flex-col gap-1 overflow-y-auto rounded-md border border-gray-200 bg-white p-2">
                {nodes.filter((n) => n.id !== sourceId).map((n) => (
                  <label key={n.id} className="flex items-center gap-2 text-[13px] text-gray-700">
                    <input
                      type="checkbox"
                      checked={targetIds.has(n.id)}
                      onChange={() => toggleTarget(n.id)}
                    />
                    <span>{n.name}</span>
                    <span className="font-mono text-[11px] text-gray-500">{n.ip}</span>
                  </label>
                ))}
                {nodes.filter((n) => n.id !== sourceId).length === 0 && (
                  <span className="font-mono text-[11px] text-gray-400">
                    No other SSH-ready nodes available.
                  </span>
                )}
              </div>
            )}
          </div>
        </Field>

        <Field
          label="Model path"
          hint="e.g. mlx-community/gemma-4-26b-a4b-it-bf16 (relative to source's model_path) — leave blank to sync everything."
        >
          <TextInput value={modelPath} onChange={setModelPath} />
        </Field>

        {error && <ErrorBanner error={error} />}
        <ModalActions
          onCancel={onClose}
          submitLabel={busy ? "Starting…" : "Start sync"}
          submitting={busy}
        />
      </form>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Guest tokens tab
// ─────────────────────────────────────────────────────────────────────────

function GuestsTab() {
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
    refresh();
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
    <section className="flex flex-col gap-6">
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

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-[13px]">
          <thead className="bg-gray-50 text-[11px] uppercase tracking-[0.06em] text-gray-500">
            <tr>
              <Th>Label</Th>
              <Th>Budget</Th>
              <Th>Scope</Th>
              <Th>Expires</Th>
              <Th>Created</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={6} className="py-8 text-center font-mono text-[11px] text-gray-400">
                  Loading…
                </td>
              </tr>
            )}
            {rows && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center font-mono text-[11px] text-gray-400">
                  No guest tokens yet.
                </td>
              </tr>
            )}
            {rows?.map((t) => {
              const revoked = !!t.revokedAt;
              const expired = t.expiresAt && new Date(t.expiresAt).getTime() < Date.now();
              return (
                <tr key={t.id} className={`border-t border-gray-100 ${revoked || expired ? "opacity-50" : ""}`}>
                  <Td>
                    {t.label || <span className="text-gray-400">(no label)</span>}
                    {revoked && <span className="ml-2 text-[10px] text-red-600">revoked</span>}
                    {!revoked && expired && <span className="ml-2 text-[10px] text-gray-500">expired</span>}
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-gray-700">
                      {t.tokensUsed.toLocaleString()} /{" "}
                      {t.tokenBudget === 0 ? "∞" : t.tokenBudget.toLocaleString()}
                    </span>
                  </Td>
                  <Td><span className="font-mono text-[12px]">{t.scope}</span></Td>
                  <Td>
                    <span className="font-mono text-[12px] text-gray-500">
                      {fmtDate(t.expiresAt)}
                    </span>
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-gray-500">
                      {fmtDate(t.createdAt)}
                    </span>
                  </Td>
                  <Td className="text-right">
                    {!revoked && (
                      <div className="inline-flex gap-1">
                        <RowBtn onClick={() => extend(t, 7)}>+7d</RowBtn>
                        <RowBtn onClick={() => extend(t, 30)}>+30d</RowBtn>
                        <RowBtn danger onClick={() => revoke(t)}>Revoke</RowBtn>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
        <MintedTokenModal
          token={minted.token}
          onClose={() => setMinted(null)}
        />
      )}
    </section>
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
        <ModalActions
          onCancel={onClose}
          submitLabel={busy ? "Minting…" : "Mint"}
          submitting={busy}
        />
      </form>
    </Modal>
  );
}

function MintedTokenModal({ token, onClose }: { token: string; onClose: () => void }) {
  const url = `${window.location.origin}/g/${token}`;
  const [copied, setCopied] = useState<"url" | "token" | null>(null);
  async function copy(value: string, kind: "url" | "token") {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
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
        <h2 className="font-display text-[28px] font-light text-navy">
          {title}
        </h2>
        {subtitle && (
          <p className="text-[13px] text-gray-600">{subtitle}</p>
        )}
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

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left font-medium ${className}`}>
      {children}
    </th>
  );
}

function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>
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
      <span className="text-[11px] uppercase tracking-[0.04em] text-gray-500">
        {label}
      </span>
      {children}
      {hint && (
        <span className="font-mono text-[11px] text-gray-400">{hint}</span>
      )}
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

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
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
          <h3 className="font-display text-[18px] font-light text-navy">
            {title}
          </h3>
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

function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
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

/**
 * Shows the orchestrator's SSH public key. The admin can copy it and paste
 * it manually into a node's ~/.ssh/authorized_keys when the in-app SSH
 * setup flow is impractical (e.g. password no longer available, or after
 * a key rotation that orphaned previous setups). Once the pubkey is in
 * place, "Re-setup" / "Probe" should succeed without re-entering a password.
 */
function PubkeyModal({ onClose }: { onClose: () => void }) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .getOrchestratorPubkey()
      .then((r) => setPubkey(r.pubkey))
      .catch((e) => setError((e as Error).message));
  }, []);

  async function copy() {
    if (!pubkey) return;
    try {
      await navigator.clipboard.writeText(pubkey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard write failed — copy manually.");
    }
  }

  return (
    <Modal title="Orchestrator SSH public key" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-[20px] text-gray-700">
          This is the public key used by the orchestrator to authenticate to
          your nodes. Paste it into each node's{" "}
          <code className="font-mono text-[12px]">~/.ssh/authorized_keys</code>{" "}
          if the in-app SSH setup is unavailable.
        </p>

        {error && <ErrorBanner error={error} />}

        <div className="rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-[11px] break-all whitespace-pre-wrap text-ink">
          {pubkey ?? "Loading…"}
        </div>

        <details className="text-[12px] text-gray-600">
          <summary className="cursor-pointer">
            One-liner to install on a node
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-gray-900 p-3 font-mono text-[11px] text-emerald-300">
{`ssh admin@<NODE_IP> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \\
  echo '${pubkey ?? "<pubkey here>"}' >> ~/.ssh/authorized_keys && \\
  chmod 600 ~/.ssh/authorized_keys"`}
          </pre>
        </details>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={copy}
            disabled={!pubkey}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-40"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function formatGB(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 10) return `${gb.toFixed(1)} GB`;
  return `${gb.toFixed(0)} GB`;
}
