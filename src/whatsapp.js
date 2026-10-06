// src/whatsapp.js — إرسال رسائل واتساب عبر مزوّدين متعددين (بلا مكتبات خارجية)
//
// المزوّدون المدعومون:
//   simulated  — بلا إرسال (يُطبع في السجل) — الافتراضي
//   meta/cloud — Meta WhatsApp Cloud API الرسمي
//   twilio     — Twilio WhatsApp API
//   ultramsg   — UltraMsg
//   greenapi   — Green API
//   webhook    — بوابة/وسيط HTTP عام (JSON: { to, message })
//
// يُختار المزوّد تلقائياً من متغيرات البيئة، أو يدوياً عبر WHATSAPP_PROVIDER.
import { waNumber, str } from './util.js';

const GRAPH_VERSION = () => process.env.WHATSAPP_GRAPH_VERSION || 'v20.0';

/* ================================================================== */
/*  اكتشاف المزوّد                                                      */
/* ================================================================== */
export function whatsappProvider() {
  const forced = str(process.env.WHATSAPP_PROVIDER).toLowerCase();
  if (forced) return forced === 'cloud' ? 'meta' : forced;

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM) return 'twilio';
  if (process.env.ULTRAMSG_INSTANCE_ID && process.env.ULTRAMSG_TOKEN) return 'ultramsg';
  if (process.env.GREENAPI_ID_INSTANCE && process.env.GREENAPI_TOKEN) return 'greenapi';
  if (process.env.WHATSAPP_WEBHOOK_URL) return 'webhook';
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) return 'meta';
  return 'simulated';
}

/** اسم المزوّد الحالي (نفس الدالة القديمة لأجل التوافق). */
export const whatsappMode = () => whatsappProvider();
export const whatsappReady = () => whatsappProvider() !== 'simulated';

/** توحيد الرقم إلى الصيغة الدولية للواتساب (2126XXXXXXXX). */
export const normalizeWaPhone = (phone) => waNumber(phone);

/** إعدادات عامة للعرض في الواجهات — بلا أي مفاتيح سرّية. */
export function whatsappPublicConfig() {
  const provider = whatsappProvider();
  return {
    provider,
    mode: provider,
    ready: provider !== 'simulated',
    simulated: provider === 'simulated',
    business_number: str(process.env.WHATSAPP_BUSINESS_NUMBER) || null,
    otp_ttl_seconds: 300,
  };
}

/* ================================================================== */
/*  نص الرسالة                                                          */
/* ================================================================== */
export function otpMessage(code, { purpose = 'login', appName = 'حجزي Pro' } = {}) {
  const intro = purpose === 'link'
    ? `رمز ربط واتساب بحسابك في ${appName}`
    : `رمز الدخول إلى ${appName}`;
  return `${intro}:\n*${code}*\nصالح لمدة 5 دقائق. لا تشاركه مع أي شخص.`;
}

/* ================================================================== */
/*  الإرسال                                                             */
/* ================================================================== */
async function postForm(url, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

async function postJson(url, payload, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

/** يرسل نصاً عبر المزوّد المُكتشف. يعيد { ok, provider, id?, error? }. */
export async function sendWhatsAppText(to, message) {
  const provider = whatsappProvider();
  const phone = waNumber(to);
  if (!/^\d{9,15}$/.test(phone)) return { ok: false, provider, error: 'INVALID_PHONE' };

  if (provider === 'simulated') {
    console.log(`[WHATSAPP:simulated] → ${phone}\n${message}\n`);
    return { ok: true, provider, simulated: true };
  }

  try {
    let res;
    if (provider === 'meta') {
      res = await postJson(
        `https://graph.facebook.com/${GRAPH_VERSION()}/${process.env.WHATSAPP_PHONE_ID}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body: message } },
        { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      );
    } else if (provider === 'twilio') {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const from = str(process.env.TWILIO_WHATSAPP_FROM).startsWith('whatsapp:')
        ? process.env.TWILIO_WHATSAPP_FROM
        : `whatsapp:+${waNumber(process.env.TWILIO_WHATSAPP_FROM)}`;
      res = await postForm(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        { From: from, To: `whatsapp:+${phone}`, Body: message },
        { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') },
      );
    } else if (provider === 'ultramsg') {
      res = await postForm(
        `https://api.ultramsg.com/${process.env.ULTRAMSG_INSTANCE_ID}/messages/chat`,
        { token: process.env.ULTRAMSG_TOKEN, to: `+${phone}`, body: message },
      );
    } else if (provider === 'greenapi') {
      res = await postJson(
        `https://api.green-api.com/waInstance${process.env.GREENAPI_ID_INSTANCE}/sendMessage/${process.env.GREENAPI_TOKEN}`,
        { chatId: `${phone}@c.us`, message },
      );
    } else if (provider === 'webhook') {
      const headers = process.env.WHATSAPP_WEBHOOK_TOKEN
        ? { Authorization: `Bearer ${process.env.WHATSAPP_WEBHOOK_TOKEN}` }
        : {};
      res = await postJson(process.env.WHATSAPP_WEBHOOK_URL, { to: phone, message, type: 'text' }, headers);
    } else {
      return { ok: false, provider, error: 'UNKNOWN_PROVIDER' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.error?.message || data?.message || data?.error || `HTTP ${res.status}`;
      console.error(`[WHATSAPP:${provider} ERROR]`, res.status, detail);
      return { ok: false, provider, error: String(detail) };
    }
    return { ok: true, provider, id: data?.messages?.[0]?.id || data?.sid || data?.idMessage || null };
  } catch (err) {
    console.error(`[WHATSAPP:${provider} ERROR]`, err);
    return { ok: false, provider, error: 'NETWORK' };
  }
}
