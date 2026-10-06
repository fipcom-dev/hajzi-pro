// src/payments/cmi.js — تكامل CMI (المركز المغربي للمقاصة الإلكترونية)
// بوابة الدفع المغربية: صفحة دفع مستضافة + توقيع HMAC-SHA256 + التحقق من الرد.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const DEFAULT_GATEWAY = 'https://payment.cmi.co.ma/fim/est3Dgate';

// ترتيب الحقول المعتمد عند حساب التوقيع في طلب الدفع (حسب توثيق CMI ver3)
const REQUEST_ORDER = [
  'clientid', 'amount', 'oid', 'okUrl', 'failUrl', 'callbackUrl', 'shopurl',
  'TranType', 'currency', 'rnd', 'storetype', 'hashAlgorithm', 'encoding',
  'lang', 'email', 'tel', 'BillToName', 'description',
];

export const isConfigured = () =>
  Boolean(process.env.CMI_MERCHANT_ID && process.env.CMI_STORE_KEY);

export function publicConfig() {
  return {
    configured: isConfigured(),
    merchant_id: process.env.CMI_MERCHANT_ID || null,
    store_key_set: Boolean(process.env.CMI_STORE_KEY),
    gateway_url: process.env.CMI_GATEWAY_URL || DEFAULT_GATEWAY,
    test_mode: !String(process.env.CMI_GATEWAY_URL || '').includes('payment.cmi.co.ma'),
  };
}

/** تهريب القيم حسب متطلبات CMI: الشرطة العكسية ثم الأنبوب. */
const escapeCmi = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** حساب التوقيع: base64(HMAC-SHA256(values.join('|'), storeKey)) */
export function sign(values, order) {
  const key = process.env.CMI_STORE_KEY || '';
  const plain = order.map((k) => escapeCmi(values[k])).join('|');
  return createHmac('sha256', key).update(plain, 'utf8').digest('base64');
}

/** يبني حقول النموذج التي ستُرسل إلى بوابة CMI (بما فيها التوقيع). */
export function buildPaymentForm({ payment, booking, service, salon, baseUrl }) {
  const values = {
    clientid: process.env.CMI_MERCHANT_ID || '',
    amount: Number(payment.amount).toFixed(2),
    oid: `HJZ${payment.id}T${String(payment.pay_token || '').slice(0, 10)}`,
    okUrl: `${baseUrl}/pay/${payment.pay_token}/done?status=success`,
    failUrl: `${baseUrl}/pay/${payment.pay_token}/done?status=fail`,
    callbackUrl: `${baseUrl}/api/webhooks/cmi`,
    shopurl: `${baseUrl}/`,
    TranType: process.env.CMI_TRAN_TYPE || 'PreAuth',
    currency: '504', // الدرهم المغربي حسب ISO 4217
    rnd: new Date().toISOString(),
    storetype: '3D_PAY_HOSTING',
    hashAlgorithm: 'ver3',
    encoding: 'UTF-8',
    lang: 'ar',
    email: '',
    tel: booking.customer_phone || '',
    BillToName: booking.customer_name || '',
    description: `${service ? service.name + ' · ' : ''}${salon.name} — ${booking.date} ${booking.time}`,
  };
  values.hash = sign(values, REQUEST_ORDER);
  return { gateway: process.env.CMI_GATEWAY_URL || DEFAULT_GATEWAY, fields: values };
}

/** يستخرج رقم الدفعة من مرجع الطلب oid. */
export function paymentIdFromOid(oid) {
  const m = /^HJZ(\d+)T/.exec(String(oid || ''));
  return m ? Number(m[1]) : null;
}

/**
 * يتحقق من توقيع رد CMI.
 * ترتيب الحقول في الرد يختلف عن الطلب، لذا نجرّب الترتيب الأبجدي أولاً
 * ثم ترتيب حقول الطلب كبديل، ونقبل إن طابق أحدهما.
 */
export function verifyCallback(params) {
  const received = params.hash || params.HASH;
  if (!received) return { ok: false, reason: 'حقل hash مفقود في رد CMI.' };

  const candidates = [];
  const sortedKeys = Object.keys(params)
    .filter((k) => !['hash', 'HASH', 'encoding'].includes(k))
    .sort();
  candidates.push(sortedKeys);
  candidates.push(REQUEST_ORDER.filter((k) => k in params));

  const receivedBuf = Buffer.from(String(received), 'utf8');
  for (const order of candidates) {
    const expected = sign(params, order);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf)) {
      return { ok: true, order: order === sortedKeys ? 'sorted' : 'request' };
    }
  }
  return { ok: false, reason: 'توقيع CMI غير مطابق — تحقّق من CMI_STORE_KEY.' };
}

/** يقرأ نتيجة العملية من رد CMI. */
export function interpretCallback(params) {
  const procCode = String(params.ProcReturnCode ?? '');
  const response = String(params.Response ?? '');
  const approved = procCode === '00' || response.toLowerCase() === 'approved';
  return {
    approved,
    ref: params.TransId || params.AuthCode || params.oid || null,
    oid: params.oid || null,
    amount: params.amount != null ? Number(params.amount) : null,
    errorMessage: params.ErrMsg || null,
    maskedPan: params.MaskedPan || null,
    authCode: params.AuthCode || null,
  };
}

export const newRnd = () => randomBytes(8).toString('hex');
