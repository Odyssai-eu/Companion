import type { Context } from "hono";
import { db } from "../db/index";
import { authLog } from "../db/schema";

/**
 * Auth event types written to the append-only `auth_log` table.
 * Add new strings here when introducing new audited events.
 */
export type AuthEvent =
  | "login.success"
  | "login.fail"
  | "logout"
  | "password.change"
  | "user.create"
  | "user.update"
  | "user.role.change"
  | "user.deactivate"
  | "user.activate"
  | "user.password.reset"
  | "role.change"
  | "guest.mint"
  | "guest.use"
  | "guest.revoke"
  | "guest.extend"
  | "node.create"
  | "node.update"
  | "node.delete"
  | "node.ssh.setup"
  | "node.probe"
  | "node.models.delete"
  | "group.create"
  | "group.update"
  | "group.delete"
  | "group.seed"
  | "sync.start"
  | "sync.cancel"
  | "sync.done"
  | "sync.failed"
  // Enterprise audit events (migration 0046)
  | "memory.read"       // project memory injected into a conversation
  | "tool.invoke"       // MCP tool called
  | "decision.create"   // decision log entry created
  | "setup.init"        // first-run operator account created
  // Confidential Guard add-on
  | "guard.flagged"       // sensitive content detected in an outgoing message
  | "guard.forced_local"; // sensitive turn re-routed to the local engine

export interface LogAuthEventInput {
  userId?: string | null;
  event: AuthEvent;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
  // Enterprise audit fields
  projectId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

/**
 * Fire-and-forget insert into auth_log. Never throws — auth-log being down
 * must not block a request. Errors are logged to the console only.
 */
export function logAuthEvent(input: LogAuthEventInput): void {
  void db
    .insert(authLog)
    .values({
      userId: input.userId ?? null,
      event: input.event,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      meta: input.meta ?? null,
      projectId: input.projectId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
    })
    .catch((err) => {
      console.error("[auth-log] insert failed:", err);
    });
}

/**
 * Pull IP + UA from a Hono request, honouring x-forwarded-for / x-real-ip.
 */
export function reqMeta(c: Context): {
  ip: string | null;
  userAgent: string | null;
} {
  const xff = c.req.header("x-forwarded-for");
  const ip =
    xff?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    null;
  const userAgent = c.req.header("user-agent") || null;
  return { ip, userAgent };
}
