// src/auth.js — تشفير كلمات المرور (scrypt) ورموز الجلسة (JWT HS256) بلا مكتبات
import crypto from 'node:crypto';

const SECRET = process.env.HAJZI_SECRET || 'hajzi-dev-secret-change-me';
const TTL_SECONDS = 60 * 60 * 24 * 7; // أسبوع

/* -------------------- كلمات المرور -------------------- */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const test = crypto.scryptSync(String(plain), salt, 32);
  const known = Buffer.from(key, 'hex');
  return test.length === known.length && crypto.timingSafeEqual(test, known);
}

/* -------------------- رموز التحقق (OTP) -------------------- */

/** يولّد رمزاً رقمياً عشوائياً آمناً (افتراضياً 6 أرقام). */
export function generateOtp(digits = 6) {
  const max = 10 ** Math.min(Math.max(4, digits), 8);
  return String(crypto.randomInt(0, max)).padStart(Math.min(Math.max(4, digits), 8), '0');
}

/** سرّ عشوائي (يُستعمل لكلمات مرور الحسابات المُنشأة عبر واتساب). */
export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** بصمة رمز الـ OTP — مربوطة بالرقم لمنع إعادة استخدام الرمز على رقم آخر. */
export function hashOtp(code, phone) {
  return crypto.createHmac('sha256', SECRET).update(`otp:${phone}:${code}`).digest('hex');
}

/** مقارنة آمنة (timing-safe) لرمز الـ OTP. */
export function verifyOtpHash(code, phone, stored) {
  if (!stored) return false;
  const expected = Buffer.from(hashOtp(String(code), String(phone)));
  const known = Buffer.from(String(stored));
  return expected.length === known.length && crypto.timingSafeEqual(expected, known);
}

/* -------------------- JWT -------------------- */
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function createToken(payload, ttl = TTL_SECONDS) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttl }));
  const data = `${header}.${body}`;
  return `${data}.${sign(data)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = sign(data);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
