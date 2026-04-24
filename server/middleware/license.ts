import type { MiddlewareHandler } from "hono";

/**
 * License gate for /api/*. In dev (`DEV_LICENSE_BYPASS=1`) every call is
 * allowed through. In prod, callers must present `Authorization: Bearer <token>`;
 * the token is validated against the license server (TODO — stubbed to reject
 * for now so we notice as soon as bypass is missing).
 */
export const licenseGate: MiddlewareHandler = async (c, next) => {
  if (process.env.DEV_LICENSE_BYPASS === "1") {
    await next();
    return;
  }

  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) {
    return c.json(
      { error: "license_required", detail: "Missing Authorization header." },
      401,
    );
  }

  const valid = await verifyLicense(token).catch(() => false);
  if (!valid) {
    return c.json(
      { error: "license_invalid", detail: "Token rejected by license server." },
      401,
    );
  }

  await next();
};

async function verifyLicense(_token: string): Promise<boolean> {
  // TODO wire up to api.thecomp.ai/license/validate.
  // Until that lands, block everything that's not the dev bypass — this
  // prevents silently shipping an unauthenticated build.
  return false;
}
