// src/payments/index.js — طبقة الدفع الموحّدة: اختيار المزوّد، بدء الدفع، ومعالجة الإشعارات
import { randomBytes } from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';
import { isoNow } from '../util.js';
import * as stripe from './stripe.js';
import * as cmi from './cmi.js';

export const PROVIDERS = ['simulated', 'stripe', 'cmi'];
export { setSetting };

/* ================================================================== */
/*  الإعداد والمزوّد الحالي                                            */
/* ================================================================== */
export function currentProvider() {
  const p = getSetting('payment_provider', process.env.HAJZI_PAYMENT_PROVIDER || 'simulated');
  return PROVIDERS.includes(p) ? p : 'simulated';
}

export function publicBaseUrl() {
  // أولوية: إعداد مخزّن ← متغير صريح ← رابط منصة الاستضافة ← localhost
  const platformUrl = process.env.RENDER_EXTERNAL_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '');
  const raw = getSetting('public_base_url') || process.env.HAJZI_PUBLIC_URL || platformUrl || `http://localhost:${process.env.PORT || 4173}`;
  return String(raw).replace(/\/+$/, '');
}

/** حالة المزوّدين — بلا أي مفاتيح سرّية، فقط هل تم ضبطها. */
export function providerStatus() {
  return {
    provider: currentProvider(),
    available: PROVIDERS,
    public_base_url: publicBaseUrl(),
    stripe: stripe.publicConfig(),
    cmi: cmi.publicConfig(),
  };
}

/** هل المزوّد المطلوب جاهز فعلاً للاستخدام؟ */
export function providerReady(provider = currentProvider()) {
  if (provider === 'simulated') return true;
  if (provider === 'stripe') return stripe.isConfigured() && Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  if (provider === 'cmi') return cmi.isConfigured();
  return false;
}

/* ================================================================== */
/*  رموز الدفع الآمنة                                                  */
/* ================================================================== */
export const newPayToken = () => randomBytes(24).toString('hex');

export function findPaymentByToken(token) {
  if (!token || !/^[a-f0-9]{16,64}$/.test(String(token))) return null;
  return db.prepare('SELECT * FROM payments WHERE pay_token = ?').get(String(token)) || null;
}

/** يعيد رمز الدفع للدفعة، وينشئه إن لم يكن موجوداً (مع تثبيت المزوّد الحالي). */
export function ensurePayToken(paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return null;
  if (p.pay_token) return p.pay_token;
  const token = newPayToken();
  db.prepare('UPDATE payments SET pay_token = ?, provider = ?, updated_at = ? WHERE id = ?')
    .run(token, currentProvider(), isoNow(), paymentId);
  return token;
}

/** سياق كامل للدفع (دفعة + حجز + خدمة + صالون) لصفحة الدفع. */
export function paymentContext(payment) {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(payment.booking_id);
  if (!booking) return null;
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(booking.service_id);
  const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(booking.salon_id);
  const staff = booking.staff_id ? db.prepare('SELECT * FROM staff WHERE id = ?').get(booking.staff_id) : null;
  const paid = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE booking_id = ? AND status = 'paid' AND kind != 'refund'"
  ).get(booking.id).s;
  return { payment, booking, service, salon, staff, paidAmount: paid };
}

/* ================================================================== */
/*  سجل الأحداث (منع التكرار + تدقيق)                                  */
/* ================================================================== */
/** يسجّل حدث مزوّد؛ يعيد false إذا كان الحدث مكرراً (تمت معالجته سابقاً). */
export function recordEvent({ provider, eventId, paymentId = null, type = null, amount = null, status = null, payload = null }) {
  try {
    db.prepare(
      'INSERT INTO payment_events(provider,event_id,payment_id,type,amount,status,payload) VALUES (?,?,?,?,?,?,?)'
    ).run(provider, String(eventId), paymentId, type, amount, status,
      payload ? JSON.stringify(payload).slice(0, 20000) : null);
    return true;
  } catch {
    return false; // UNIQUE(event_id) → مكرر
  }
}

/* ================================================================== */
/*  بدء عملية الدفع                                                    */
/* ================================================================== */
/**
 * يجهّز عملية الدفع لدى المزوّد المحدد.
 * الأنماط الممكنة: redirect (رابط مستضاف) | form (نموذج يُرسل للبوابة) | local (محاكاة).
 */
export async function createCheckout({ payment, booking, service, salon }) {
  const provider = PROVIDERS.includes(payment.provider) ? payment.provider : currentProvider();
  const baseUrl = publicBaseUrl();

  if (provider === 'stripe') {
    if (!stripe.isConfigured()) throw new Error('Stripe غير مُهيّأ: أضف STRIPE_SECRET_KEY على الخادم.');
    const session = await stripe.createCheckout({ payment, booking, service, salon, baseUrl });
    db.prepare('UPDATE payments SET provider=?, provider_ref=?, checkout_url=?, expires_at=?, updated_at=? WHERE id=?')
      .run('stripe', session.id, session.url, session.expiresAt, isoNow(), payment.id);
    return { mode: 'redirect', url: session.url, ref: session.id, provider };
  }

  if (provider === 'cmi') {
    if (!cmi.isConfigured()) throw new Error('CMI غير مُهيّأ: أضف CMI_MERCHANT_ID و CMI_STORE_KEY على الخادم.');
    const form = cmi.buildPaymentForm({ payment, booking, service, salon, baseUrl });
    db.prepare('UPDATE payments SET provider=?, provider_ref=?, updated_at=? WHERE id=?')
      .run('cmi', form.fields.oid, isoNow(), payment.id);
    return { mode: 'form', gateway: form.gateway, fields: form.fields, ref: form.fields.oid, provider };
  }

  db.prepare('UPDATE payments SET provider=?, updated_at=? WHERE id=?').run('simulated', isoNow(), payment.id);
  return { mode: 'local', url: `${baseUrl}/pay/${payment.pay_token}/simulate`, provider: 'simulated' };
}

/* ================================================================== */
/*  تغيير حالة الدفعة (المصدر الوحيد للحقيقة)                          */
/* ================================================================== */
/** يعلّم الدفعة كمدفوعة — عملية idempotent وآمنة ضد التكرار. */
export function markPaid(paymentId, { provider = 'simulated', ref = null, method = 'card', amountMinor = null, amount = null, eventId = null } = {}) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return { ok: false, reason: 'الدفعة غير موجودة.' };

  // التحقق من المبلغ قبل أي تغيير (حماية من التلاعب)
  if (amountMinor != null) {
    const expected = Math.round(p.amount * 100);
    if (Math.round(Number(amountMinor)) !== expected) {
      db.prepare('UPDATE payments SET status=?, failure_reason=?, updated_at=? WHERE id=? AND status != ?')
        .run('failed', 'amount_mismatch', isoNow(), p.id, 'paid');
      return { ok: false, reason: 'المبلغ المُبلَّغ لا يطابق مبلغ الدفعة.' };
    }
  } else if (amount != null && Math.round(Number(amount)) !== p.amount) {
    return { ok: false, reason: 'المبلغ المُبلَّغ لا يطابق مبلغ الدفعة.' };
  }

  if (p.status === 'paid') return { ok: true, alreadyPaid: true, payment: p };

  db.prepare(
    `UPDATE payments SET status='paid', method=?, provider=?, provider_ref=COALESCE(?, provider_ref),
       paid_at=?, updated_at=?, failure_reason=NULL WHERE id=?`
  ).run(method, provider, ref, isoNow(), isoNow(), p.id);

  // تأكيد الحجز تلقائياً بعد دفع العربون
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(p.booking_id);
  if (b && p.kind === 'deposit' && b.status === 'pending') {
    db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(b.id);
  }
  if (b && p.kind === 'full' && b.status !== 'completed') {
    db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(b.id);
  }
  if (eventId) recordEvent({ provider, eventId: `${eventId}:applied`, paymentId: p.id, type: 'mark_paid', amount: p.amount, status: 'paid' });

  return { ok: true, payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id) };
}

export function markFailed(paymentId, reason = 'failed') {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return { ok: false, reason: 'الدفعة غير موجودة.' };
  if (p.status === 'paid') return { ok: true, alreadyPaid: true, payment: p };
  db.prepare("UPDATE payments SET status='failed', failure_reason=?, updated_at=? WHERE id=?")
    .run(String(reason).slice(0, 190), isoNow(), p.id);
  return { ok: true, payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id) };
}

export function markRefunded(paymentId, { provider = 'simulated', eventId = null } = {}) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return { ok: false, reason: 'الدفعة غير موجودة.' };
  db.prepare("UPDATE payments SET status='refunded', refunded_at=?, updated_at=? WHERE id=?")
    .run(isoNow(), isoNow(), p.id);
  if (eventId) recordEvent({ provider, eventId: `${eventId}:refunded`, paymentId: p.id, type: 'refund', amount: p.amount, status: 'refunded' });
  return { ok: true, payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(p.id) };
}

/* ================================================================== */
/*  معالجة Webhook الخاص بـ Stripe                                     */
/* ================================================================== */
export function processStripeEvent(event, { signatureVerified = false } = {}) {
  const eventId = event?.id || `evt_${Date.now()}`;

  // منع المعالجة المكرّرة لنفس الحدث (Stripe قد يعيد الإرسال عدة مرات)
  if (!recordEvent({ provider: 'stripe', eventId, type: event?.type, status: 'received', payload: event })) {
    const info0 = stripe.interpretEvent(event);
    const existing = (info0.paymentId && db.prepare('SELECT * FROM payments WHERE id = ?').get(info0.paymentId))
      || (info0.token && findPaymentByToken(info0.token)) || null;
    return {
      ok: true, duplicate: true, eventId,
      paymentId: existing ? existing.id : null,
      status: existing ? existing.status : null,
      action: existing && existing.status === 'paid' ? 'paid' : 'duplicate',
    };
  }

  const info = stripe.interpretEvent(event);
  let payment = info.paymentId ? db.prepare('SELECT * FROM payments WHERE id = ?').get(info.paymentId) : null;
  if (!payment && info.token) payment = findPaymentByToken(info.token);
  if (!payment) return { ok: false, reason: 'لا توجد دفعة مرتبطة بهذا الحدث.', eventId };

  if (info.kind === 'paid') {
    const r = markPaid(payment.id, {
      provider: 'stripe', ref: info.ref, method: info.method,
      amountMinor: info.amountMinor, eventId,
    });
    return { ok: r.ok, action: 'paid', paymentId: payment.id, signatureVerified, reason: r.reason };
  }
  if (info.kind === 'failed') {
    markFailed(payment.id, info.reason);
    return { ok: true, action: 'failed', paymentId: payment.id, signatureVerified };
  }
  if (info.kind === 'refunded') {
    markRefunded(payment.id, { provider: 'stripe', eventId });
    return { ok: true, action: 'refunded', paymentId: payment.id, signatureVerified };
  }
  return { ok: true, action: 'ignored', eventId };
}

/* ================================================================== */
/*  معالجة رد CMI                                                      */
/* ================================================================== */
export function processCmiCallback(params) {
  const verification = cmi.verifyCallback(params);
  if (!verification.ok) {
    return { ok: false, reason: verification.reason, signatureVerified: false };
  }

  const result = cmi.interpretCallback(params);
  const paymentId = cmi.paymentIdFromOid(result.oid) || Number(params.orderid || 0) || null;
  let payment = paymentId ? db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) : null;
  if (!payment && params.oid) {
    payment = db.prepare('SELECT * FROM payments WHERE provider_ref = ?').get(String(params.oid)) || null;
  }
  if (!payment) return { ok: false, reason: 'لا توجد دفعة مرتبطة بهذا الرد.', signatureVerified: true };

  // معرّف فريد لكل (طلب × عملية) — نُدرج oid لأنه فريد لكل دفعة
  const eventId = `cmi_${result.oid || payment.id}_${result.ref || 'na'}_${result.approved ? 'ok' : 'fail'}`;
  if (!recordEvent({ provider: 'cmi', eventId, paymentId: payment.id, type: params.ProcReturnCode, amount: result.amount, status: result.approved ? 'paid' : 'failed', payload: params })) {
    const fresh = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    return {
      ok: true, duplicate: true, paymentId: payment.id, signatureVerified: true,
      status: fresh.status,
      action: fresh.status === 'paid' ? 'paid' : fresh.status === 'failed' ? 'failed' : 'pending',
    };
  }

  if (!result.approved) {
    markFailed(payment.id, result.errorMessage || 'cmi_declined');
    return { ok: true, action: 'failed', paymentId: payment.id, signatureVerified: true, message: result.errorMessage };
  }

  const r = markPaid(payment.id, {
    provider: 'cmi', ref: result.ref, method: 'card',
    amount: result.amount, eventId,
  });
  return { ok: r.ok, action: 'paid', paymentId: payment.id, signatureVerified: true, reason: r.reason };
}
