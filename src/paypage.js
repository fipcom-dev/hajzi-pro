// src/paypage.js — صفحة الدفع الآمنة (تُقدَّم من الخادم) + مستقبِل إشعارات المزوّدين
import { db } from './db.js';
import * as pay from './payments/index.js';
import * as stripe from './payments/stripe.js';
import * as cmi from './payments/cmi.js';

const MAX_BODY = 512 * 1024;

/* ================================================================== */
/*  أدوات الطلب والاستجابة                                             */
/* ================================================================== */
function readRaw(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readForm(req) {
  const raw = await readRaw(req);
  const text = raw.toString('utf8');
  if (!text) return {};
  // ندعم الصيغتين: form-urlencoded و JSON
  if (text.trim().startsWith('{')) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (v) => `${Number(v || 0).toLocaleString('fr-MA')} د.م`;

function securityHeaders(extra = {}) {
  const gateway = process.env.CMI_GATEWAY_URL || 'https://payment.cmi.co.ma';
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "form-action 'self' " + gateway + ' https://checkout.stripe.com',
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    ...extra,
  };
}

function sendHtml(res, status, body, extra = {}) {
  res.writeHead(status, securityHeaders(extra));
  res.end(body);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

/* ================================================================== */
/*  قالب الصفحة                                                        */
/* ================================================================== */
const STYLE = `
:root{--blue:#2F3FB0;--navy:#1F2A80;--gold:#F0A81C;--ink:#14213D;--muted:#6B7590;--line:#E2E6F3;--bg:#EEF0F9;--green:#12805A;--red:#B42318}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Tajawal","Segoe UI",system-ui,-apple-system,"Noto Naskh Arabic",sans-serif;line-height:1.7}
.wrap{max-width:560px;margin:0 auto;padding:18px 14px 40px}
.brand{display:flex;align-items:center;gap:10px;padding:14px 4px 18px;font-weight:800;font-size:19px;color:var(--navy)}
.brand .mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--blue),var(--navy));color:#fff;display:grid;place-items:center;font-size:19px}
.badge{margin-inline-start:auto;background:#E7EAFB;color:var(--navy);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700}
.card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 12px 30px rgba(20,33,61,.07)}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 16px}
.rows{border:1px solid var(--line);border-radius:14px;overflow:hidden;margin:14px 0}
.row{display:flex;gap:10px;padding:11px 14px;font-size:14px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .k{color:var(--muted);min-width:96px}
.row .v{font-weight:700;margin-inline-start:auto;text-align:end}
.total{display:flex;align-items:center;background:linear-gradient(135deg,#FFF8E8,#FFF1D6);border:1px solid #F5DBA0;border-radius:14px;padding:14px 16px;margin:14px 0}
.total .lbl{font-size:14px;color:#8A5B00;font-weight:700}
.total .amt{margin-inline-start:auto;font-size:24px;font-weight:900;color:var(--navy)}
.btn{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:16px;font-weight:800;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,var(--blue),var(--navy));color:#fff;text-decoration:none;text-align:center}
.btn:hover{filter:brightness(1.06)}
.btn.ghost{background:#fff;color:var(--navy);border:1px solid var(--line)}
.note{margin-top:14px;font-size:12.5px;color:var(--muted);text-align:center}
.lock{display:flex;align-items:center;justify-content:center;gap:7px;background:#EAF7F1;color:var(--green);border-radius:12px;padding:10px;font-size:13px;font-weight:700;margin-top:14px}
.warn{background:#FFF4E5;color:#8A5B00;border:1px solid #F5DBA0;border-radius:12px;padding:11px 13px;font-size:13px;margin-top:14px}
.err{background:#FDECEA;color:var(--red);border:1px solid #F5C2BE;border-radius:12px;padding:11px 13px;font-size:13px;margin-top:14px}
.ok-ico{width:64px;height:64px;border-radius:50%;background:#EAF7F1;color:var(--green);display:grid;place-items:center;font-size:32px;margin:0 auto 12px}
.fail-ico{width:64px;height:64px;border-radius:50%;background:#FDECEA;color:var(--red);display:grid;place-items:center;font-size:32px;margin:0 auto 12px}
.wait-ico{width:64px;height:64px;border-radius:50%;background:#E7EAFB;color:var(--navy);display:grid;place-items:center;font-size:30px;margin:0 auto 12px}
.center{text-align:center}
footer{text-align:center;color:var(--muted);font-size:12px;padding:18px 6px}
.oid{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--muted);direction:ltr;display:inline-block}
`;

function shell(title, body) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="mark">✂️</span> حجزي Pro <span class="badge">دفع آمن</span></div>
  ${body}
  <footer>🔒 جميع العمليات مشفّرة · لا نحتفظ ببيانات بطاقتك البنكية</footer>
</div>
</body>
</html>`;
}

function summaryRows(ctx) {
  const { booking, service, salon, staff, payment } = ctx;
  return `
  <div class="rows">
    <div class="row"><span class="k">الصالون</span><span class="v">${escapeHtml(salon?.name || '')}${salon?.city ? ' — ' + escapeHtml(salon.city) : ''}</span></div>
    <div class="row"><span class="k">الخدمة</span><span class="v">${escapeHtml(service?.name || '')}</span></div>
    <div class="row"><span class="k">الموعد</span><span class="v">${escapeHtml(booking.date)} · ${escapeHtml(booking.time)}</span></div>
    ${staff ? `<div class="row"><span class="k">الأخصائية</span><span class="v">${escapeHtml(staff.name)}</span></div>` : ''}
    <div class="row"><span class="k">الاسم</span><span class="v">${escapeHtml(booking.customer_name)}</span></div>
    <div class="row"><span class="k">رقم الهاتف</span><span class="v">${escapeHtml(booking.customer_phone)}</span></div>
    <div class="row"><span class="k">سعر الخدمة</span><span class="v">${money(booking.price)}</span></div>
    <div class="row"><span class="k">نوع الدفعة</span><span class="v">${payment.kind === 'deposit' ? 'عربون الحجز' : 'المبلغ المتبقي'}</span></div>
  </div>
  <div class="total"><span class="lbl">المبلغ المستحق الآن</span><span class="amt">${money(payment.amount)}</span></div>`;
}

/* ================================================================== */
/*  صفحات الدفع                                                        */
/* ================================================================== */
function renderPayPage(ctx, { notice = null } = {}) {
  const { payment } = ctx;
  const provider = payment.provider || pay.currentProvider();

  if (payment.status === 'paid') {
    return shell('تم الدفع', `
      <div class="card center">
        <div class="ok-ico">✓</div>
        <h1>تم الدفع بنجاح</h1>
        <p class="sub">حجزك مؤكّد الآن. سنرسل لك تذكيراً قبل الموعد.</p>
        ${summaryRows(ctx)}
        <a class="btn" href="/">العودة إلى التطبيق</a>
      </div>`);
  }

  if (payment.status === 'refunded') {
    return shell('تم الاسترجاع', `
      <div class="card center">
        <div class="wait-ico">↩</div>
        <h1>تم استرجاع المبلغ</h1>
        <p class="sub">أُعيد مبلغ ${money(payment.amount)} إلى وسيلة الدفع الأصلية.</p>
        ${summaryRows(ctx)}
        <a class="btn ghost" href="/">العودة إلى التطبيق</a>
      </div>`);
  }

  const ready = pay.providerReady(provider);
  const providerLabel = provider === 'stripe' ? 'Stripe' : provider === 'cmi' ? 'CMI (البطاقة البنكية المغربية)' : 'وضع تجريبي';

  const warning = provider === 'simulated'
    ? `<div class="warn">🧪 <b>وضع تجريبي:</b> لن يتم خصم أي مبلغ حقيقي. لتفعيل الدفع الحقيقي اختر Stripe أو CMI في إعدادات الصالون.</div>`
    : !ready
      ? `<div class="err">⚠️ مزوّد الدفع «${escapeHtml(providerLabel)}» غير مُهيّأ على الخادم. تواصل مع مسؤول النظام.</div>`
      : '';

  const form = payment.status === 'failed'
    ? `<form method="POST" action="/pay/${escapeHtml(payment.pay_token)}/start">
         <button class="btn" type="submit" ${ready ? '' : 'disabled'}>إعادة المحاولة</button>
       </form>`
    : `<form method="POST" action="/pay/${escapeHtml(payment.pay_token)}/start">
         <button class="btn" type="submit" ${ready ? '' : 'disabled'}>ادفع ${money(payment.amount)} بأمان</button>
       </form>`;

  return shell('الدفع الآمن', `
    <div class="card">
      <h1>إتمام الدفع</h1>
      <p class="sub">راجع تفاصيل الحجز ثم أكمل الدفع عبر ${escapeHtml(providerLabel)}.</p>
      ${notice ? `<div class="warn">${escapeHtml(notice)}</div>` : ''}
      ${summaryRows(ctx)}
      ${warning}
      ${payment.status === 'failed' && payment.failure_reason ? `<div class="err">فشلت المحاولة السابقة: ${escapeHtml(payment.failure_reason)}</div>` : ''}
      <div style="margin-top:16px">${form}</div>
      <div class="lock">🔒 اتصال مشفّر · تُعالَج البطاقة على صفحة المزوّد مباشرة</div>
      <p class="note">رقم العملية: <span class="oid">${escapeHtml(payment.pay_token.slice(0, 18))}…</span></p>
    </div>`);
}

function renderGatewayForm(gateway, fields) {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');
  return shell('جارٍ تحويلك إلى بوابة الدفع', `
    <div class="card center">
      <div class="wait-ico">⏳</div>
      <h1>جارٍ تحويلك إلى بوابة CMI…</h1>
      <p class="sub">لا تغلق هذه الصفحة. إن لم يتم التحويل تلقائياً اضغط الزر أدناه.</p>
      <form id="gw" method="POST" action="${escapeHtml(gateway)}">
        ${inputs}
        <button class="btn" type="submit">متابعة إلى بوابة الدفع</button>
      </form>
      <div class="lock">🔒 ستُدخل بيانات بطاقتك على موقع البنك مباشرة</div>
    </div>
    <script>document.getElementById('gw').submit();</script>`);
}

function renderDonePage(ctx, status) {
  const { payment, booking } = ctx;
  if (payment.status === 'paid') {
    return shell('تم الدفع', `
      <div class="card center">
        <div class="ok-ico">✓</div>
        <h1>تم الدفع بنجاح 🎉</h1>
        <p class="sub">حجزك في ${escapeHtml(ctx.salon?.name || '')} مؤكّد.</p>
        ${summaryRows(ctx)}
        <a class="btn" href="/">العودة إلى التطبيق</a>
      </div>`);
  }
  if (payment.status === 'failed') {
    return shell('فشل الدفع', `
      <div class="card center">
        <div class="fail-ico">✕</div>
        <h1>لم تكتمل العملية</h1>
        <p class="sub">${escapeHtml(payment.failure_reason || 'تم رفض العملية من طرف البنك.')}</p>
        ${summaryRows(ctx)}
        <a class="btn" href="/pay/${escapeHtml(payment.pay_token)}">المحاولة مرة أخرى</a>
      </div>`);
  }
  // ما زالت قيد المعالجة (الـ webhook لم يصل بعد)
  return shell('قيد المعالجة', `
    <div class="card center">
      <div class="wait-ico">⏳</div>
      <h1>الدفع قيد المعالجة</h1>
      <p class="sub">نتحقق من العملية لدى المزوّد. حدّث الصفحة بعد ثوانٍ قليلة.</p>
      ${summaryRows(ctx)}
      <a class="btn" href="/pay/${escapeHtml(payment.pay_token)}/done?status=${escapeHtml(status || 'pending')}">تحديث الحالة</a>
      <div class="lock">🔒 لا تُغلق الصفحة قبل ظهور النتيجة</div>
    </div>`);
}

/* ================================================================== */
/*  معالجة مسارات الدفع                                                */
/* ================================================================== */
const lastStart = new Map(); // حماية بسيطة من الإغراق

export async function handlePayPage(req, res, pathname, searchParams) {
  const m = /^\/pay\/([a-f0-9]{16,64})(?:\/(start|done))?$/.exec(pathname);
  if (!m) return sendHtml(res, 404, shell('غير موجود', '<div class="card center"><h1>رابط دفع غير صالح</h1><p class="sub">تأكّد من الرابط أو اطلب رابطاً جديداً.</p></div>'));

  const [, token, action] = m;
  const payment = pay.findPaymentByToken(token);
  if (!payment) {
    return sendHtml(res, 404, shell('غير موجود', '<div class="card center"><div class="fail-ico">✕</div><h1>رابط الدفع غير صالح</h1><p class="sub">ربما انتهت صلاحيته. اطلب رابطاً جديداً من التطبيق.</p></div>'));
  }
  const ctx = pay.paymentContext(payment);
  if (!ctx) return sendHtml(res, 404, shell('غير موجود', '<div class="card center"><h1>الحجز المرتبط غير موجود</h1></div>'));

  /* ---------- بدء الدفع ---------- */
  if (action === 'start') {
    if (req.method !== 'POST') {
      res.writeHead(303, { Location: `/pay/${token}` });
      return res.end();
    }
    if (payment.status === 'paid') {
      res.writeHead(303, { Location: `/pay/${token}/done?status=success` });
      return res.end();
    }
    // حد بسيط: محاولة واحدة كل 3 ثوان لكل دفعة
    const now = Date.now();
    if (now - (lastStart.get(token) || 0) < 3000) {
      return sendHtml(res, 429, renderPayPage(ctx, { notice: 'محاولة سريعة جداً — انتظر ثوانٍ ثم أعد المحاولة.' }));
    }
    lastStart.set(token, now);

    const provider = payment.provider || pay.currentProvider();
    if (!pay.providerReady(provider)) {
      return sendHtml(res, 503, renderPayPage(ctx, { notice: 'مزوّد الدفع غير مُهيّأ على الخادم.' }));
    }

    try {
      const checkout = await pay.createCheckout({
        payment, booking: ctx.booking, service: ctx.service, salon: ctx.salon,
      });
      if (checkout.mode === 'redirect') {
        res.writeHead(303, { Location: checkout.url, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (checkout.mode === 'form') {
        return sendHtml(res, 200, renderGatewayForm(checkout.gateway, checkout.fields));
      }
      // وضع تجريبي: تأكيد فوري (بعد ضغط المستخدم على زر الدفع)
      const r = pay.markPaid(payment.id, { provider: 'simulated', ref: `SIM-${Date.now().toString(36).toUpperCase()}`, method: 'card' });
      res.writeHead(303, { Location: `/pay/${token}/done?status=${r.ok ? 'success' : 'fail'}`, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (err) {
      console.error('[PAY ERROR]', err);
      return sendHtml(res, 502, renderPayPage(ctx, { notice: `تعذّر بدء الدفع: ${err.message}` }));
    }
  }

  /* ---------- صفحة النتيجة ---------- */
  if (action === 'done') {
    let status = searchParams?.get('status') || 'pending';
    // بوابة CMI تعيد الإرسال إلى okUrl/failUrl بصيغة POST موقّعة — نعالجها هنا أيضاً
    if (req.method === 'POST') {
      try {
        const params = await readForm(req);
        if (params && (params.hash || params.HASH)) {
          const result = pay.processCmiCallback(params);
          console.log('[CMI RETURN]', JSON.stringify(result));
          if (!result.ok && result.reason) status = 'fail';
        }
      } catch (err) {
        console.warn('[CMI RETURN ERROR]', err.message);
      }
    }
    const fresh = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    const freshCtx = pay.paymentContext(fresh);
    return sendHtml(res, 200, renderDonePage(freshCtx, status));
  }

  /* ---------- صفحة الدفع ---------- */
  return sendHtml(res, 200, renderPayPage(ctx));
}

/* ================================================================== */
/*  مستقبِل إشعارات المزوّدين (Webhooks)                                */
/* ================================================================== */
export async function handleWebhook(req, res, pathname) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });

  /* ---- Stripe ---- */
  if (pathname === '/api/webhooks/stripe') {
    let raw;
    try { raw = await readRaw(req); }
    catch { return sendJson(res, 413, { error: 'payload_too_large' }); }

    let event;
    try {
      event = stripe.verifySignature(raw.toString('utf8'), req.headers['stripe-signature']);
    } catch (err) {
      console.warn('[STRIPE WEBHOOK] رُفض:', err.message);
      // 400 يجعل Stripe يعيد المحاولة؛ للتوقيع الخاطئ نعيد 400 ليُسجَّل الرفض
      return sendJson(res, 400, { error: err.message });
    }

    const result = pay.processStripeEvent(event, { signatureVerified: true });
    console.log('[STRIPE WEBHOOK]', event.type, JSON.stringify(result));
    return sendJson(res, result.ok ? 200 : 422, result);
  }

  /* ---- CMI ---- */
  if (pathname === '/api/webhooks/cmi') {
    let params;
    try { params = await readForm(req); }
    catch { return sendJson(res, 413, { error: 'payload_too_large' }); }

    const result = pay.processCmiCallback(params);
    console.log('[CMI WEBHOOK]', JSON.stringify(result));
    if (!result.ok) return sendJson(res, 400, result);
    return sendJson(res, 200, { received: true, ...result });
  }

  return sendJson(res, 404, { error: 'unknown_webhook' });
}
