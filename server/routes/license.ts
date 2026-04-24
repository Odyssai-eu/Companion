import { Hono } from "hono";

const licenseRoute = new Hono();

licenseRoute.get("/check", (c) => {
  if (process.env.DEV_LICENSE_BYPASS === "1") {
    return c.json({ valid: true, tier: "dev", bypass: true });
  }
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return c.json({ valid: false, reason: "missing_token" });
  return c.json({ valid: false, reason: "verification_not_implemented" });
});

export default licenseRoute;
