// src/util.js — أدوات مشتركة
import { db } from './db.js';

export const json = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

export const ok = (res, data = {}) => json(res, 200, data);
export const created = (res, data = {}) => json(res, 201, data);
export const fail = (res, status, message, extra = {}) => json(res, status, { error: message, ...extra });

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

export const str = (v) => (v == null ? '' : String(v).trim());
export const int = (v, def = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

/* -------------------- الوقت والتواريخ -------------------- */
export const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isoNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

export function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/* -------------------- الهاتف -------------------- */
// تحويل الرقم المغربي إلى صيغة دولية للواتساب
export function waNumber(phone) {
  let p = str(phone).replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('212')) return p;
  if (p.startsWith('0')) return '212' + p.slice(1);
  if (p.length === 9) return '212' + p;
  return p;
}

export function waLink(phone, message) {
  return `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(message)}`;
}

// تحويل الرقم الدولي إلى الصيغة المحلية المغربية (2126XXXXXXXX → 06XXXXXXXX)
export function localPhone(phone) {
  let p = str(phone).replace(/\D/g, '');
  if (p.startsWith('212')) return '0' + p.slice(3);
  if (p.startsWith('00')) p = p.slice(2);
  return p;
}

/* -------------------- توليد الفترات المتاحة -------------------- */
export function slotsFor(salon) {
  const out = [];
  const [oh, om] = salon.open_time.split(':').map(Number);
  const [ch, cm] = salon.close_time.split(':').map(Number);
  let t = oh * 60 + om;
  const end = ch * 60 + cm;
  while (t + salon.slot_minutes <= end) {
    out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    t += salon.slot_minutes;
  }
  return out;
}

/* -------------------- رسائل الإشعارات -------------------- */
export function bookingMessage({ salon, service, staff, booking, kind }) {
  const when = `يوم ${booking.date} على الساعة ${booking.time}`;
  switch (kind) {
    case 'confirmation':
      return `السلام عليكم ${booking.customer_name} 👋\nتم تأكيد حجزك في ${salon.name}.\nالخدمة: ${service.name}\n${when}${staff ? `\nمع: ${staff.name}` : ''}\nالعربون المدفوع: ${booking.deposit} درهم\nفي انتظارك! ✨`;
    case 'reminder':
      return `تذكير بموعدك في ${salon.name} ${when} (${service.name}). نتمنى أن نراك! ✨`;
    case 'cancel':
      return `تم إلغاء حجزك في ${salon.name} ${when}. للتعديل تواصل معنا: ${salon.phone || ''}`;
    default:
      return `رسالة من ${salon.name} بخصوص حجزك ${when}.`;
  }
}

export function queueNotification({ booking_id = null, salon_id, channel = 'whatsapp', phone, message, scheduled_at = null, status = 'queued' }) {
  return db
    .prepare('INSERT INTO notifications(booking_id,salon_id,channel,to_phone,message,status,scheduled_at) VALUES (?,?,?,?,?,?,?)')
    .run(booking_id, salon_id, channel, phone, message, status, scheduled_at).lastInsertRowid;
}
