// server.js — خادم HTTP بلا أي مكتبات خارجية (API + ملفات ثابتة)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, DB_PATH, getSetting } from './src/db.js';
import { handleApi } from './src/api.js';
import { handlePayPage, handleWebhook } from './src/paypage.js';
import { whatsappPublicConfig } from './src/whatsapp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, urlPath) {
  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // دعم مسارات SPA: أعِد index.html
    filePath = join(PUBLIC_DIR, 'index.html');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 — غير موجود');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // إشعارات مزوّدي الدفع تحتاج الجسم الخام (Raw) للتحقق من التوقيع — قبل أي تحليل JSON
  if (pathname.startsWith('/api/webhooks/')) {
    return handleWebhook(req, res, pathname);
  }

  // صفحة الدفع الآمنة (يقدّمها الخادم)
  if (pathname.startsWith('/pay/')) {
    return handlePayPage(req, res, pathname, url.searchParams);
  }

  if (pathname.startsWith('/api/')) {
    const query = Object.fromEntries(url.searchParams.entries());
    return handleApi(req, res, pathname, query);
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, db: DB_PATH, time: new Date().toISOString() }));
  }
  return serveStatic(res, pathname === '/' ? '/index.html' : pathname);
});

const seeded = initDb();
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ✂️  حجزي Pro — نظام حجز المواعيد');
  console.log('  ─────────────────────────────────────────');
  console.log(`  🚀 الخادم يعمل على:  http://localhost:${PORT}`);
  console.log(`  🗄️  قاعدة البيانات:  ${DB_PATH}`);
  {
    const provider = getSetting('payment_provider', 'simulated');
    const ready = provider === 'simulated'
      || (provider === 'stripe' && process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET)
      || (provider === 'cmi' && process.env.CMI_MERCHANT_ID && process.env.CMI_STORE_KEY);
    console.log(`  💳 مزوّد الدفع:      ${provider}${ready ? '' : '  (غير مُهيّأ — راجع متغيرات البيئة)'}`);
    console.log('  🔔 إشعارات الدفع:    /api/webhooks/stripe  |  /api/webhooks/cmi');
    console.log(`  🧾 صفحة الدفع:       http://localhost:${PORT}/pay/<token>`);
    {
      const wa = whatsappPublicConfig();
      console.log(`  📱 مزوّد واتساب:     ${wa.provider}${wa.ready ? '' : '  (وضع المحاكاة — أضف مفاتيح المزوّد)'}`);
    }
  }
  if (seeded) {
    console.log('  🌱 تم إنشاء بيانات تجريبية');
    console.log('  👤 owner@hajzi.ma / owner123   (صاحب صالون)');
    console.log('  👤 sara@hajzi.ma  / staff123   (موظفة)');
    console.log('  👤 client@hajzi.ma / client123 (زبون)');
  }
  console.log('');
});
