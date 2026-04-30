/**
 * Public guest endpoints. Currently only /session, used by the client
 * after it loads with a `?g=<token>` URL to display the remaining budget
 * and expiry. Auth is the guest token itself (header / query / cookie),
 * resolved by `guestSessionLoader` mounted upstream.
 */

import { Hono } from "hono";
import { requireUserOrGuest } from "../middleware/guest";

const guestRoute = new Hono();

// /session is gated by guest-or-user so an admin testing a token via
// browser cookie still gets a meaningful answer.
guestRoute.get("/session", requireUserOrGuest, (c) => {
  const guest = c.get("guest");
  if (!guest) {
    // Real-user session — no guest snapshot to return.
    return c.json({ error: "not_a_guest" }, 400);
  }
  return c.json({
    ok: true,
    scope: guest.scope,
    tokenBudget: guest.tokenBudget,
    tokensUsed: guest.tokensUsed,
    expiresAt: guest.expiresAt,
  });
});

export default guestRoute;
