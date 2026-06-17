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
import { webLoginTelegramOidc, webLoginWidget } from "@/lib/web-auth.functions";

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

type TgOidcResult = {
  id_token?: string;
  error?: string;
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

function loadTelegramOidcSdk() {
  return new Promise<void>((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("Browser required"));
    if (window.Telegram?.Login?.auth) return resolve();
    const existing = document.getElementById("telegram-oidc-sdk") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Telegram login failed to load")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = "telegram-oidc-sdk";
    s.src = "https://oauth.telegram.org/js/telegram-login.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Telegram login failed to load"));
    document.head.appendChild(s);
  });
}

function AuthPage() {
  const { user, signInWithWebToken } = useSession();
  const navigate = useNavigate();
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

  const completeOidcLogin = useCallback(
    async (idToken: string) => {
      setBusy(true);
      try {
        const r = await webLoginTelegramOidc({ data: { idToken } });
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

  useEffect(() => {
    void loadTelegramOidcSdk().catch(() => undefined);
  }, []);

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
      if (typeof decoded.id_token === "string") {
        void completeOidcLogin(decoded.id_token);
        return;
      }
      void completeLogin(tgUserToData(decoded));
    } catch {
      toast.error("Could not read Telegram response. Please try again.");
    }
  }, [completeLogin, completeOidcLogin]);

  const openTelegramOAuth = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (busy) return;
    setBusy(true);
    try {
      await loadTelegramOidcSdk();
      const login = window.Telegram?.Login;
      if (!login?.auth) throw new Error("Telegram login is not ready. Please try again.");
      login.auth(
        {
          client_id: BOT_ID,
          request_access: ["phone", "write"],
          lang: navigator.language?.slice(0, 2) || "en",
          nonce: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        },
        (result: TgOidcResult) => {
          if (result.error) {
            setBusy(false);
            if (result.error !== "popup_closed") toast.error(result.error);
            return;
          }
          if (!result.id_token) {
            setBusy(false);
            toast.error("Telegram did not return login proof. Please try again.");
            return;
          }
          void completeOidcLogin(result.id_token);
        },
      );
    } catch (e) {
      setBusy(false);
      toast.error(e instanceof Error ? e.message : "Telegram login failed");
    }
  }, [busy, completeOidcLogin]);

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
