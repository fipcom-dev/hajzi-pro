// src/db.js — طبقة قاعدة البيانات (SQLite عبر node:sqlite المدمج، بلا أي مكتبات خارجية)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const DB_PATH = process.env.HAJZI_DB || resolve(ROOT, 'data', 'hajzi.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ------------------------------------------------------------------ */
/* المخطط (Schema)                                                     */
/* ------------------------------------------------------------------ */
export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('owner','staff','customer')),
    avatar_color  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- الصالونات: parent_id يمثّل الفرع التابع لصالون أم
  CREATE TABLE IF NOT EXISTS salons (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id      INTEGER REFERENCES salons(id) ON DELETE CASCADE,
    owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    city           TEXT,
    address        TEXT,
    phone          TEXT,
    logo_letter    TEXT,
    open_time      TEXT NOT NULL DEFAULT '09:00',
    close_time     TEXT NOT NULL DEFAULT '18:00',
    slot_minutes   INTEGER NOT NULL DEFAULT 30,
    closed_weekday INTEGER NOT NULL DEFAULT 0, -- 0 = الأحد
    deposit_pct    INTEGER NOT NULL DEFAULT 20, -- نسبة العربون %
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id  INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    price     INTEGER NOT NULL DEFAULT 0,
    minutes   INTEGER NOT NULL DEFAULT 30,
    active    INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS staff (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id  INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name      TEXT NOT NULL,
    title     TEXT,
    phone     TEXT,
    color     TEXT,
    active    INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS staff_services (
    staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    PRIMARY KEY (staff_id, service_id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id       INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    staff_id       INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    service_id     INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    customer_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    date           TEXT NOT NULL,           -- YYYY-MM-DD
    time           TEXT NOT NULL,           -- HH:MM
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
    price          INTEGER NOT NULL DEFAULT 0,
    deposit        INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_salon_date ON bookings(salon_id, date);
  CREATE INDEX IF NOT EXISTS idx_bookings_customer   ON bookings(customer_id);

  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    amount       INTEGER NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'deposit' CHECK (kind IN ('deposit','full','refund')),
    method       TEXT NOT NULL DEFAULT 'card' CHECK (method IN ('card','cash','transfer','wallet')),
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
    provider_ref TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id   INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
    salon_id     INTEGER REFERENCES salons(id) ON DELETE CASCADE,
    channel      TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','sms')),
    to_phone     TEXT NOT NULL,
    message      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
    scheduled_at TEXT,
    sent_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- إعدادات عامة (مزوّد الدفع، رابط الموقع العام...) — لا تُخزَّن فيها مفاتيح سرّية
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ربط حسابات واتساب بالمستخدمين (الدخول بواتساب + مزامنة الرقم)
  CREATE TABLE IF NOT EXISTS whatsapp_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    wa_phone      TEXT NOT NULL,              -- الصيغة الدولية الموحّدة 2126XXXXXXXX
    wa_name       TEXT,                       -- اسم بروفايل واتساب (اختياري)
    verified      INTEGER NOT NULL DEFAULT 1,
    linked_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_links_phone ON whatsapp_links(wa_phone);

  -- رموز التحقق (OTP) الخاصة بالدخول/الربط عبر واتساب
  CREATE TABLE IF NOT EXISTS whatsapp_otps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    phone        TEXT NOT NULL,
    code_hash    TEXT NOT NULL,
    purpose      TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login','link')),
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at   TEXT NOT NULL,
    consumed_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_otps_phone ON whatsapp_otps(phone, purpose);

  -- سجل أحداث مزوّدي الدفع (لمنع تكرار المعالجة + تدقيق)
  CREATE TABLE IF NOT EXISTS payment_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    provider   TEXT NOT NULL,
    event_id   TEXT NOT NULL UNIQUE,
    payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
    type       TEXT,
    amount     INTEGER,
    status     TEXT,
    payload    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  // ترقية قواعد البيانات القديمة: إضافة أعمدة الدفع إن لم تكن موجودة
  addColumn('payments', 'provider', "provider TEXT NOT NULL DEFAULT 'simulated'");
  addColumn('payments', 'pay_token', 'pay_token TEXT');
  addColumn('payments', 'checkout_url', 'checkout_url TEXT');
  addColumn('payments', 'expires_at', 'expires_at TEXT');
  addColumn('payments', 'failure_reason', 'failure_reason TEXT');
  addColumn('payments', 'updated_at', 'updated_at TEXT');
  addColumn('payments', 'refunded_at', 'refunded_at TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_token ON payments(pay_token)');
}

/** يضيف عموداً لقاعدة بيانات قديمة (يتجاهل الخطأ إن كان العمود موجوداً). */
function addColumn(table, column, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch { /* العمود موجود مسبقاً */ }
}

/* ------------------------------------------------------------------ */
/*  الإعدادات                                                          */
/* ------------------------------------------------------------------ */
export function getSetting(key, fallback = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? row.value : fallback;
  } catch { return fallback; }
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
  ).run(key, value == null ? null : String(value));
}

export function allSettings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
}

/* ------------------------------------------------------------------ */
/* بيانات تجريبية (Seed)                                               */
/* ------------------------------------------------------------------ */
export function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (n > 0) return false;

  const insertUser = db.prepare(
    'INSERT INTO users(name,email,phone,password_hash,role,avatar_color) VALUES (?,?,?,?,?,?)'
  );
  const owner = insertUser.run('لالة فاطمة', 'owner@hajzi.ma', '0661000001', hashPassword('owner123'), 'owner', '#2F3FB0').lastInsertRowid;
  const staffUser = insertUser.run('سلمى بنعلي', 'sara@hajzi.ma', '0661000002', hashPassword('staff123'), 'staff', '#F0A81C').lastInsertRowid;
  insertUser.run('زبون تجريبي', 'client@hajzi.ma', '0612345678', hashPassword('client123'), 'customer', '#12805A');

  const insertSalon = db.prepare(
    `INSERT INTO salons(parent_id,owner_id,name,city,address,phone,logo_letter,open_time,close_time,slot_minutes,closed_weekday,deposit_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const s1 = insertSalon.run(null, owner, 'صالون لالة فاطمة', 'أكادير', 'شارع الحسن الثاني، أكادير', '0528000001', 'ل', '09:00', '18:00', 30, 0, 20).lastInsertRowid;
  const s2 = insertSalon.run(s1, owner, 'فرع طالبرجت', 'أكادير', 'حي طالبرجت، أكادير', '0528000002', 'ط', '09:00', '20:00', 30, 0, 20).lastInsertRowid;
  const s3 = insertSalon.run(null, owner, 'صالون نور', 'الدار البيضاء', 'شارع محمد الخامس، الدار البيضاء', '0522000003', 'ن', '10:00', '21:00', 30, 1, 25).lastInsertRowid;

  const insertService = db.prepare('INSERT INTO services(salon_id,name,price,minutes) VALUES (?,?,?,?)');
  const svcDefs = [
    ['قصّ الشعر', 100, 45], ['صبغة', 300, 90], ['تسريحة', 150, 60], ['عناية بالأظافر', 120, 45], ['حمّام مغربي', 200, 75],
  ];
  const svcIds = {};
  for (const sid of [s1, s2, s3]) {
    svcIds[sid] = svcDefs.map((d, i) => ({ id: insertService.run(sid, `${d[0]}${sid === s2 && i === 0 ? ' (فرع)' : ''}`, d[1], d[2]).lastInsertRowid, ...d }));
  }

  const insertStaff = db.prepare('INSERT INTO staff(salon_id,user_id,name,title,phone,color) VALUES (?,?,?,?,?,?)');
  const st1 = insertStaff.run(s1, staffUser, 'سلمى', 'خبيرة شعر', '0661000002', '#F0A81C').lastInsertRowid;
  const st2 = insertStaff.run(s1, null, 'نادية', 'أخصائية أظافر', '0661000003', '#2F3FB0').lastInsertRowid;
  const st3 = insertStaff.run(s2, null, 'خديجة', 'خبيرة تجميل', '0661000004', '#12805A').lastInsertRowid;
  const st4 = insertStaff.run(s3, null, 'أمينة', 'مسؤولة الصالون', '0661000005', '#B42318').lastInsertRowid;

  const link = db.prepare('INSERT OR IGNORE INTO staff_services(staff_id,service_id) VALUES (?,?)');
  for (const s of svcIds[s1]) {
    if (s[0] === 'عناية بالأظافر') link.run(st2, s.id); else link.run(st1, s.id);
  }
  for (const s of svcIds[s2]) link.run(st3, s.id);
  for (const s of svcIds[s3]) link.run(st4, s.id);

  // حجوزات تجريبية موزّعة على آخر 30 يوماً + القادم
  const insertBooking = db.prepare(
    `INSERT INTO bookings(salon_id,staff_id,service_id,customer_name,customer_phone,date,time,status,price,deposit,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const names = ['سلمى', 'نادية', 'خديجة', 'أمينة', 'ياسمين', 'هند', 'زينب', 'ليلى', 'مريم', 'سناء'];
  const statuses = ['completed', 'completed', 'completed', 'confirmed', 'pending', 'cancelled', 'no_show'];
  const iso = (d) => d.toISOString().slice(0, 10);
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let day = 30; day >= -7; day--) {
    const date = new Date(); date.setDate(date.getDate() - day);
    if (date.getDay() === 0) continue;
    const count = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < count; k++) {
      const sid = [s1, s2, s3][Math.floor(rnd() * 3)];
      const svc = svcIds[sid][Math.floor(rnd() * svcIds[sid].length)];
      const hour = 9 + Math.floor(rnd() * 9);
      const minute = rnd() > 0.5 ? '30' : '00';
      const status = day < 0 ? statuses[Math.floor(rnd() * 3)] : statuses[3 + Math.floor(rnd() * 4)];
      const created = new Date(date); created.setDate(created.getDate() - 2);
      insertBooking.run(
        sid, null, svc.id, names[Math.floor(rnd() * names.length)], '06' + (10000000 + Math.floor(rnd() * 89999999)),
        iso(date), `${String(hour).padStart(2, '0')}:${minute}`, status, svc[1], Math.round(svc[1] * 0.2),
        created.toISOString().slice(0, 19).replace('T', ' ')
      );
    }
  }
  // حجوزات مؤكّدة لليوم
  const today = iso(new Date());
  insertBooking.run(s1, st1, svcIds[s1][0].id, 'سلمى', '0612345678', today, '10:00', 'confirmed', 100, 20, '2026-01-01 09:00:00');
  insertBooking.run(s1, st2, svcIds[s1][3].id, 'نادية', '0661234567', today, '11:30', 'confirmed', 120, 24, '2026-01-01 09:00:00');
  insertBooking.run(s1, st1, svcIds[s1][2].id, 'خديجة', '0670123456', today, '15:00', 'pending', 150, 30, '2026-01-01 09:00:00');

  // مدفوعات مرتبطة بالحجوزات المكتملة
  const doneBookings = db.prepare("SELECT id, price, deposit FROM bookings WHERE status IN ('completed','confirmed')").all();
  const insertPay = db.prepare("INSERT INTO payments(booking_id,amount,kind,method,status,provider_ref,paid_at) VALUES (?,?,?,?,?,?,datetime('now'))");
  for (const b of doneBookings) {
    insertPay.run(b.id, b.deposit, 'deposit', 'card', 'paid', 'SEED-' + b.id);
    if (b.id % 3 === 0) insertPay.run(b.id, b.price - b.deposit, 'full', 'cash', 'paid', 'SEED-CASH-' + b.id);
  }
  return true;
}

export function initDb() {
  migrate();
  if (!getSetting('payment_provider')) setSetting('payment_provider', process.env.HAJZI_PAYMENT_PROVIDER || 'simulated');
  return seedIfEmpty();
}
