/**
 * Browser sign-in route.
 *  - Telegram Login Widget (preferred): user clicks, confirms in their
 *    Telegram app, we verify the HMAC and issue a web session.
 *  - Visible fallback button that uses Telegram's OAuth redirect flow
 *    (oauth.telegram.org). This works on mobile browsers and other
 *    environments where the embedded widget iframe does not render.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { GoldFrame } from "@/components/gold-ui";
import { useSession } from "@/lib/session";
import { webLoginWidget } from "@/lib/web-auth.functions";

const BOT_USERNAME = "GTCgames_bot";
// Numeric bot id (first segment of the bot token). Required for the
// oauth.telegram.org redirect flow used by the fallback button.
const BOT_ID = 8989647034;

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · Flapy GTech" },
      { name: "description", content: "Sign in with Telegram to play Flapy GTech in your browser." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

type TgUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

declare global {
  interface Window {
    onTelegramAuthGtech?: (u: TgUser) => void;
  }
}

const REDIRECT_SECONDS = 3;

function tgUserToData(tg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  Object.entries(tg).forEach(([k, v]) => {
    if (v != null) out[k] = String(v);
  });
  return out;
}

function AuthPage() {
  const { user, signInWithWebToken } = useSession();
  const navigate = useNavigate();
  const widgetHost = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Countdown → redirect into the app.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      void navigate({ to: "/" });
      return;
    }
    const t = setTimeout(() => setCountdown((n) => (n ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, navigate]);

  // Already signed in (returning visit) → go straight to home.
  useEffect(() => {
    if (user && countdown === null) {
      void navigate({ to: "/" });
    }
  }, [user, countdown, navigate]);

  const completeLogin = useCallback(
    async (widgetData: Record<string, string>) => {
      setBusy(true);
      try {
        const r = await webLoginWidget({ data: { widgetData } });
        await signInWithWebToken(r.token);
        toast.success("Signed in with Telegram");
        setCountdown(REDIRECT_SECONDS);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Sign in failed");
      } finally {
        setBusy(false);
      }
    },
    [signInWithWebToken],
  );

  // Handle return from oauth.telegram.org redirect flow.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash || "";
    const match = hash.match(/tgAuthResult=([^&]+)/);
    if (!match) return;
    try {
      let b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const decoded = JSON.parse(atob(b64)) as Record<string, unknown>;
      // Clean hash so refreshes don't re-trigger.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void completeLogin(tgUserToData(decoded));
    } catch {
      toast.error("Could not read Telegram response. Please try again.");
    }
  }, [completeLogin]);

  // Mount Telegram Login Widget (best-effort).
  useEffect(() => {
    if (!widgetHost.current) return;
    widgetHost.current.innerHTML = "";

    window.onTelegramAuthGtech = (tg) => {
      void completeLogin(tgUserToData(tg as unknown as Record<string, unknown>));
    };

    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", BOT_USERNAME);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "8");
    s.setAttribute("data-onauth", "onTelegramAuthGtech(user)");
    s.setAttribute("data-request-access", "write");
    widgetHost.current.appendChild(s);

    return () => {
      delete window.onTelegramAuthGtech;
    };
  }, [completeLogin]);

  // Fallback: open Telegram OAuth in a new tab / redirect on the same page.
  // This always works on mobile and avoids the silent-iframe issue where the
  // embedded widget renders nothing.
  const openTelegramOAuth = useCallback(() => {
    if (typeof window === "undefined") return;
    const origin = window.location.origin;
    const returnTo = window.location.origin + "/auth";
    const url =
      `https://oauth.telegram.org/auth?bot_id=${BOT_ID}` +
      `&origin=${encodeURIComponent(origin)}` +
      `&return_to=${encodeURIComponent(returnTo)}` +
      `&request_access=write`;
    window.location.href = url;
  }, []);

  return (
    <div className="min-h-screen bg-background bg-circuit flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <GoldFrame glow className="p-6 text-center">
          <h1 className="font-display text-3xl text-gradient-gold">Flapy GTech</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to play in your browser. Your Telegram account links to your existing
            progress and balance.
          </p>

          {countdown !== null ? (
            <div className="mt-6 space-y-3">
              <div className="font-display text-5xl text-gradient-gold">{countdown}</div>
              <p className="text-sm text-gold-soft">
                Signed in! Redirecting to the app…
              </p>
              <button
                onClick={() => void navigate({ to: "/" })}
                className="w-full rounded-md bg-gradient-gold-flat px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                Go now
              </button>
            </div>
          ) : (
            <>
              {/* Always-visible primary action — works even if the embedded
                  Telegram widget iframe fails to render. */}
              <button
                type="button"
                onClick={openTelegramOAuth}
                disabled={busy}
                className="mt-6 w-full rounded-md bg-gradient-gold-flat px-4 py-3 text-base font-semibold text-primary-foreground shadow-md disabled:opacity-60"
              >
                {busy ? "Signing in…" : "Login with Telegram"}
              </button>

              {/* Embedded widget (best-effort). Hidden visually when it
                  fails; the button above is the primary entry point. */}
              <div className="mt-4 flex items-center justify-center" aria-busy={busy}>
                <div ref={widgetHost} />
              </div>

              <p className="mt-4 text-[11px] text-muted-foreground">
                Click the button above. Telegram will ask for your phone number and send a
                Confirm / Decline message to your Telegram app to authorize the login.
              </p>
            </>
          )}
        </GoldFrame>

        <p className="mt-4 text-center text-[10px] text-muted-foreground">
          Want to play without an account?{" "}
          <a href="/trial" className="text-gold-soft underline">
            Trial Access
          </a>
        </p>
      </motion.div>
    </div>
  );
}
