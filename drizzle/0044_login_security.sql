-- 0044_login_security.sql
-- Add password_changed_at to users so JWT tokens issued before a password
-- change can be rejected server-side (session revocation without a sessions
-- table). Default = now() so existing rows are treated as "password never
-- changed" and existing tokens remain valid on upgrade.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_changed_at
    timestamp with time zone NOT NULL DEFAULT now();
