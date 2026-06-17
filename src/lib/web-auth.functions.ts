/**
 * Browser authentication server functions.
 *
 * Two flows:
 *   1. Telegram Login Widget — verifies HMAC against the bot token, links to
 *      an existing users row by telegram_id or creates a new one.
 *   2. Phone OTP via Telegram Gateway — sends a verification code through
 *      Telegram's Verification API, links to an existing users row by phone
 *      or creates a phone-only user (synthetic negative telegram_id).
 *
 * Both flows persist a session token in public.web_sessions. The token is
 * sent to other server functions as `web:<token>` in place of Telegram
 * initData (see auth-helpers.server.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash, createHmac, randomBytes } from "crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { supabaseAdmin as _supabaseAdmin } from "@/integrations/supabase/client.server";

// New tables/columns (web_sessions, users.phone, admins.phone) are added by
// docs/browser-auth-migration.sql but not yet reflected in generated types.
// Cast to bypass the type checker; runtime is correct.
const db = _supabaseAdmin as unknown as {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, v: unknown) => {
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
        single: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
    insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (row: Record<string, unknown>) => {
      eq: (col: string, v: unknown) => Promise<{ error: unknown }>;
    };
    delete: () => {
      eq: (col: string, v: unknown) => Promise<{ error: unknown }>;
    };
  };
};

const BOT_TOKEN_FALLBACK = "8989647034:AAGGyGXPXyhb89PZxjc-pbet3G2b3tUQEvs";
const TELEGRAM_CLIENT_ID_FALLBACK = "8989647034";
const TELEGRAM_ISSUER = "https://oauth.telegram.org";
const TELEGRAM_JWKS = createRemoteJWKSet(new URL("https://oauth.telegram.org/.well-known/jwks.json"));

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || BOT_TOKEN_FALLBACK;
}

function telegramClientId() {
  return process.env.TELEGRAM_OIDC_CLIENT_ID || process.env.TELEGRAM_CLIENT_ID || TELEGRAM_CLIENT_ID_FALLBACK;
}

function newSessionToken() {
  return randomBytes(32).toString("hex");
}

/** Verify Telegram Login Widget signature. */
function verifyWidget(data: Record<string, string>) {
  const { hash, ...rest } = data;
  if (!hash) return null;
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken()).digest();
  const hmac = createHmac("sha256", secret).update(checkString).digest("hex");
  if (hmac !== hash) return null;
  const authDate = Number(rest.auth_date ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 60 * 60 * 24 * 7) return null;
  const id = Number(rest.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    username: rest.username || null,
    first_name: rest.first_name || null,
    last_name: rest.last_name || null,
    photo_url: rest.photo_url || null,
  };
}

/** Best-effort referrer credit (mirrors auth.functions ts logic for new users). */
async function creditReferrer(referrerId: number, newUserDisplay: string) {
  const { data: settingRow } = await db
    .from("settings")
    .select("value")
    .eq("key", "refer_reward_gtc")
    .maybeSingle();
  const reward = Number(settingRow?.value ?? 50);
  await db.from("referrals").insert({
    referrer_id: referrerId,
    referred_id: 0, // not applicable for non-tg users
    reward_gtc: reward,
  });
  const { data: refRow } = await db
    .from("users")
    .select("balance_gtc")
    .eq("telegram_id", referrerId)
    .single();
  const newBal = Number(refRow?.balance_gtc ?? 0) + reward;
  await db.from("users").update({ balance_gtc: newBal }).eq("telegram_id", referrerId);
  await db.from("transactions").insert({
    user_id: referrerId,
    kind: "referral_bonus",
    amount_gtc: reward,
    balance_after: newBal,
    note: `Referred ${newUserDisplay}`,
  });
}

async function issueSession(userId: number) {
  const token = newSessionToken();
  await db.from("web_sessions").insert({ token, user_id: userId });
  return token;
}

function normalizePhone(phone: unknown) {
  if (typeof phone !== "string") return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\s()-]/g, "");
}

function phoneVariants(phone: string) {
  const bare = phone.replace(/^\+/, "");
  return Array.from(new Set([phone, bare, `+${bare}`]));
}

async function findUserByPhone(phone: string) {
  for (const candidate of phoneVariants(phone)) {
    const { data } = await db
      .from("users")
      .select("telegram_id")
      .eq("phone", candidate)
      .maybeSingle();
    if (data?.telegram_id != null) return Number(data.telegram_id);
  }
  return null;
}

// ───────────────────────── Telegram Login Widget ─────────────────────────

const WidgetSchema = z.object({
  widgetData: z.record(z.string(), z.string()),
});

export const webLoginWidget = createServerFn({ method: "POST" })
  .inputValidator((input) => WidgetSchema.parse(input))
  .handler(async ({ data }) => {
    const u = verifyWidget(data.widgetData);
    if (!u) throw new Error("Telegram signature invalid or expired. Try again.");

    const { data: existing } = await db
      .from("users")
      .select("telegram_id")
      .eq("telegram_id", u.id)
      .maybeSingle();

    if (!existing) {
      await db.from("users").insert({
        telegram_id: u.id,
        username: u.username,
        first_name: u.first_name,
        last_name: u.last_name,
        photo_url: u.photo_url,
      });
    } else {
      await db
        .from("users")
        .update({
          username: u.username,
          first_name: u.first_name,
          last_name: u.last_name,
          photo_url: u.photo_url,
          last_seen: new Date().toISOString(),
        })
        .eq("telegram_id", u.id);
    }

    const token = await issueSession(u.id);
    return { token, telegramId: u.id };
  });

// ───────────────────────── Telegram OIDC phone login ─────────────────────────

const OidcSchema = z.object({
  idToken: z.string().min(20).max(8192),
});

type TelegramOidcPayload = JWTPayload & {
  id?: number | string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  phone_number?: string;
};

export const webLoginTelegramOidc = createServerFn({ method: "POST" })
  .inputValidator((input) => OidcSchema.parse(input))
  .handler(async ({ data }) => {
    const { payload } = await jwtVerify(data.idToken, TELEGRAM_JWKS, {
      issuer: TELEGRAM_ISSUER,
      audience: telegramClientId(),
      clockTolerance: 60,
    });
    const p = payload as TelegramOidcPayload;
    const telegramId = Number(p.id ?? p.sub);
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
      throw new Error("Telegram login did not return a valid user id.");
    }

    const phone = normalizePhone(p.phone_number);
    if (!phone) throw new Error("Please allow Telegram to share your phone number to continue.");
    const existingByPhone = phone ? await findUserByPhone(phone) : null;
    const { data: existingById } = await db
      .from("users")
      .select("telegram_id")
      .eq("telegram_id", telegramId)
      .maybeSingle();
    const sessionUserId = existingById?.telegram_id != null ? telegramId : existingByPhone ?? telegramId;
    const profile = {
      username: p.preferred_username ?? null,
      first_name: p.name ?? null,
      last_name: null,
      photo_url: p.picture ?? null,
      phone,
      last_seen: new Date().toISOString(),
    };

    if (existingById || existingByPhone) {
      await db.from("users").update(profile).eq("telegram_id", sessionUserId);
    } else {
      await db.from("users").insert({ telegram_id: telegramId, ...profile });
    }

    const token = await issueSession(sessionUserId);
    return { token, telegramId: sessionUserId };
  });

// ───────────────────────── Logout ─────────────────────────

const LogoutSchema = z.object({ token: z.string().min(1).max(128) });

export const webLogout = createServerFn({ method: "POST" })
  .inputValidator((input) => LogoutSchema.parse(input))
  .handler(async ({ data }) => {
    await db.from("web_sessions").delete().eq("token", data.token);
    return { ok: true };
  });
