-- Project sharing consent: a project must explicitly opt in to being
-- linkable via `tcai://project/<uuid>` from other projects. Default
-- false so a fresh project is private; the user flips it on when
-- they want a hub.
--
-- Without this flag, anyone with the project UUID (same user) could
-- read the corpus. Practically low risk in a single-tenant deployment,
-- but the explicit toggle keeps intent clear and makes accidental
-- cross-pollination impossible.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sharing_enabled boolean
  NOT NULL DEFAULT false;
