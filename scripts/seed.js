// scripts/seed.js — إعادة تعبئة البيانات التجريبية
import { db, migrate, seedIfEmpty } from '../src/db.js';

migrate();
const seeded = seedIfEmpty();
console.log(seeded ? '✅ تمت تعبئة البيانات التجريبية.' : 'ℹ️  توجد بيانات بالفعل — لم يتم التغيير.');
console.log('   owner@hajzi.ma / owner123');
console.log('   sara@hajzi.ma  / staff123');
console.log('   client@hajzi.ma / client123');
db.close?.();
