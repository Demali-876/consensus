import crypto from 'node:crypto';
import NodeStore from '../data/node_store.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value) && value.length <= 256;
}

export async function startEmailVerification(email: string): Promise<{ verification_id: string; expires_at: number; dev_code?: string }> {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) throw new Error('Invalid email address');

  const code = String(crypto.randomInt(100000, 1000000));
  const verification = NodeStore.createEmailVerification({
    email: normalized,
    code_hash: hashCode(code),
    ttlSeconds: 10 * 60,
  });

  await sendVerificationEmail(normalized, code);

  return {
    verification_id: verification.id,
    expires_at: verification.expires_at,
    dev_code: process.env.NODE_ENV === 'production' ? undefined : code,
  };
}

export function verifyEmailCode(input: { verification_id: string; email: string; code: string }): { email: string; token: string; expires_at: number } {
  const normalized = normalizeEmail(input.email);
  const verification = NodeStore.getEmailVerification(input.verification_id);
  if (!verification) throw new Error('Email verification not found');
  if (verification.consumed_at != null) throw new Error('Email verification already consumed');
  if (verification.expires_at < Math.floor(Date.now() / 1000)) throw new Error('Email verification expired');
  if (verification.email !== normalized) throw new Error('Email verification email mismatch');
  if (verification.attempts >= 5) throw new Error('Email verification attempt limit exceeded');

  if (verification.code_hash !== hashCode(input.code.trim())) {
    NodeStore.incrementEmailVerificationAttempts(input.verification_id);
    throw new Error('Invalid email verification code');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  NodeStore.consumeEmailVerification(input.verification_id, hashToken(token));
  return {
    email: normalized,
    token,
    expires_at: verification.expires_at,
  };
}

export function assertEmailVerification(input: { email: string; token?: string | null }): void {
  const normalized = normalizeEmail(input.email);
  if (!input.token) throw new Error('email_verification_token is required');
  const verification = NodeStore.getEmailVerificationByToken(hashToken(input.token));
  if (!verification) throw new Error('Email verification token not found');
  if (verification.email !== normalized) throw new Error('Email verification token email mismatch');
  if (verification.expires_at < Math.floor(Date.now() / 1000)) throw new Error('Email verification token expired');
}

function normalizeEmail(email: string): string {
  return String(email).trim().toLowerCase();
}

function hashCode(code: string): string {
  return crypto.createHash('sha256')
    .update(`${process.env.EMAIL_VERIFICATION_SECRET ?? 'dev-email-secret'}:${code}`)
    .digest('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256')
    .update(`${process.env.EMAIL_VERIFICATION_SECRET ?? 'dev-email-secret'}:${token}`)
    .digest('hex');
}

async function sendVerificationEmail(email: string, code: string): Promise<void> {
  const accountId = process.env.ZOHO_MAIL_ACCOUNT_ID;
  const from = process.env.ZOHO_MAIL_FROM;
  const accessToken = await getZohoAccessToken();

  if (!accountId || !from || !accessToken) {
    console.warn(`[Email] Zoho not configured; verification code for ${email}: ${code}`);
    return;
  }

  const mailBaseUrl = trimTrailingSlash(process.env.ZOHO_MAIL_API_BASE_URL ?? 'https://mail.zoho.com');
  const response = await fetch(`${mailBaseUrl}/api/accounts/${encodeURIComponent(accountId)}/messages`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Zoho-oauthtoken ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fromAddress: from,
      toAddress: email,
      subject: 'Welcome to Consensus - verify your email',
      content: [
        'Welcome to Consensus.',
        '',
        `Your node verification code is ${code}.`,
        'This code expires in 10 minutes.',
      ].join('\n'),
      mailFormat: 'plaintext',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Zoho email send failed: HTTP ${response.status} ${detail}`);
  }
}

let cachedZohoToken: { accessToken: string; expiresAtMs: number } | null = null;

async function getZohoAccessToken(): Promise<string | null> {
  if (cachedZohoToken && cachedZohoToken.expiresAtMs > Date.now() + 60_000) {
    return cachedZohoToken.accessToken;
  }

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const accountsBaseUrl = trimTrailingSlash(process.env.ZOHO_ACCOUNTS_BASE_URL ?? 'https://accounts.zoho.com');
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`${accountsBaseUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = await response.json().catch(() => null) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  } | null;

  if (!response.ok || !parsed?.access_token) {
    throw new Error(`Zoho token refresh failed: HTTP ${response.status} ${parsed?.error ?? ''}`.trim());
  }

  const expiresInSeconds = Number.isFinite(parsed.expires_in) ? Number(parsed.expires_in) : 3600;
  cachedZohoToken = {
    accessToken: parsed.access_token,
    expiresAtMs: Date.now() + Math.max(60, expiresInSeconds) * 1000,
  };
  return cachedZohoToken.accessToken;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
