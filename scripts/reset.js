// scripts/reset.js — حذف كل البيانات وإعادة الإنشاء من الصفر
import { db, migrate } from '../src/db.js';

const tables = ['notifications', 'payments', 'bookings', 'staff_services', 'staff', 'services', 'salons', 'users'];
db.exec('PRAGMA foreign_keys = OFF;');
for (const t of tables) {
  try { db.exec(`DELETE FROM ${t};`); db.exec(`DELETE FROM sqlite_sequence WHERE name='${t}';`); } catch {}
}
db.exec('PRAGMA foreign_keys = ON;');
migrate();
console.log('🧹 تم حذف كل البيانات. شغّل `npm run seed` لتعبئة بيانات تجريبية.');
db.close?.();
