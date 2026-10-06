// src/payments/stripe.js — تكامل Stripe (Checkout Sessions + التحقق من Webhook)
// مبني على REST API مباشرة بلا أي مكتبة خارجية، ويستخدم node:crypto للتحقق من التوقيع.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API_BASE = 'https://api.stripe.com/v1';
const API_VERSION = '2024-06-20';
const TOLERANCE_SECONDS = 300; // نافذة قبول التوقيع (5 دقائق)

export const isConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

export function publicConfig() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  return {
    configured: isConfigured(),
    publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    webhook_secret_set: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    mode: key.startsWith('sk_live') ? 'live' : key ? 'test' : null,
  };
}

/* ---------------------- ترميز نموذج Stripe ---------------------- */
// Stripe يقبل application/x-www-form-urlencoded مع تداخل عبر الأقواس: a[b][c]=v
function encodeForm(params, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') {
      const nested = encodeForm(value, name);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}

/* ---------------------- إنشاء جلسة دفع ---------------------- */
/**
 * ينشئ Stripe Checkout Session ويعيد رابط الدفع المستضاف.
 * المبالغ تُرسل بالوحدة الصغرى (سنتيم) — الدرهم المغربي عملة بعشرينيتين.
 */
export async function createCheckout({ payment, booking, service, salon, baseUrl, currency = 'mad' }) {
  if (!isConfigured()) throw new Error('STRIPE_SECRET_KEY غير مضبوط على الخادم.');

  const unitAmount = Math.round(Number(payment.amount) * 100);
  if (!Number.isFinite(unitAmount) || unitAmount <= 0) throw new Error('مبلغ الدفع غير صالح.');

  const label = payment.kind === 'deposit' ? 'عربون حجز' : 'دفع حجز';
  const body = encodeForm({
    mode: 'payment',
    success_url: `${baseUrl}/pay/${payment.pay_token}/done?status=success`,
    cancel_url: `${baseUrl}/pay/${payment.pay_token}/done?status=cancel`,
    client_reference_id: String(payment.id),
    locale: 'ar',
    metadata: {
      payment_id: String(payment.id),
      booking_id: String(booking.id),
      salon_id: String(salon.id),
      pay_token: payment.pay_token,
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: unitAmount,
        product_data: {
          name: `${label} — ${salon.name}`,
          description: `${service ? service.name + ' · ' : ''}${booking.date} على الساعة ${booking.time}`,
        },
      },
    }],
  });

  const res = await fetch(`${API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': API_VERSION,
    },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `فشل إنشاء جلسة الدفع في Stripe (${res.status})`);
  }
  return { id: data.id, url: data.url, expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null };
}

/* ---------------------- استرجاع جلسة (تحقق مستقل) ---------------------- */
export async function retrieveSession(sessionId) {
  if (!isConfigured()) throw new Error('STRIPE_SECRET_KEY غير مضبوط على الخادم.');
  const res = await fetch(`${API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': API_VERSION,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || 'تعذّر استرجاع جلسة الدفع.');
  return data;
}

/* ---------------------- التحقق من توقيع Webhook ---------------------- */
/**
 * يتحقق من ترويسة Stripe-Signature ويتأكد أن الطلب صادر فعلاً عن Stripe.
 * الصيغة: t=<timestamp>,v1=<hmac_sha256(secret, "timestamp.rawBody")>
 */
export function verifySignature(rawBody, signatureHeader, secret = process.env.STRIPE_WEBHOOK_SECRET, tolerance = TOLERANCE_SECONDS) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET غير مضبوط على الخادم.');
  if (!signatureHeader) throw new Error('ترويسة التوقيع Stripe-Signature مفقودة.');

  const parsed = {};
  for (const chunk of String(signatureHeader).split(',')) {
    const idx = chunk.indexOf('=');
    if (idx < 0) continue;
    const k = chunk.slice(0, idx).trim();
    const v = chunk.slice(idx + 1).trim();
    (parsed[k] ||= []).push(v);
  }

  const timestamp = parsed.t?.[0];
  const signatures = parsed.v1 || [];
  if (!timestamp || signatures.length === 0) throw new Error('ترويسة التوقيع غير صالحة.');

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw new Error('طابع زمني غير صالح في التوقيع.');
  if (Math.abs(Date.now() / 1000 - ts) > tolerance) throw new Error('التوقيع منتهي الصلاحية (إعادة إرسال محتملة).');

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  const matched = signatures.some((sig) => {
    try {
      const got = Buffer.from(sig, 'hex');
      return got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf);
    } catch { return false; }
  });
  if (!matched) throw new Error('توقيع Webhook غير مطابق.');

  try { return JSON.parse(rawBody); }
  catch { throw new Error('محتوى Webhook ليس JSON صالحاً.'); }
}

/* ---------------------- استخراج بيانات الدفع من الحدث ---------------------- */
/** يحوّل حدث Stripe إلى وصف موحّد تفهمه طبقة الدفع. */
export function interpretEvent(event) {
  const type = event?.type || '';
  const object = event?.data?.object || {};

  const paymentId = Number(object?.metadata?.payment_id || 0) || null;
  const token = object?.metadata?.pay_token || null;

  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    return {
      kind: 'paid',
      paymentId,
      token,
      ref: object.id,
      amountMinor: object.amount_total,
      currency: object.currency,
      method: object.payment_method_types?.[0] || 'card',
      email: object.customer_details?.email || null,
    };
  }
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    return { kind: 'failed', paymentId, token, ref: object.id, reason: type };
  }
  if (type === 'charge.refunded') {
    return { kind: 'refunded', paymentId, token, ref: object.id, amountMinor: object.amount_refunded };
  }
  return { kind: 'ignored', type, paymentId, token };
}
