// src/api.js — كل مسارات الـ API
import { db } from './db.js';
import {
  createToken, verifyToken, hashPassword, verifyPassword,
  generateOtp, hashOtp, verifyOtpHash, randomSecret,
} from './auth.js';
import {
  ok, created, fail, readBody, str, int, bool,
  dateKey, isoNow, slotsFor, minutesOf, bookingMessage, queueNotification,
  waLink, waNumber, localPhone, DAY_NAMES,
} from './util.js';
import {
  whatsappMode, whatsappPublicConfig, sendWhatsAppText, otpMessage,
} from './whatsapp.js';
import {
  PROVIDERS, currentProvider, publicBaseUrl, providerStatus, providerReady,
  newPayToken, ensurePayToken, findPaymentByToken, setSetting,
} from './payments/index.js';

/* ================================================================== */
/*  مساعدات المصادقة والصلاحيات                                        */
/* ================================================================== */
function currentUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return db.prepare('SELECT id,name,email,phone,role,avatar_color,created_at FROM users WHERE id = ?').get(payload.uid) || null;
}

/* -------------------- مساعدات واتساب -------------------- */
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_WINDOW_MINUTES = 10;
const OTP_MAX_PER_WINDOW = 5;
const SIGNUP_TOKEN_TTL = 900; // 15 دقيقة لإكمال إنشاء حساب واتساب

/** رابط واتساب المخزّن للمستخدم (أو null). */
function whatsappLinkFor(userId) {
  return db.prepare(
    'SELECT wa_phone, wa_name, verified, linked_at, last_login_at FROM whatsapp_links WHERE user_id = ?'
  ).get(userId) || null;
}

/** نسخة آمنة من المستخدم (بلا كلمة مرور) مع معلومات واتساب. */
function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  const link = whatsappLinkFor(user.id);
  return {
    ...safe,
    whatsapp: link
      ? { phone: link.wa_phone, name: link.wa_name, verified: Boolean(link.verified), linked_at: link.linked_at, last_login_at: link.last_login_at }
      : null,
  };
}

/** يعيد المستخدم المرتبط برقم واتساب (عبر الجدول أو عبر users.phone). */
function findUserByWaPhone(phone) {
  const link = db.prepare('SELECT user_id FROM whatsapp_links WHERE wa_phone = ?').get(phone);
  if (link) return db.prepare('SELECT * FROM users WHERE id = ?').get(link.user_id) || null;
  const candidates = db.prepare("SELECT * FROM users WHERE phone IS NOT NULL AND phone != ''").all();
  return candidates.find((u) => waNumber(u.phone) === phone) || null;
}

/** يربط/يحدّث رقم واتساب لمستخدم (يتحقق من عدم ارتباطه بحساب آخر). */
function linkWhatsapp(userId, phone, waName = null) {
  const owner = db.prepare('SELECT user_id FROM whatsapp_links WHERE wa_phone = ?').get(phone);
  if (owner && owner.user_id !== userId) throw new Error('WA_PHONE_TAKEN');
  const existing = db.prepare('SELECT id FROM whatsapp_links WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare("UPDATE whatsapp_links SET wa_phone = ?, wa_name = COALESCE(?, wa_name), verified = 1, linked_at = datetime('now') WHERE user_id = ?")
      .run(phone, waName, userId);
  } else {
    db.prepare('INSERT INTO whatsapp_links(user_id, wa_phone, wa_name, verified) VALUES (?,?,?,1)')
      .run(userId, phone, waName);
  }
  return whatsappLinkFor(userId);
}

/** ينشئ رمز OTP جديد ويخزّن بصمته. */
function issueOtp({ phone, purpose, userId = null }) {
  const code = generateOtp(6);
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(
    'INSERT INTO whatsapp_otps(phone, code_hash, purpose, user_id, expires_at, max_attempts) VALUES (?,?,?,?,?,?)'
  ).run(phone, hashOtp(code, phone), purpose, userId, expiresAt, OTP_MAX_ATTEMPTS);
  return code;
}

/** يتحقق من رمز OTP ويسجّل المحاولات — يعيد { ok, reason, otp }. */
function checkOtp({ phone, purpose, code, userId = null }) {
  const otp = db.prepare(
    "SELECT * FROM whatsapp_otps WHERE phone = ? AND purpose = ? AND consumed_at IS NULL AND expires_at >= datetime('now') ORDER BY id DESC LIMIT 1"
  ).get(phone, purpose);
  if (!otp) return { ok: false, status: 400, reason: 'انتهت صلاحية الرمز. اطلب رمزاً جديداً.' };
  if (otp.user_id && userId && otp.user_id !== userId) return { ok: false, status: 403, reason: 'طلب التحقق لا يخصّ حسابك.' };
  if (otp.attempts >= otp.max_attempts) return { ok: false, status: 429, reason: 'تم تجاوز عدد المحاولات. اطلب رمزاً جديداً.' };
  if (!verifyOtpHash(code, phone, otp.code_hash)) {
    db.prepare('UPDATE whatsapp_otps SET attempts = attempts + 1 WHERE id = ?').run(otp.id);
    return { ok: false, status: 401, reason: 'الرمز غير صحيح.' };
  }
  db.prepare("UPDATE whatsapp_otps SET consumed_at = datetime('now') WHERE id = ?").run(otp.id);
  return { ok: true, otp };
}

function rootSalonId(salonId) {
  let cur = db.prepare('SELECT id,parent_id FROM salons WHERE id = ?').get(salonId);
  let guard = 0;
  while (cur && cur.parent_id && guard++ < 10) {
    cur = db.prepare('SELECT id,parent_id FROM salons WHERE id = ?').get(cur.parent_id);
  }
  return cur ? cur.id : null;
}

/** يعيد الصالون إذا كان للمستخدم صلاحية الوصول إليه، وإلا null */
function salonAccess(user, salonId, { write = false } = {}) {
  const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(salonId);
  if (!salon) return null;
  if (!user) return write ? null : null;
  const root = rootSalonId(salon.id);
  const isOwner = salon.owner_id === user.id || root === salon.id && db.prepare('SELECT 1 FROM salons WHERE id=? AND owner_id=?').get(root, user.id);
  if (user.role === 'owner' && (isOwner || salon.owner_id === user.id)) return salon;
  const isStaff = db.prepare('SELECT 1 FROM staff WHERE salon_id = ? AND user_id = ?').get(root, user.id)
    || db.prepare('SELECT 1 FROM staff WHERE salon_id = ? AND user_id = ?').get(salon.id, user.id);
  if (isStaff) return salon;
  return null;
}

const publicSalon = (s) => ({
  id: s.id, parent_id: s.parent_id, name: s.name, city: s.city, address: s.address,
  phone: s.phone, logo_letter: s.logo_letter, open_time: s.open_time, close_time: s.close_time,
  slot_minutes: s.slot_minutes, closed_weekday: s.closed_weekday, deposit_pct: s.deposit_pct,
  closed_weekday_name: DAY_NAMES[s.closed_weekday],
});

/* ================================================================== */
/*  المسارات                                                           */
/* ================================================================== */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

/* ---------------------------- المصادقة ---------------------------- */
route('POST', '/api/auth/register', async (req, res, { body }) => {
  const name = str(body.name), email = str(body.email).toLowerCase(), password = str(body.password);
  const phone = str(body.phone);
  const role = ['owner', 'customer'].includes(body.role) ? body.role : 'customer';
  if (!name || !email || !password) return fail(res, 400, 'الاسم والبريد وكلمة المرور مطلوبة.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'البريد الإلكتروني غير صالح.');
  if (password.length < 6) return fail(res, 400, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(res, 409, 'هذا البريد مسجّل مسبقاً.');
  const colors = ['#2F3FB0', '#F0A81C', '#12805A', '#B42318', '#7C3AED'];
  const info = db.prepare('INSERT INTO users(name,email,phone,password_hash,role,avatar_color) VALUES (?,?,?,?,?,?)')
    .run(name, email, phone, hashPassword(password), role, colors[Math.floor(Math.random() * colors.length)]);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return created(res, { token: createToken({ uid: user.id, role: user.role }), user: publicUser(user) });
});

route('POST', '/api/auth/login', async (req, res, { body }) => {
  const email = str(body.email).toLowerCase(), password = str(body.password);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) return fail(res, 401, 'البريد أو كلمة المرور غير صحيحة.');
  return ok(res, { token: createToken({ uid: user.id, role: user.role }), user: publicUser(user) });
});

route('GET', '/api/auth/me', async (req, res, { user }) => {
  if (!user) return fail(res, 401, 'غير مصرّح.');
  return ok(res, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

route('PATCH', '/api/auth/me', async (req, res, { user, body }) => {
  if (!user) return fail(res, 401, 'غير مصرّح.');
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?')
    .run(str(body.name) || user.name, str(body.phone) || user.phone, user.id);
  return ok(res, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
});

/* -------------------- الدخول والربط عبر واتساب -------------------- */

// حالة خدمة واتساب + حالة ربط المستخدم الحالي
route('GET', '/api/auth/whatsapp/status', async (req, res, { user }) => {
  const link = user ? whatsappLinkFor(user.id) : null;
  return ok(res, {
    config: whatsappPublicConfig(),
    linked: Boolean(link),
    whatsapp: link
      ? { phone: link.wa_phone, name: link.wa_name, verified: Boolean(link.verified), linked_at: link.linked_at, last_login_at: link.last_login_at }
      : null,
    phone: user ? user.phone : null,
  });
});

// الخطوة 1: طلب رمز واتساب (للدخول أو لربط رقم بحساب مسجّل)
route('POST', '/api/auth/whatsapp/start', async (req, res, { user, body }) => {
  const phone = waNumber(body.phone);
  const purpose = str(body.purpose) === 'link' ? 'link' : 'login';
  if (!/^\d{9,15}$/.test(phone)) return fail(res, 400, 'رقم واتساب غير صالح. مثال: 0612345678');
  if (purpose === 'link' && !user) return fail(res, 401, 'يجب تسجيل الدخول لربط واتساب بحسابك.');
  if (purpose === 'link') {
    const owner = db.prepare('SELECT user_id FROM whatsapp_links WHERE wa_phone = ?').get(phone);
    if (owner && owner.user_id !== user.id) return fail(res, 409, 'هذا الرقم مرتبط بحساب آخر.');
  }
  const recent = db.prepare(
    "SELECT COUNT(*) c FROM whatsapp_otps WHERE phone = ? AND created_at >= datetime('now', ?)"
  ).get(phone, `-${OTP_WINDOW_MINUTES} minutes`).c;
  if (recent >= OTP_MAX_PER_WINDOW) return fail(res, 429, 'طلبات كثيرة على هذا الرقم. حاول بعد قليل.');

  const code = issueOtp({ phone, purpose, userId: user ? user.id : null });
  const message = otpMessage(code, { purpose });
  const sent = await sendWhatsAppText(phone, message);
  const simulated = whatsappMode() === 'simulated';
  return ok(res, {
    phone, purpose, expires_in: OTP_TTL_SECONDS,
    mode: whatsappMode(), sent: Boolean(sent.ok),
    wa_link: waLink(phone, message),
    // الرمز يُعاد فقط في وضع المحاكاة (تطوير/عرض) — لا يُعاد أبداً عند ضبط مفاتيح واتساب الحقيقية
    ...(simulated ? { dev_code: code } : {}),
  });
});

// الخطوة 2: التحقق من الرمز — دخول مباشر إن وُجد الحساب، أو طلب إكمال البيانات
route('POST', '/api/auth/whatsapp/verify', async (req, res, { body }) => {
  const phone = waNumber(body.phone);
  const code = str(body.code).replace(/\D/g, '');
  if (!phone || !code) return fail(res, 400, 'رقم الواتساب والرمز مطلوبان.');

  const check = checkOtp({ phone, purpose: 'login', code });
  if (!check.ok) return fail(res, check.status, check.reason);

  const found = findUserByWaPhone(phone);
  if (found) {
    linkWhatsapp(found.id, phone, str(body.wa_name) || null);
    db.prepare("UPDATE whatsapp_links SET last_login_at = datetime('now') WHERE user_id = ?").run(found.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(found.id);
    return ok(res, { registered: true, token: createToken({ uid: fresh.id, role: fresh.role }), user: publicUser(fresh) });
  }
  return ok(res, {
    registered: false,
    needs_registration: true,
    phone,
    signup_token: createToken({ wa_signup: phone }, SIGNUP_TOKEN_TTL),
  });
});

// الخطوة 3 (للحسابات الجديدة): إكمال الاسم/الدور وإنشاء الحساب ومزامنة الرقم
route('POST', '/api/auth/whatsapp/complete', async (req, res, { body }) => {
  const payload = verifyToken(str(body.signup_token));
  const phone = payload && payload.wa_signup ? String(payload.wa_signup) : '';
  if (!phone) return fail(res, 401, 'جلسة التسجيل منتهية. أعد طلب الرمز.');
  const name = str(body.name);
  if (!name) return fail(res, 400, 'الاسم مطلوب.');
  const role = ['owner', 'customer'].includes(body.role) ? body.role : 'customer';

  let user = findUserByWaPhone(phone);
  if (!user) {
    let email = str(body.email).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'البريد الإلكتروني غير صالح.');
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(res, 409, 'هذا البريد مسجّل مسبقاً.');
    if (!email) email = `wa${phone}@whatsapp.hajzi.ma`;
    const colors = ['#2F3FB0', '#F0A81C', '#12805A', '#B42318', '#7C3AED'];
    const info = db.prepare('INSERT INTO users(name,email,phone,password_hash,role,avatar_color) VALUES (?,?,?,?,?,?)')
      .run(name, email, str(body.phone) || localPhone(phone), hashPassword(randomSecret(24)), role, colors[Math.floor(Math.random() * colors.length)]);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  linkWhatsapp(user.id, phone, str(body.wa_name) || null);
  db.prepare("UPDATE whatsapp_links SET last_login_at = datetime('now') WHERE user_id = ?").run(user.id);
  return created(res, { registered: true, token: createToken({ uid: user.id, role: user.role }), user: publicUser(user) });
});

// ربط رقم واتساب بحساب مسجّل (يتطلب تسجيل الدخول + رمزاً أُرسل لغرض الربط)
route('POST', '/api/auth/whatsapp/link', async (req, res, { user, body }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  const phone = waNumber(body.phone);
  const code = str(body.code).replace(/\D/g, '');
  if (!phone || !code) return fail(res, 400, 'رقم الواتساب والرمز مطلوبان.');
  const owner = db.prepare('SELECT user_id FROM whatsapp_links WHERE wa_phone = ?').get(phone);
  if (owner && owner.user_id !== user.id) return fail(res, 409, 'هذا الرقم مرتبط بحساب آخر.');

  const check = checkOtp({ phone, purpose: 'link', code, userId: user.id });
  if (!check.ok) return fail(res, check.status, check.reason);

  linkWhatsapp(user.id, phone, str(body.wa_name) || null);
  return ok(res, { linked: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

// إلغاء ربط واتساب
route('DELETE', '/api/auth/whatsapp/link', async (req, res, { user }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  db.prepare('DELETE FROM whatsapp_links WHERE user_id = ?').run(user.id);
  return ok(res, { unlinked: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

// مزامنة رقم الواتساب المرتبط مع حقل الهاتف في الملف الشخصي
route('POST', '/api/auth/whatsapp/sync', async (req, res, { user }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  const link = whatsappLinkFor(user.id);
  if (!link) return fail(res, 404, 'لا يوجد رقم واتساب مرتبط بحسابك.');
  const local = localPhone(link.wa_phone);
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(local, user.id);
  return ok(res, { synced: true, phone: local, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

/* ---------------------------- الصالونات ---------------------------- */
route('GET', '/api/salons', async (req, res, { query }) => {
  const q = str(query.q).toLowerCase();
  const city = str(query.city);
  let rows = db.prepare('SELECT * FROM salons WHERE active = 1 AND parent_id IS NULL ORDER BY name').all();
  if (city) rows = rows.filter((s) => str(s.city).includes(city));
  if (q) rows = rows.filter((s) => (s.name + ' ' + (s.city || '')).toLowerCase().includes(q));
  const result = rows.map((s) => ({
    ...publicSalon(s),
    branches: db.prepare('SELECT id,name,city FROM salons WHERE parent_id = ? AND active = 1').all(s.id),
    services_count: db.prepare('SELECT COUNT(*) c FROM services WHERE salon_id = ? AND active = 1').get(s.id).c,
    rating: 4.5 + (s.id % 5) / 10,
  }));
  return ok(res, { salons: result, cities: [...new Set(db.prepare('SELECT DISTINCT city FROM salons WHERE city IS NOT NULL').all().map((r) => r.city))] });
});

route('GET', '/api/salons/:id', async (req, res, { params }) => {
  const s = db.prepare('SELECT * FROM salons WHERE id = ?').get(params.id);
  if (!s) return fail(res, 404, 'الصالون غير موجود.');
  const services = db.prepare('SELECT * FROM services WHERE salon_id = ? AND active = 1 ORDER BY id').all(s.id);
  const staff = db.prepare('SELECT * FROM staff WHERE salon_id = ? AND active = 1 ORDER BY id').all(s.id);
  const staffServices = db.prepare('SELECT staff_id, service_id FROM staff_services').all();
  const branches = db.prepare('SELECT * FROM salons WHERE parent_id = ? AND active = 1').all(s.id);
  const owner = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(s.owner_id);
  return ok(res, {
    salon: publicSalon(s),
    owner,
    services,
    staff: staff.map((st) => ({ ...st, service_ids: staffServices.filter((x) => x.staff_id === st.id).map((x) => x.service_id) })),
    branches: branches.map(publicSalon),
  });
});

route('POST', '/api/salons', async (req, res, { user, body }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  if (user.role !== 'owner') return fail(res, 403, 'إنشاء الصالونات متاح لأصحاب الصالونات فقط.');
  const name = str(body.name);
  if (!name) return fail(res, 400, 'اسم الصالون مطلوب.');
  const parent = body.parent_id ? int(body.parent_id) : null;
  if (parent && !salonAccess(user, parent, { write: true })) return fail(res, 403, 'لا تملك صلاحية على الصالون الأم.');
  const info = db.prepare(
    `INSERT INTO salons(parent_id,owner_id,name,city,address,phone,logo_letter,open_time,close_time,slot_minutes,closed_weekday,deposit_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(parent, user.id, name, str(body.city), str(body.address), str(body.phone),
    name[0] || 'ص', str(body.open_time) || '09:00', str(body.close_time) || '18:00',
    int(body.slot_minutes, 30), int(body.closed_weekday, 0), int(body.deposit_pct, 20));
  return created(res, { salon: db.prepare('SELECT * FROM salons WHERE id = ?').get(info.lastInsertRowid) });
});

route('PATCH', '/api/salons/:id', async (req, res, { user, params, body }) => {
  const salon = salonAccess(user, params.id, { write: true });
  if (!salon) return fail(res, 403, 'لا تملك صلاحية تعديل هذا الصالون.');
  const f = (k, def) => (body[k] === undefined ? def : body[k]);
  db.prepare(
    `UPDATE salons SET name=?, city=?, address=?, phone=?, open_time=?, close_time=?, slot_minutes=?, closed_weekday=?, deposit_pct=?, active=? WHERE id=?`
  ).run(
    str(f('name', salon.name)) || salon.name, str(f('city', salon.city)), str(f('address', salon.address)), str(f('phone', salon.phone)),
    str(f('open_time', salon.open_time)), str(f('close_time', salon.close_time)), int(f('slot_minutes', salon.slot_minutes)),
    int(f('closed_weekday', salon.closed_weekday)), int(f('deposit_pct', salon.deposit_pct)), bool(f('active', salon.active)) ? 1 : 0, salon.id
  );
  return ok(res, { salon: db.prepare('SELECT * FROM salons WHERE id = ?').get(salon.id) });
});

route('DELETE', '/api/salons/:id', async (req, res, { user, params }) => {
  const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(params.id);
  if (!salon) return fail(res, 404, 'الصالون غير موجود.');
  if (!user || salon.owner_id !== user.id) return fail(res, 403, 'لا تملك صلاحية حذف هذا الصالون.');
  db.prepare('UPDATE salons SET active = 0 WHERE id = ?').run(salon.id);
  return ok(res, { deleted: true });
});

route('GET', '/api/my/salons', async (req, res, { user }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  const owned = db.prepare('SELECT * FROM salons WHERE owner_id = ? ORDER BY parent_id IS NOT NULL, name').all(user.id);
  const staffOf = db.prepare(
    'SELECT s.* FROM salons s JOIN staff st ON st.salon_id = s.id WHERE st.user_id = ?'
  ).all(user.id);
  const all = [...owned, ...staffOf.filter((s) => !owned.some((o) => o.id === s.id))];
  return ok(res, {
    salons: all.map((s) => ({
      ...publicSalon(s),
      role: s.owner_id === user.id ? 'owner' : 'staff',
      parent_name: s.parent_id ? db.prepare('SELECT name FROM salons WHERE id=?').get(s.parent_id)?.name : null,
      branches: db.prepare('SELECT id,name FROM salons WHERE parent_id=? AND active=1').all(s.id),
    })),
  });
});

/* ---------------------------- الخدمات ---------------------------- */
route('POST', '/api/salons/:id/services', async (req, res, { user, params, body }) => {
  const salon = salonAccess(user, params.id, { write: true });
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const name = str(body.name);
  if (!name) return fail(res, 400, 'اسم الخدمة مطلوب.');
  const info = db.prepare('INSERT INTO services(salon_id,name,price,minutes) VALUES (?,?,?,?)')
    .run(salon.id, name, int(body.price, 0), int(body.minutes, 30));
  return created(res, { service: db.prepare('SELECT * FROM services WHERE id=?').get(info.lastInsertRowid) });
});

route('PATCH', '/api/services/:id', async (req, res, { user, params, body }) => {
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(params.id);
  if (!svc) return fail(res, 404, 'الخدمة غير موجودة.');
  if (!salonAccess(user, svc.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  db.prepare('UPDATE services SET name=?, price=?, minutes=?, active=? WHERE id=?')
    .run(str(body.name) || svc.name, int(body.price, svc.price), int(body.minutes, svc.minutes),
      body.active === undefined ? svc.active : (bool(body.active) ? 1 : 0), svc.id);
  return ok(res, { service: db.prepare('SELECT * FROM services WHERE id=?').get(svc.id) });
});

route('DELETE', '/api/services/:id', async (req, res, { user, params }) => {
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(params.id);
  if (!svc) return fail(res, 404, 'الخدمة غير موجودة.');
  if (!salonAccess(user, svc.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(svc.id);
  return ok(res, { deleted: true });
});

/* ---------------------------- الطاقم ---------------------------- */
route('POST', '/api/salons/:id/staff', async (req, res, { user, params, body }) => {
  const salon = salonAccess(user, params.id, { write: true });
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const name = str(body.name);
  if (!name) return fail(res, 400, 'اسم الموظفة مطلوب.');
  const info = db.prepare('INSERT INTO staff(salon_id,user_id,name,title,phone,color) VALUES (?,?,?,?,?,?)')
    .run(salon.id, body.user_id ? int(body.user_id) : null, name, str(body.title), str(body.phone), str(body.color) || '#2F3FB0');
  const staffId = info.lastInsertRowid;
  for (const sid of Array.isArray(body.service_ids) ? body.service_ids : []) {
    db.prepare('INSERT OR IGNORE INTO staff_services(staff_id,service_id) VALUES (?,?)').run(staffId, int(sid));
  }
  return created(res, { staff: db.prepare('SELECT * FROM staff WHERE id=?').get(staffId) });
});

route('PATCH', '/api/staff/:id', async (req, res, { user, params, body }) => {
  const st = db.prepare('SELECT * FROM staff WHERE id = ?').get(params.id);
  if (!st) return fail(res, 404, 'الموظفة غير موجودة.');
  if (!salonAccess(user, st.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  db.prepare('UPDATE staff SET name=?, title=?, phone=?, color=?, active=? WHERE id=?')
    .run(str(body.name) || st.name, body.title === undefined ? st.title : str(body.title),
      body.phone === undefined ? st.phone : str(body.phone), str(body.color) || st.color,
      body.active === undefined ? st.active : (bool(body.active) ? 1 : 0), st.id);
  if (Array.isArray(body.service_ids)) {
    db.prepare('DELETE FROM staff_services WHERE staff_id = ?').run(st.id);
    for (const sid of body.service_ids) db.prepare('INSERT OR IGNORE INTO staff_services(staff_id,service_id) VALUES (?,?)').run(st.id, int(sid));
  }
  return ok(res, { staff: db.prepare('SELECT * FROM staff WHERE id=?').get(st.id) });
});

route('DELETE', '/api/staff/:id', async (req, res, { user, params }) => {
  const st = db.prepare('SELECT * FROM staff WHERE id = ?').get(params.id);
  if (!st) return fail(res, 404, 'الموظفة غير موجودة.');
  if (!salonAccess(user, st.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  db.prepare('UPDATE staff SET active = 0 WHERE id = ?').run(st.id);
  return ok(res, { deleted: true });
});

/* ---------------------------- التوفر ---------------------------- */
route('GET', '/api/salons/:id/availability', async (req, res, { params, query }) => {
  const s = db.prepare('SELECT * FROM salons WHERE id = ?').get(params.id);
  if (!s) return fail(res, 404, 'الصالون غير موجود.');
  const date = str(query.date) || dateKey();
  const serviceId = int(query.service_id);
  const staffId = query.staff_id ? int(query.staff_id) : null;
  const weekday = new Date(date + 'T12:00:00').getDay();
  if (weekday === s.closed_weekday) return ok(res, { date, closed: true, slots: [] });

  const duration = serviceId
    ? (db.prepare('SELECT minutes FROM services WHERE id = ?').get(serviceId)?.minutes || s.slot_minutes)
    : s.slot_minutes;
  const booked = db.prepare(
    `SELECT time, staff_id FROM bookings WHERE salon_id = ? AND date = ? AND status IN ('pending','confirmed')`
  ).all(s.id, date);

  const staffIds = staffId
    ? [staffId]
    : db.prepare('SELECT id FROM staff WHERE salon_id = ? AND active = 1').all(s.id).map((r) => r.id);

  const now = new Date();
  const isToday = date === dateKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const slots = slotsFor(s).map((t) => {
    const start = minutesOf(t);
    if (isToday && start <= nowMin) return { time: t, available: false, reason: 'past' };
    // الأخصائيات المتاحات في هذه الفترة
    const free = staffIds.filter((id) =>
      !booked.some((b) => b.time === t && b.staff_id === id)
    );
    // هل الفترة طويلة بما يكفي للخدمة المطلوبة؟
    const capacity = staffIds.length === 0 ? true : free.length > 0;
    const enoughRoom = minutesOf(s.close_time) - start >= duration;
    return {
      time: t,
      available: capacity && enoughRoom,
      staff_ids: free,
      reason: !capacity ? 'full' : (!enoughRoom ? 'short' : null),
    };
  });
  return ok(res, { date, closed: false, duration, slots });
});

/* ---------------------------- الحجوزات ---------------------------- */
route('POST', '/api/bookings', async (req, res, { user, body }) => {
  const salonId = int(body.salon_id);
  const salon = db.prepare('SELECT * FROM salons WHERE id = ? AND active = 1').get(salonId);
  if (!salon) return fail(res, 404, 'الصالون غير موجود.');
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND salon_id = ? AND active = 1').get(int(body.service_id), salonId);
  if (!service) return fail(res, 400, 'الخدمة غير صالحة لهذا الصالون.');
  const date = str(body.date), time = str(body.time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return fail(res, 400, 'التاريخ أو الوقت غير صالح.');
  const customer_name = str(body.customer_name) || (user ? user.name : '');
  const customer_phone = str(body.customer_phone) || (user ? user.phone : '');
  if (!customer_name || customer_phone.replace(/\D/g, '').length < 9) return fail(res, 400, 'الاسم ورقم هاتف صالح مطلوبان.');

  const weekday = new Date(date + 'T12:00:00').getDay();
  if (weekday === salon.closed_weekday) return fail(res, 400, 'الصالون مغلق في هذا اليوم.');
  const duration = service.minutes;
  if (minutesOf(salon.close_time) - minutesOf(time) < duration) return fail(res, 400, 'الوقت المختار لا يتّسع لمدة الخدمة.');

  let staffId = body.staff_id ? int(body.staff_id) : null;
  const booked = db.prepare("SELECT staff_id FROM bookings WHERE salon_id=? AND date=? AND time=? AND status IN ('pending','confirmed')").all(salonId, date, time);
  if (staffId) {
    if (booked.some((b) => b.staff_id === staffId)) return fail(res, 409, 'هذه الأخصائية محجوزة في هذا الوقت.');
  } else {
    const allStaff = db.prepare('SELECT id FROM staff WHERE salon_id=? AND active=1').all(salonId).map((r) => r.id);
    const busy = new Set(booked.map((b) => b.staff_id));
    if (allStaff.length > 0) {
      staffId = allStaff.find((id) => !busy.has(id)) ?? null;
      if (staffId === null) return fail(res, 409, 'كل الأخصائيات محجوزات في هذا الوقت.');
    }
  }

  const deposit = Math.round((service.price * salon.deposit_pct) / 100);
  const info = db.prepare(
    `INSERT INTO bookings(salon_id,staff_id,service_id,customer_id,customer_name,customer_phone,date,time,status,price,deposit,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(salonId, staffId, service.id, user ? user.id : null, customer_name, customer_phone, date, time,
    body.confirm_now ? 'confirmed' : 'pending', service.price, deposit, str(body.notes));
  const bookingId = info.lastInsertRowid;

  const payToken = newPayToken();
  const payment = db.prepare('INSERT INTO payments(booking_id,amount,kind,method,status,provider,pay_token,provider_ref) VALUES (?,?,?,?,?,?,?,?)')
    .run(bookingId, deposit, 'deposit', 'card', 'pending', currentProvider(), payToken, 'PAY-' + Date.now().toString(36).toUpperCase());

  const staff = staffId ? db.prepare('SELECT * FROM staff WHERE id=?').get(staffId) : null;
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  queueNotification({
    booking_id: bookingId, salon_id: salonId, channel: str(body.channel) || 'whatsapp', phone: customer_phone,
    message: bookingMessage({ salon, service, staff, booking, kind: 'confirmation' }),
  });

  return created(res, {
    booking, service, staff,
    payment: db.prepare('SELECT * FROM payments WHERE id=?').get(payment.lastInsertRowid),
    pay_url: `${publicBaseUrl()}/pay/${payToken}`,
    payment_provider: currentProvider(),
  });
});

route('GET', '/api/my/bookings', async (req, res, { user }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  const rows = db.prepare(
    `SELECT b.*, s.name AS salon_name, s.city AS salon_city, sv.name AS service_name, sv.minutes AS service_minutes,
            st.name AS staff_name,
            (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.booking_id=b.id AND p.status='paid') AS paid_amount
     FROM bookings b
     JOIN salons s ON s.id = b.salon_id
     JOIN services sv ON sv.id = b.service_id
     LEFT JOIN staff st ON st.id = b.staff_id
     WHERE b.customer_id = ? OR b.customer_phone = ?
     ORDER BY b.date DESC, b.time DESC`
  ).all(user.id, user.phone || '');
  return ok(res, { bookings: rows });
});

route('GET', '/api/salons/:id/bookings', async (req, res, { user, params, query }) => {
  const salon = salonAccess(user, params.id);
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const date = str(query.date);
  const status = str(query.status);
  const from = str(query.from), to = str(query.to);
  let sql = `SELECT b.*, sv.name AS service_name, sv.minutes AS service_minutes, st.name AS staff_name,
                    (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.booking_id=b.id AND p.status='paid') AS paid_amount
             FROM bookings b JOIN services sv ON sv.id=b.service_id LEFT JOIN staff st ON st.id=b.staff_id
             WHERE b.salon_id = ?`;
  const args = [salon.id];
  if (date) { sql += ' AND b.date = ?'; args.push(date); }
  if (from) { sql += ' AND b.date >= ?'; args.push(from); }
  if (to) { sql += ' AND b.date <= ?'; args.push(to); }
  if (status) { sql += ' AND b.status = ?'; args.push(status); }
  sql += ' ORDER BY b.date ASC, b.time ASC';
  return ok(res, { bookings: db.prepare(sql).all(...args) });
});

route('GET', '/api/bookings/:id', async (req, res, { user, params }) => {
  const b = db.prepare(
    `SELECT b.*, s.name AS salon_name, s.address AS salon_address, s.phone AS salon_phone,
            sv.name AS service_name, sv.minutes AS service_minutes, st.name AS staff_name
     FROM bookings b JOIN salons s ON s.id=b.salon_id JOIN services sv ON sv.id=b.service_id
     LEFT JOIN staff st ON st.id=b.staff_id WHERE b.id = ?`
  ).get(params.id);
  if (!b) return fail(res, 404, 'الحجز غير موجود.');
  const isMine = user && (b.customer_id === user.id || (user.phone && b.customer_phone === user.phone));
  if (!isMine && !salonAccess(user, b.salon_id)) return fail(res, 403, 'لا تملك صلاحية.');
  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY id').all(b.id);
  return ok(res, { booking: b, payments });
});

route('PATCH', '/api/bookings/:id', async (req, res, { user, params, body }) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(params.id);
  if (!b) return fail(res, 404, 'الحجز غير موجود.');
  const isMine = user && (b.customer_id === user.id || (user.phone && b.customer_phone === user.phone));
  const salon = salonAccess(user, b.salon_id, { write: true });
  if (!isMine && !salon) return fail(res, 403, 'لا تملك صلاحية.');

  const status = str(body.status);
  const allowed = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
  if (status && !allowed.includes(status)) return fail(res, 400, 'حالة غير صالحة.');
  if (isMine && !salon && status && !['cancelled'].includes(status)) return fail(res, 403, 'يمكنك إلغاء حجزك فقط.');

  const patch = {
    status: status || b.status,
    date: body.date ? str(body.date) : b.date,
    time: body.time ? str(body.time) : b.time,
    staff_id: body.staff_id !== undefined ? (body.staff_id ? int(body.staff_id) : null) : b.staff_id,
    notes: body.notes !== undefined ? str(body.notes) : b.notes,
  };
  db.prepare('UPDATE bookings SET status=?, date=?, time=?, staff_id=?, notes=? WHERE id=?')
    .run(patch.status, patch.date, patch.time, patch.staff_id, patch.notes, b.id);

  const updated = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  if (status === 'cancelled' && b.status !== 'cancelled') {
    const full = db.prepare('SELECT * FROM salons WHERE id=?').get(b.salon_id);
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(b.service_id);
    queueNotification({ booking_id: b.id, salon_id: b.salon_id, channel: 'whatsapp', phone: b.customer_phone, message: bookingMessage({ salon: full, service: svc, staff: null, booking: updated, kind: 'cancel' }) });
  }
  if (status === 'confirmed' && b.status !== 'confirmed') {
    const full = db.prepare('SELECT * FROM salons WHERE id=?').get(b.salon_id);
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(b.service_id);
    const st = b.staff_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(b.staff_id) : null;
    queueNotification({ booking_id: b.id, salon_id: b.salon_id, channel: 'whatsapp', phone: b.customer_phone, message: bookingMessage({ salon: full, service: svc, staff: st, booking: updated, kind: 'confirmation' }) });
  }
  return ok(res, { booking: updated });
});

/* ---------------------------- المدفوعات ---------------------------- */
route('POST', '/api/payments/:id/pay', async (req, res, { user, params, body }) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(params.id);
  if (!p) return fail(res, 404, 'الدفعة غير موجودة.');
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(p.booking_id);
  const isMine = user && (b.customer_id === user.id || (user.phone && b.customer_phone === user.phone));
  if (!isMine && !salonAccess(user, b.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  if (p.status === 'paid') return fail(res, 409, 'هذه الدفعة مدفوعة مسبقاً.');

  const canWrite = Boolean(salonAccess(user, b.salon_id, { write: true }));
  const method = ['card', 'cash', 'transfer', 'wallet'].includes(str(body.method)) ? str(body.method) : 'card';
  const isOffline = method === 'cash' || method === 'transfer';

  // الدفع النقدي/التحويل يُسجّله الطاقم فقط (تحصيل في الصالون)
  if (isOffline && !canWrite) return fail(res, 403, 'تسجيل الدفع النقدي متاح لطاقم الصالون فقط.');

  // الدفع الإلكتروني يمرّ إجبارياً عبر صفحة الدفع الآمنة (ما لم يكن الوضع تجريبياً)
  if (!isOffline && p.provider && p.provider !== 'simulated' && !canWrite) {
    const token = ensurePayToken(p.id);
    return fail(res, 409, 'يجب إتمام الدفع الإلكتروني عبر صفحة الدفع الآمنة.', {
      code: 'USE_SECURE_CHECKOUT',
      pay_url: `${publicBaseUrl()}/pay/${token}`,
    });
  }

  const { markPaid } = await import('./payments/index.js');
  const result = markPaid(p.id, {
    provider: isOffline ? 'manual' : (p.provider || 'simulated'),
    ref: 'TX-' + Date.now().toString(36).toUpperCase(),
    method,
  });
  if (!result.ok) return fail(res, 409, result.reason || 'تعذّر تحديث الدفعة.');
  return ok(res, {
    payment: db.prepare('SELECT * FROM payments WHERE id=?').get(p.id),
    booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id),
  });
});

route('POST', '/api/bookings/:id/pay-remaining', async (req, res, { user, params, body }) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(params.id);
  if (!b) return fail(res, 404, 'الحجز غير موجود.');
  if (!salonAccess(user, b.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE booking_id=? AND status='paid' AND kind!='refund'").get(b.id).s;
  const remaining = b.price - paid;
  if (remaining <= 0) return fail(res, 409, 'لا يوجد مبلغ متبقٍ.');

  const method = str(body.method) || 'cash';
  const isOffline = method === 'cash' || method === 'transfer';

  if (isOffline) {
    // تحصيل مباشر في الصالون (نقداً أو تحويلاً)
    const info = db.prepare("INSERT INTO payments(booking_id,amount,kind,method,status,provider,provider_ref,paid_at) VALUES (?,?,'full',?,'paid','manual',?,?)")
      .run(b.id, remaining, method, 'TX-' + Date.now().toString(36).toUpperCase(), isoNow());
    if (b.status !== 'completed') db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(b.id);
    return ok(res, { payment: db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid), paid: true });
  }

  // دفع إلكتروني: أنشئ دفعة معلّقة مع رابط دفع آمن
  const token = newPayToken();
  const info = db.prepare("INSERT INTO payments(booking_id,amount,kind,method,status,provider,pay_token,provider_ref) VALUES (?,?,'full','card','pending',?,?,?)")
    .run(b.id, remaining, currentProvider(), token, 'PAY-' + Date.now().toString(36).toUpperCase());
  return created(res, {
    payment: db.prepare('SELECT * FROM payments WHERE id=?').get(info.lastInsertRowid),
    pay_url: `${publicBaseUrl()}/pay/${token}`,
    paid: false,
  });
});

route('GET', '/api/salons/:id/payments', async (req, res, { user, params, query }) => {
  const salon = salonAccess(user, params.id);
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const days = int(query.days, 30);
  const rows = db.prepare(
    `SELECT p.*, b.customer_name, b.date AS booking_date, sv.name AS service_name
     FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN services sv ON sv.id=b.service_id
     WHERE b.salon_id = ? AND p.created_at >= datetime('now', ?)
     ORDER BY p.id DESC LIMIT 200`
  ).all(salon.id, `-${days} days`);
  const totals = {
    paid: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0),
    pending: rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount, 0),
  };
  return ok(res, { payments: rows, totals });
});

/* -------------------- الدفع الإلكتروني (Checkout) -------------------- */

// يهيّئ جلسة دفع لدى المزوّد ويعيد رابط صفحة الدفع الآمنة
route('POST', '/api/payments/:id/checkout', async (req, res, { user, params }) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(params.id);
  if (!p) return fail(res, 404, 'الدفعة غير موجودة.');
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(p.booking_id);
  const isMine = user && (b.customer_id === user.id || (user.phone && b.customer_phone === user.phone));
  if (!isMine && !salonAccess(user, b.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  if (p.status === 'paid') return fail(res, 409, 'هذه الدفعة مدفوعة مسبقاً.');

  const token = ensurePayToken(p.id);
  const provider = currentProvider();
  return ok(res, {
    url: `${publicBaseUrl()}/pay/${token}`,
    token,
    provider,
    ready: providerReady(provider),
    amount: p.amount,
    kind: p.kind,
  });
});

// حالة الدفعة عبر رمزها الآمن (عام — الرمز نفسه هو السرّ)
route('GET', '/api/pay/:token/status', async (req, res, { params }) => {
  const p = findPaymentByToken(params.token);
  if (!p) return fail(res, 404, 'رابط دفع غير صالح.');
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(p.booking_id);
  return ok(res, {
    status: p.status,
    amount: p.amount,
    kind: p.kind,
    provider: p.provider,
    paid_at: p.paid_at,
    failure_reason: p.failure_reason,
    booking_status: b ? b.status : null,
  });
});

// حالة مزوّد الدفع (لصاحب الصالون — بلا أي مفاتيح سرّية)
route('GET', '/api/settings/payment', async (req, res, { user }) => {
  if (!user || user.role !== 'owner') return fail(res, 403, 'متاح لصاحب الصالون فقط.');
  return ok(res, providerStatus());
});

// تغيير مزوّد الدفع أو رابط الموقع العام
route('PATCH', '/api/settings/payment', async (req, res, { user, body }) => {
  if (!user || user.role !== 'owner') return fail(res, 403, 'متاح لصاحب الصالون فقط.');

  if (body.provider !== undefined) {
    const p = str(body.provider);
    if (!PROVIDERS.includes(p)) return fail(res, 400, 'مزوّد دفع غير معروف.');
    if (!providerReady(p)) {
      const missing = p === 'stripe' ? 'STRIPE_SECRET_KEY و STRIPE_WEBHOOK_SECRET' : 'CMI_MERCHANT_ID و CMI_STORE_KEY';
      return fail(res, 400, `المزوّد «${p}» غير مُهيّأ على الخادم: أضف ${missing} في متغيرات البيئة أولاً.`);
    }
    setSetting('payment_provider', p);
  }

  if (body.public_base_url !== undefined) {
    const u = str(body.public_base_url).replace(/\/+$/, '');
    if (u && !/^https?:\/\/.+/i.test(u)) return fail(res, 400, 'رابط الموقع العام يجب أن يبدأ بـ http:// أو https://');
    setSetting('public_base_url', u);
  }

  return ok(res, providerStatus());
});

/* ---------------------------- الإشعارات ---------------------------- */
route('GET', '/api/salons/:id/notifications', async (req, res, { user, params, query }) => {
  const salon = salonAccess(user, params.id);
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const rows = db.prepare(
    `SELECT n.*, b.customer_name, b.date AS booking_date, b.time AS booking_time
     FROM notifications n LEFT JOIN bookings b ON b.id=n.booking_id
     WHERE n.salon_id = ? ORDER BY n.id DESC LIMIT 200`
  ).all(salon.id);
  return ok(res, { notifications: rows.map((r) => ({ ...r, link: waLink(r.to_phone, r.message) })) });
});

route('POST', '/api/notifications/:id/send', async (req, res, { user, params }) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(params.id);
  if (!n) return fail(res, 404, 'الإشعار غير موجود.');
  if (n.salon_id && !salonAccess(user, n.salon_id, { write: true })) return fail(res, 403, 'لا تملك صلاحية.');
  db.prepare("UPDATE notifications SET status='sent', sent_at=? WHERE id=?").run(isoNow(), n.id);
  const updated = db.prepare('SELECT * FROM notifications WHERE id=?').get(n.id);
  return ok(res, { notification: updated, link: waLink(updated.to_phone, updated.message) });
});

// جدولة تذكيرات مواعيد الغد لكل الحجوزات المؤكّدة
route('POST', '/api/salons/:id/reminders', async (req, res, { user, params }) => {
  const salon = salonAccess(user, params.id, { write: true });
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const tomorrow = dateKey(new Date(Date.now() + 86400000));
  const list = db.prepare(
    `SELECT b.*, sv.name AS service_name FROM bookings b JOIN services sv ON sv.id=b.service_id
     WHERE b.salon_id=? AND b.date=? AND b.status='confirmed'`
  ).all(salon.id, tomorrow);
  let queued = 0;
  for (const b of list) {
    const exists = db.prepare(
      "SELECT 1 FROM notifications WHERE booking_id=? AND status='queued' AND message LIKE '%تذكير%'"
    ).get(b.id);
    if (exists) continue;
    queueNotification({
      booking_id: b.id, salon_id: salon.id, channel: str(req._body?.channel) || 'whatsapp', phone: b.customer_phone,
      message: bookingMessage({ salon, service: { name: b.service_name }, staff: null, booking: b, kind: 'reminder' }),
      scheduled_at: `${tomorrow} 09:00:00`,
    });
    queued++;
  }
  return ok(res, { queued, date: tomorrow });
});

/* ---------------------------- التحليلات ---------------------------- */
route('GET', '/api/salons/:id/analytics', async (req, res, { user, params, query }) => {
  const salon = salonAccess(user, params.id);
  if (!salon) return fail(res, 403, 'لا تملك صلاحية.');
  const days = int(query.days, 30);
  const since = `-${days} days`;

  const bookings = db.prepare(
    `SELECT b.*, sv.name AS service_name, sv.price AS service_price, st.name AS staff_name
     FROM bookings b JOIN services sv ON sv.id=b.service_id LEFT JOIN staff st ON st.id=b.staff_id
     WHERE b.salon_id=? AND b.date >= date('now', ?)`
  ).all(salon.id, since);

  const payments = db.prepare(
    `SELECT p.*, b.date AS booking_date FROM payments p JOIN bookings b ON b.id=p.booking_id
     WHERE b.salon_id=? AND p.status='paid' AND p.created_at >= datetime('now', ?)`
  ).all(salon.id, since);

  const revenue = payments.filter((p) => p.kind !== 'refund').reduce((s, p) => s + p.amount, 0);
  const completed = bookings.filter((b) => b.status === 'completed').length;
  const cancelled = bookings.filter((b) => ['cancelled', 'no_show'].includes(b.status)).length;

  // السلسلة اليومية
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const dayBookings = bookings.filter((b) => b.date === key);
    series.push({
      date: key,
      bookings: dayBookings.length,
      revenue: payments.filter((p) => (p.booking_date || '').slice(0, 10) === key && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0),
    });
  }

  // أفضل الخدمات
  const byService = {};
  for (const b of bookings) {
    byService[b.service_name] = byService[b.service_name] || { name: b.service_name, count: 0, revenue: 0 };
    byService[b.service_name].count++;
    byService[b.service_name].revenue += b.service_price;
  }
  const topServices = Object.values(byService).sort((a, b) => b.revenue - a.revenue).slice(0, 6);

  // أداء الطاقم
  const byStaff = {};
  for (const b of bookings) {
    const k = b.staff_name || 'بدون تعيين';
    byStaff[k] = byStaff[k] || { name: k, count: 0, revenue: 0, completed: 0 };
    byStaff[k].count++;
    if (b.status === 'completed') { byStaff[k].completed++; byStaff[k].revenue += b.service_price; }
  }
  const staffPerf = Object.values(byStaff).sort((a, b) => b.revenue - a.revenue);

  // توزيع الساعات
  const byHour = Array.from({ length: 13 }, (_, i) => ({ hour: i + 8, count: 0 }));
  for (const b of bookings) {
    const h = parseInt(String(b.time).slice(0, 2), 10);
    const slot = byHour.find((x) => x.hour === h);
    if (slot) slot.count++;
  }

  const today = dateKey();
  const todays = bookings.filter((b) => b.date === today);

  return ok(res, {
    range_days: days,
    kpis: {
      revenue,
      bookings: bookings.length,
      completed,
      cancelled,
      cancel_rate: bookings.length ? Math.round((cancelled / bookings.length) * 100) : 0,
      avg_ticket: completed ? Math.round(revenue / completed) : 0,
      today_count: todays.length,
      today_revenue: payments.filter((p) => (p.booking_date || '').slice(0, 10) === today && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0),
      pending_payments: db.prepare("SELECT COUNT(*) c FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.salon_id=? AND p.status='pending'").get(salon.id).c,
    },
    series,
    top_services: topServices,
    staff: staffPerf,
    by_hour: byHour,
    status_breakdown: ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'].map((st) => ({
      status: st, count: bookings.filter((b) => b.status === st).length,
    })),
  });
});

/* ---------------------------- لوحة عامة ---------------------------- */
route('GET', '/api/stats/overview', async (req, res, { user }) => {
  if (!user) return fail(res, 401, 'يجب تسجيل الدخول.');
  const mySalons = db.prepare('SELECT id FROM salons WHERE owner_id = ?').all(user.id).map((r) => r.id);
  if (!mySalons.length) return ok(res, { salons: 0, revenue: 0, bookings: 0 });
  const ph = mySalons.map(() => '?').join(',');
  const revenue = db.prepare(
    `SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN bookings b ON b.id=p.booking_id
     WHERE b.salon_id IN (${ph}) AND p.status='paid' AND p.kind!='refund'`
  ).get(...mySalons).s;
  const bookings = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE salon_id IN (${ph})`).get(...mySalons).c;
  return ok(res, { salons: mySalons.length, revenue, bookings });
});

/* ================================================================== */
/*  الموجّه (Router)                                                   */
/* ================================================================== */
function match(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export async function handleApi(req, res, pathname, query) {
  const routeDef = routes.find((r) => r.method === req.method && match(r.pattern, pathname));
  if (!routeDef) return fail(res, 404, 'المسار غير موجود.');
  const params = match(routeDef.pattern, pathname);
  let body = {};
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    try { body = await readBody(req); }
    catch (e) { return fail(res, e.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, 'جسم الطلب غير صالح.'); }
  }
  req._body = body;
  try {
    return await routeDef.handler(req, res, { user: currentUser(req), params, query, body });
  } catch (err) {
    console.error('[API ERROR]', req.method, pathname, err);
    return fail(res, 500, 'خطأ داخلي في الخادم.');
  }
}
