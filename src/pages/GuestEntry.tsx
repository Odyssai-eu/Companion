/**
 * Guest landing — `/g/:token`. Stores the token in localStorage and a cookie
 * (so the backend's guestSessionLoader can pick it up automatically), then
 * validates against /api/guest/session and either redirects to chat or
 * renders an error state.
 */

import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";

const TOKEN_LS_KEY = "companion:guestToken";
const COOKIE_NAME = "tcg";

type State = "validating" | "ok" | "invalid";

export default function GuestEntry() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>("validating");

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }

    // Persist for the chat client (LS) and for the server (cookie).
    try {
      localStorage.setItem(TOKEN_LS_KEY, token);
    } catch {
      /* ignore — private browsing, etc. */
    }
    document.cookie =
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; Max-Age=2592000`;

    // Validate against /api/guest/session.
    fetch("/api/guest/session", {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "same-origin",
    })
      .then((r) => {
        if (r.ok) setState("ok");
        else setState("invalid");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  if (state === "ok") {
    return <Navigate to="/" replace />;
  }

  if (state === "invalid") {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center">
        <h1 className="font-display text-[36px] font-light text-navy">
          Guest link unavailable
        </h1>
        <p className="max-w-[440px] text-[14px] text-gray-600">
          This guest link is invalid, expired, or revoked. Ask the person
          who shared it for a new one.
        </p>
        <Link
          to="/login"
          className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          Sign in instead
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-gray-50">
      <span className="font-mono text-[11px] text-gray-400">…</span>
    </div>
  );
}
