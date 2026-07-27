import type { ApiGlobalModel } from "~/lib/api";

/**
 * Label for one row of a default-model <select>.
 *
 * `/api/models` names a Telemak entry after its cluster ("Telemak",
 * "teleFast") and lets the concrete model ride along in the capabilities, on
 * the assumption that the client renders a subtitle. The chat dropdown does;
 * a native <option> cannot. So a cluster serving two models produced two rows
 * spelled identically, with no way to tell which was which.
 *
 * `alias_for` is the model actually behind the alias. The vendor prefix is
 * dropped ("mlx-community/Laguna-XS-2.1-8bit" -> "Laguna-XS-2.1-8bit"): it is
 * the same for nearly every entry, so it costs width without separating
 * anything. Appended only when it adds information — a row already named
 * after its model stays as it is.
 *
 * Shared by Settings → Inference (the per-user override) and Settings →
 * Admin → Instance settings (the inherited default): both selects must
 * spell a given model identically or the inheritance story stops being
 * readable.
 */
export function modelOptionLabel(m: ApiGlobalModel): string {
  const concrete = m.odyssai?.alias_for?.split("/").pop()?.trim();
  if (!concrete || concrete === m.name) return m.name;
  if (m.name.toLowerCase().includes(concrete.toLowerCase())) return m.name;
  return `${m.name} — ${concrete}`;
}
