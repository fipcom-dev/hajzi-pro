/* ==========================================================================
   حجزي Pro — تطبيق الواجهة (SPA بلا إطار عمل)
   ========================================================================== */
'use strict';

/* ------------------------------ الحالة ------------------------------ */
const S = {
  token: localStorage.getItem('hajzi_token') || null,
  user: JSON.parse(localStorage.getItem('hajzi_user') || 'null'),
  view: 'explore',            // explore | salon | mybookings | dashboard
  salonId: null,
  salons: [],
  mySalons: [],
  dashSalonId: null,
  dashTab: 'analytics',
  bookingsFilter: { date: '', status: '' },
  wizard: { step: 1, service: null, staff: null, date: null, time: null, slotData: null, lastBooking: null },
};

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'غشت', 'شتنبر', 'أكتوبر', 'نونبر', 'دجنبر'];
const STATUS = {
  pending:   { label: 'قيد الانتظار', cls: 'amber' },
  confirmed: { label: 'مؤكّد', cls: 'blue' },
  completed: { label: 'مكتمل', cls: 'green' },
  cancelled: { label: 'ملغى', cls: 'red' },
  no_show:   { label: 'لم يحضر', cls: 'red' },
};

/* ------------------------------ أدوات ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const money = (n) => `${Number(n || 0).toLocaleString('ar-MA')} د.م`;
const initials = (n) => (String(n || '؟').trim()[0] || '؟');
const todayLabel = (iso) => {
  const t = dateKey();
  const tm = dateKey(new Date(Date.now() + 86400000));
  if (iso === t) return 'اليوم';
  if (iso === tm) return 'غداً';
  const d = new Date(iso + 'T12:00:00');
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/* ------------------------------ API ------------------------------ */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `خطأ ${res.status}`);
  return data;
}

function setSession(token, user) {
  S.token = token; S.user = user;
  localStorage.setItem('hajzi_token', token);
  localStorage.setItem('hajzi_user', JSON.stringify(user));
}
function clearSession() {
  S.token = null; S.user = null;
  localStorage.removeItem('hajzi_token');
  localStorage.removeItem('hajzi_user');
}

/* ------------------------------ تنبيهات ------------------------------ */
function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}

/* ------------------------------ نوافذ ------------------------------ */
function openModal(title, bodyHtml, { footer = '', wide = false } = {}) {
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop" id="backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  $('#backdrop').addEventListener('click', (e) => { if (e.target.id === 'backdrop') closeModal(); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };

/* ------------------------------ رسوم SVG ------------------------------ */
function lineChart(series, { height = 220, color = '#2F3FB0', color2 = '#F0A81C', key1 = 'bookings', key2 = 'revenue' } = {}) {
  if (!series.length) return '<div class="empty">لا توجد بيانات</div>';
  const W = 720, H = height, P = { t: 16, r: 16, b: 28, l: 16 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const max1 = Math.max(1, ...series.map((d) => d[key1]));
  const max2 = Math.max(1, ...series.map((d) => d[key2]));
  const x = (i) => P.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
  const y = (v, max) => P.t + ih - (v / max) * ih;
  const path = (key, max) => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key], max).toFixed(1)}`).join(' ');
  const area = (key, max) => `${path(key, max)} L${x(series.length - 1).toFixed(1)},${P.t + ih} L${x(0).toFixed(1)},${P.t + ih} Z`;
  const grid = [0, .25, .5, .75, 1].map((f) => `<line x1="${P.l}" x2="${W - P.r}" y1="${P.t + ih * f}" y2="${P.t + ih * f}" stroke="#eef0f9" stroke-width="1"/>`).join('');
  const labels = series.map((d, i) => (i % Math.ceil(series.length / 7) === 0
    ? `<text x="${x(i)}" y="${H - 8}" font-size="10" fill="#6b7590" text-anchor="middle">${esc(String(d.date).slice(5))}</text>` : '')).join('');
  const dots = series.map((d, i) => `<circle cx="${x(i)}" cy="${y(d[key1], max1)}" r="2.5" fill="${color}"><title>${d.date}: ${d[key1]} حجز · ${d[key2]} د.م</title></circle>`).join('');
  return `
  <div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="direction:ltr">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color2}" stop-opacity=".25"/><stop offset="100%" stop-color="${color2}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area(key2, max2)}" fill="url(#g2)"/>
      <path d="${path(key2, max2)}" fill="none" stroke="${color2}" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>
      <path d="${area(key1, max1)}" fill="url(#g1)"/>
      <path d="${path(key1, max1)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}${labels}
    </svg>
    <div class="chart-legend">
      <div class="item"><span class="dot" style="background:${color}"></span> عدد الحجوزات</div>
      <div class="item"><span class="dot" style="background:${color2}"></span> الإيرادات (د.م)</div>
    </div>
  </div>`;
}

function donut(segments, { size = 170 } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 70, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (s.value / total) * C;
    const el = `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${s.color}" stroke-width="22"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 90)"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    offset += len;
    return el;
  }).join('');
  return `<div class="row" style="gap:22px;flex-wrap:wrap;justify-content:center">
    <svg width="${size}" height="${size}" viewBox="0 0 180 180">
      <circle cx="90" cy="90" r="${R}" fill="none" stroke="#eef0f9" stroke-width="22"/>
      ${arcs}
      <text x="90" y="86" text-anchor="middle" font-size="26" font-weight="800" fill="#14213D">${total}</text>
      <text x="90" y="106" text-anchor="middle" font-size="11" fill="#6b7590">إجمالي</text>
    </svg>
    <div style="min-width:150px">
      ${segments.map((s) => `<div class="row" style="gap:8px;margin-bottom:8px"><span class="dot" style="width:10px;height:10px;border-radius:3px;background:${s.color};display:inline-block"></span>
        <span class="small bold">${esc(s.label)}</span><span class="spacer"></span><span class="small muted">${s.value}</span></div>`).join('')}
    </div>
  </div>`;
}

function barList(items, { unit = '', color = '' } = {}) {
  if (!items.length) return '<div class="empty small">لا توجد بيانات</div>';
  const max = Math.max(1, ...items.map((i) => i.value));
  return items.map((i) => `
    <div class="bar-row">
      <span class="label">${esc(i.label)}</span>
      <span class="track"><span class="fill" style="width:${(i.value / max) * 100}%;${color ? `background:${color}` : ''}"></span></span>
      <span class="val">${i.value}${unit}</span>
    </div>`).join('');
}

/* ==========================================================================
   شاشة الدخول
   ========================================================================== */
function renderAuth(mode = 'login') {
  const app = $('#app');
  app.innerHTML = `
  <div class="auth-wrap">
    <aside class="auth-aside">
      <div class="brand" style="color:#fff;margin-bottom:34px">
        <span class="logo" style="background:rgba(255,255,255,.16);box-shadow:none">ح</span> حجزي <small style="background:rgba(240,168,28,.25);color:#F0A81C">PRO</small>
      </div>
      <h1>نظام الحجز الذي<br/>يُدير صالونك بالكامل</h1>
      <p>من الحجز إلى العربون إلى التذكير إلى التقرير — كل شيء في مكان واحد، متعدد الفروع والمدن.</p>
      <ul>
        <li><span class="tick">✓</span> حجز أونلاين 24/7 مع اختيار الأخصائية</li>
        <li><span class="tick">✓</span> دفع عربون إلكتروني وتأكيد تلقائي</li>
        <li><span class="tick">✓</span> تذكيرات واتساب وSMS بضغطة واحدة</li>
        <li><span class="tick">✓</span> تقارير إيرادات وأداء الطاقم</li>
        <li><span class="tick">✓</span> إدارة عدة صالونات وفروع</li>
      </ul>
    </aside>
    <main class="auth-main">
      <div class="auth-box">
        <div class="auth-tabs">
          <button class="${mode === 'login' ? 'active' : ''}" data-mode="login">تسجيل الدخول</button>
          <button class="${mode === 'register' ? 'active' : ''}" data-mode="register">حساب جديد</button>
          <button class="${mode === 'whatsapp' ? 'active' : ''}" data-mode="whatsapp">واتساب</button>
        </div>
        <div id="auth-form"></div>
      </div>
    </main>
  </div>`;

  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));

  const form = $('#auth-form');
  if (mode === 'login') {
    form.innerHTML = `
      <h2 style="margin-bottom:6px">مرحباً بعودتك 👋</h2>
      <p class="muted small mb-3">سجّل الدخول للوصول إلى حجوزاتك أو لوحة صالونك.</p>
      <form id="login-form">
        <div class="field"><label>البريد الإلكتروني</label><input class="input" type="email" name="email" required placeholder="you@example.com" /></div>
        <div class="field"><label>كلمة المرور</label><input class="input" type="password" name="password" required placeholder="••••••" /></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">دخول</button>
      </form>
      <div class="demo-accounts">
        <p class="small muted bold mb-1">حسابات تجريبية (اضغط للتعبئة):</p>
        <button class="acct" data-email="owner@hajzi.ma" data-pass="owner123"><span class="avatar" style="background:#2F3FB0;width:30px;height:30px;font-size:13px">ل</span><b>صاحب صالون</b><span>owner@hajzi.ma</span></button>
        <button class="acct" data-email="sara@hajzi.ma" data-pass="staff123"><span class="avatar" style="background:#F0A81C;width:30px;height:30px;font-size:13px">س</span><b>موظفة</b><span>sara@hajzi.ma</span></button>
        <button class="acct" data-email="client@hajzi.ma" data-pass="client123"><span class="avatar" style="background:#12805A;width:30px;height:30px;font-size:13px">ز</span><b>زبون</b><span>client@hajzi.ma</span></button>
      </div>`;
    form.querySelectorAll('.acct').forEach((b) => b.addEventListener('click', () => {
      form.querySelector('[name=email]').value = b.dataset.email;
      form.querySelector('[name=password]').value = b.dataset.pass;
    }));
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ الدخول...';
      try {
        const fd = new FormData(e.target);
        const { token, user } = await api('/api/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
        setSession(token, user);
        toast(`مرحباً ${user.name}`, 'ok');
        afterLogin();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false; btn.textContent = 'دخول';
      }
    });
  } else if (mode === 'whatsapp') {
    renderWhatsappAuth();
  } else {
    form.innerHTML = `
      <h2 style="margin-bottom:6px">أنشئ حسابك</h2>
      <p class="muted small mb-3">سجّل كزبون للحجز، أو كصاحب صالون لإدارة أعمالك.</p>
      <form id="reg-form">
        <div class="field"><label>الاسم الكامل</label><input class="input" name="name" required placeholder="مثال: سلمى بنعلي" /></div>
        <div class="field"><label>البريد الإلكتروني</label><input class="input" type="email" name="email" required /></div>
        <div class="field"><label>رقم الهاتف (واتساب)</label><input class="input" name="phone" placeholder="0612345678" /></div>
        <div class="field"><label>كلمة المرور</label><input class="input" type="password" name="password" required minlength="6" /><div class="hint">6 أحرف على الأقل</div></div>
        <div class="field"><label>نوع الحساب</label>
          <select class="input" name="role">
            <option value="customer">زبون — أريد الحجز في الصالونات</option>
            <option value="owner">صاحب صالون — أريد إدارة صالوني</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">إنشاء الحساب</button>
      </form>`;
    $('#reg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ الإنشاء...';
      try {
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        const { token, user } = await api('/api/auth/register', { method: 'POST', body });
        setSession(token, user);
        toast('تم إنشاء الحساب بنجاح 🎉', 'ok');
        afterLogin();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false; btn.textContent = 'إنشاء الحساب';
      }
    });
  }
}

/* ------------------- الدخول بواتساب (3 خطوات) ------------------- */
function renderWhatsappAuth() {
  const form = $('#auth-form');
  let phone = '';
  let sent = null;
  let signupToken = null;

  form.innerHTML = `
    <h2 style="margin-bottom:6px">الدخول بواتساب 📱</h2>
    <p class="muted small mb-3">أدخل رقمك، وسنرسل لك رمزاً على واتساب. إن لم يكن لديك حساب سننشئه ونزامن رقمك تلقائياً.</p>
    <div id="wa-step"></div>`;
  const step = () => $('#wa-step');

  const drawPhone = () => {
    step().innerHTML = `
      <form id="wa-phone-form">
        <div class="field"><label>رقم الواتساب</label><input class="input" name="phone" inputmode="tel" placeholder="0612345678" value="${esc(phone)}" /></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">إرسال الرمز على واتساب</button>
      </form>`;
    $('#wa-phone-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ الإرسال...';
      try {
        phone = new FormData(e.target).get('phone').trim();
        sent = await api('/api/auth/whatsapp/start', { method: 'POST', body: { phone, purpose: 'login' } });
        toast('تم إرسال الرمز على واتساب', 'ok');
        drawCode();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'إرسال الرمز على واتساب'; }
    });
  };

  const drawCode = () => {
    step().innerHTML = `
      <div class="wa-sent">أرسلنا رمزاً إلى <b dir="ltr">${esc(sent.phone)}</b> على واتساب.</div>
      ${sent.dev_code ? `<div class="wa-dev">وضع المحاكاة (تطوير): الرمز هو <b>${esc(sent.dev_code)}</b></div>` : ''}
      <form id="wa-code-form">
        <div class="field"><label>رمز التحقق (6 أرقام)</label><input class="input" name="code" inputmode="numeric" maxlength="6" placeholder="______" style="letter-spacing:6px;text-align:center;font-size:20px" /></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">تحقق ودخول</button>
      </form>
      <div class="wa-actions">
        <a class="btn btn-ghost" href="${esc(sent.wa_link)}" target="_blank" rel="noopener">فتح واتساب</a>
        <button class="btn btn-ghost" id="wa-change" type="button">تغيير الرقم</button>
      </div>`;
    $('#wa-change').addEventListener('click', drawPhone);
    $('#wa-code-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ التحقق...';
      try {
        const code = new FormData(e.target).get('code').trim();
        const r = await api('/api/auth/whatsapp/verify', { method: 'POST', body: { phone: sent.phone, code } });
        if (r.registered && r.token) {
          setSession(r.token, r.user);
          toast(`مرحباً ${r.user.name}`, 'ok');
          afterLogin();
        } else {
          signupToken = r.signup_token;
          drawComplete();
        }
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'تحقق ودخول'; }
    });
  };

  const drawComplete = () => {
    step().innerHTML = `
      <div class="wa-sent">رقم جديد! أكمل بياناتك لإنشاء الحساب ومزامنة رقمك <b dir="ltr">${esc(sent.phone)}</b>.</div>
      <form id="wa-complete-form">
        <div class="field"><label>الاسم الكامل</label><input class="input" name="name" required placeholder="مثال: سلمى بنعلي" /></div>
        <div class="field"><label>نوع الحساب</label>
          <select class="input" name="role">
            <option value="customer">زبون — أريد الحجز في الصالونات</option>
            <option value="owner">صاحب صالون — أريد إدارة صالوني</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">إنشاء الحساب وربط واتساب</button>
      </form>`;
    $('#wa-complete-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ الإنشاء...';
      try {
        const fd = new FormData(e.target);
        const r = await api('/api/auth/whatsapp/complete', { method: 'POST', body: { signup_token: signupToken, name: fd.get('name'), role: fd.get('role'), phone } });
        setSession(r.token, r.user);
        toast('تم إنشاء الحساب وربط واتساب 🎉', 'ok');
        afterLogin();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'إنشاء الحساب وربط واتساب'; }
    });
  };

  drawPhone();
}

async function afterLogin() {
  await Promise.all([loadSalons(), loadMySalons()]);
  S.view = S.user.role === 'customer' ? 'explore' : 'dashboard';
  if (S.mySalons.length) S.dashSalonId = S.mySalons[0].id;
  render();
}

async function loadSalons() {
  try { S.salons = (await api('/api/salons')).salons; } catch { S.salons = []; }
}
async function loadMySalons() {
  if (!S.token) return;
  try { S.mySalons = (await api('/api/my/salons')).salons; } catch { S.mySalons = []; }
}

/* ==========================================================================
   الهيكل العام
   ========================================================================== */
function render() {
  if (!S.token) return renderAuth();
  const app = $('#app');
  const isOwnerSide = S.user.role !== 'customer';
  const tabs = isOwnerSide
    ? [['dashboard', 'لوحة التحكم'], ['explore', 'الصالونات']]
    : [['explore', 'الصالونات'], ['mybookings', 'حجوزاتي']];
  if (S.user.role === 'owner') tabs.splice(1, 0, ['mybookings', 'حجوزاتي']);

  app.innerHTML = `
    <header class="topbar">
      <div class="container topbar-inner">
        <div class="brand"><span class="logo">ح</span> حجزي <small>PRO</small></div>
        <div class="spacer"></div>
        <nav class="nav-tabs">
          ${tabs.map(([v, l]) => `<button data-nav="${v}" class="${S.view === v || (v === 'explore' && S.view === 'salon') ? 'active' : ''}">${l}</button>`).join('')}
        </nav>
        <div class="user-menu">
          <button id="user-btn" class="row" style="gap:8px">
            <span class="avatar" style="background:${S.user.avatar_color || '#2F3FB0'}">${esc(initials(S.user.name))}</span>
          </button>
          <div id="user-dd" class="dropdown hidden">
            <div class="who"><b>${esc(S.user.name)}</b><span>${esc(S.user.email)}</span><br/><span class="chip ${S.user.role === 'owner' ? 'gold' : S.user.role === 'staff' ? 'blue' : 'green'}" style="margin-top:6px">${S.user.role === 'owner' ? 'صاحب صالون' : S.user.role === 'staff' ? 'موظفة' : 'زبون'}</span></div>
            <button id="btn-profile">👤 الملف الشخصي</button>
            ${isOwnerSide ? '<button id="btn-new-salon">➕ إضافة صالون / فرع</button>' : ''}
            <button id="btn-logout">🚪 تسجيل الخروج</button>
          </div>
        </div>
      </div>
    </header>
    <main class="container" id="main"></main>
    <footer style="padding:34px 0;text-align:center" class="muted small">
      حجزي Pro · نظام حجز مواعيد متعدد الصالونات — <span class="bold">بيانات حقيقية على SQLite</span>
    </footer>`;

  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.nav; render(); }));
  $('#user-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#user-dd').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('#user-dd')?.classList.add('hidden'), { once: true });
  $('#btn-logout').addEventListener('click', () => { clearSession(); S.view = 'explore'; renderAuth(); });
  $('#btn-profile').addEventListener('click', openProfile);
  $('#btn-new-salon')?.addEventListener('click', openNewSalon);

  const main = $('#main');
  if (S.view === 'explore') renderExplore(main);
  else if (S.view === 'salon') renderSalonPage(main);
  else if (S.view === 'mybookings') renderMyBookings(main);
  else if (S.view === 'dashboard') renderDashboard(main);
}

/* ==========================================================================
   صفحة استكشاف الصالونات (الزبون)
   ========================================================================== */
function renderExplore(main) {
  main.innerHTML = `
    <section class="hero">
      <h1>احجزي موعدك في ثوانٍ ✨</h1>
      <p>اختاري الصالون، الخدمة، والأخصائية — وادفعي العربون أونلاين، ونذكّرك قبل الموعد تلقائياً.</p>
      <div class="hero-actions">
        <button class="btn btn-gold btn-lg" id="hero-cta">ابدئي الحجز الآن</button>
        ${S.user.role !== 'customer' ? '<button class="btn btn-ghost btn-lg" data-nav="dashboard">لوحة التحكم</button>' : ''}
      </div>
      <div class="stat-row">
        <div><b>${S.salons.length}</b><span>صالون مسجّل</span></div>
        <div><b>${S.salons.reduce((s, x) => s + (x.branches?.length || 0), 0)}</b><span>فرع</span></div>
        <div><b>24/7</b><span>حجز متواصل</span></div>
      </div>
    </section>

    <div class="section-title">
      <h2>الصالونات المتاحة</h2><span class="spacer"></span>
      <input class="input" id="search" placeholder="🔍 ابحث بالاسم أو المدينة..." style="max-width:280px" />
    </div>
    <div class="grid grid-3" id="salon-grid"></div>`;

  $('#hero-cta').addEventListener('click', () => { $('#search')?.focus(); $('#salon-grid')?.scrollIntoView({ behavior: 'smooth' }); });
  main.querySelector('[data-nav]')?.addEventListener('click', () => { S.view = 'dashboard'; render(); });
  $('#search').addEventListener('input', () => paintSalons($('#search').value));
  paintSalons('');
}

function paintSalons(q) {
  const term = q.trim().toLowerCase();
  const list = S.salons.filter((s) => !term || (s.name + ' ' + (s.city || '')).toLowerCase().includes(term));
  $('#salon-grid').innerHTML = list.length ? list.map((s) => `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="row">
        <span class="avatar" style="width:52px;height:52px;font-size:22px;border-radius:16px;background:linear-gradient(135deg,#2F3FB0,#1F2A80)">${esc(s.logo_letter || initials(s.name))}</span>
        <div class="t"><b style="font-size:17px">${esc(s.name)}</b><div class="small muted">📍 ${esc(s.city || '—')}${s.branches?.length ? ` · ${s.branches.length} فرع` : ''}</div></div>
      </div>
      <div class="row wrap" style="gap:6px">
        <span class="chip gold">★ ${s.rating}</span>
        <span class="chip">🕐 ${esc(s.open_time)}–${esc(s.close_time)}</span>
        <span class="chip">✂️ ${s.services_count} خدمة</span>
      </div>
      <div class="small muted">مغلق: ${esc(s.closed_weekday_name)} · عربون ${s.deposit_pct}%</div>
      <button class="btn btn-primary btn-block" data-salon="${s.id}">عرض الخدمات والحجز</button>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1"><div class="ico">🔍</div><h3>لا نتائج</h3><p>جرّبي كلمة بحث أخرى.</p></div>`;

  document.querySelectorAll('[data-salon]').forEach((b) => b.addEventListener('click', () => openSalon(+b.dataset.salon)));
}

/* ==========================================================================
   صفحة الصالون + معالج الحجز
   ========================================================================== */
async function openSalon(id) {
  S.salonId = id;
  S.wizard = { step: 1, service: null, staff: null, date: dateKey(), time: null, slotData: null, lastBooking: null };
  S.view = 'salon';
  render();
}

async function renderSalonPage(main) {
  main.innerHTML = '<div class="card pad-lg mt-3"><div class="skeleton" style="height:80px;margin-bottom:14px"></div><div class="skeleton" style="height:300px"></div></div>';
  let data;
  try { data = await api(`/api/salons/${S.salonId}`); }
  catch (e) { main.innerHTML = `<div class="empty"><div class="ico">⚠️</div><h3>${esc(e.message)}</h3><button class="btn btn-ghost mt-2" data-back>رجوع</button></div>`; $('[data-back]').addEventListener('click', () => { S.view = 'explore'; render(); }); return; }
  S.currentSalon = data;

  const s = data.salon;
  main.innerHTML = `
    <div class="row mt-2"><button class="btn btn-ghost btn-sm" id="back">→ رجوع للصالونات</button></div>
    <div class="card pad-lg mt-2" style="background:var(--grad);color:#fff;border:none">
      <div class="row" style="gap:16px">
        <span class="avatar" style="width:64px;height:64px;font-size:28px;border-radius:18px;background:rgba(255,255,255,.18)">${esc(s.logo_letter || 'ص')}</span>
        <div>
          <h1 style="font-size:26px">${esc(s.name)}</h1>
          <div style="color:rgba(255,255,255,.85)" class="small">📍 ${esc(s.address || s.city || '')} · ☎️ ${esc(s.phone || '—')}</div>
        </div>
      </div>
      <div class="row wrap mt-2" style="gap:8px">
        <span class="chip" style="background:rgba(255,255,255,.16);color:#fff">🕐 ${esc(s.open_time)} – ${esc(s.close_time)}</span>
        <span class="chip" style="background:rgba(255,255,255,.16);color:#fff">🚫 مغلق ${esc(s.closed_weekday_name)}</span>
        <span class="chip" style="background:rgba(240,168,28,.9);color:#14213D">عربون ${s.deposit_pct}%</span>
      </div>
      ${data.branches?.length ? `<div class="mt-2 small" style="color:rgba(255,255,255,.85)">الفروع: ${data.branches.map((b) => esc(b.name)).join(' · ')}</div>` : ''}
    </div>
    <div id="wizard" class="mt-2"></div>`;

  $('#back').addEventListener('click', () => { S.view = 'explore'; render(); });
  renderWizard();
}

function renderWizard() {
  const { services, staff } = S.currentSalon;
  const w = S.wizard;
  const box = $('#wizard');
  if (w.lastBooking) return renderBookingSuccess(box);

  const stepHtml = (n, title, body, done) => `
    <div class="card mb-2">
      <div class="row mb-2"><span class="step-item ${done ? 'done' : ''}"><span class="num">${done ? '✓' : n}</span></span><b>${title}</b></div>
      ${body}
    </div>`;

  const step1 = stepHtml(1, 'اختاري الخدمة', `
    <div class="grid" style="gap:8px">
      ${services.map((sv) => `<button class="option ${w.service === sv.id ? 'selected' : ''}" data-svc="${sv.id}">
        <span class="t"><b>${esc(sv.name)}</b><span>⏱ ${sv.minutes} دقيقة</span></span>
        <span class="price">${money(sv.price)}</span></button>`).join('')}
    </div>`, !!w.service);

  const svc = services.find((x) => x.id === w.service);
  const eligibleStaff = w.service ? staff.filter((st) => !st.service_ids?.length || st.service_ids.includes(w.service)) : staff;
  const step2 = w.service ? stepHtml(2, 'اختاري الأخصائية', `
    <div class="grid grid-3" style="gap:8px">
      <button class="option ${w.staff === null ? 'selected' : ''}" data-staff="auto" style="flex-direction:column;text-align:center">
        <span class="avatar" style="background:var(--gold);color:var(--ink)">✨</span>
        <span class="t" style="text-align:center"><b>تلقائي</b><span>أول متاحة</span></span>
      </button>
      ${eligibleStaff.map((st) => `<button class="option ${w.staff === st.id ? 'selected' : ''}" data-staff="${st.id}" style="flex-direction:column;text-align:center">
        <span class="avatar" style="background:${st.color || '#2F3FB0'}">${esc(initials(st.name))}</span>
        <span class="t" style="text-align:center"><b>${esc(st.name)}</b><span>${esc(st.title || '')}</span></span>
      </button>`).join('')}
    </div>`, w.staff !== null || w.service) : '';

  let step3 = '';
  if (w.service) {
    const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; })
      .filter((d) => d.getDay() !== S.currentSalon.salon.closed_weekday);
    step3 = stepHtml(3, 'اختاري اليوم والساعة', `
      <div class="pill-group mb-2" style="flex-wrap:nowrap;overflow-x:auto;padding-bottom:6px">
        ${days.map((d) => {
          const k = dateKey(d);
          return `<button class="pill ${w.date === k ? 'active' : ''}" data-day="${k}" style="min-width:96px">
            <div style="font-size:12px;opacity:.8">${DAYS[d.getDay()]}</div>
            <div class="bold">${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 4)}</div></button>`;
        }).join('')}
      </div>
      <div id="slots"><div class="skeleton" style="height:70px"></div></div>`, !!w.time);
  }

  const canSubmit = w.service && w.date && w.time;
  const deposit = svc ? Math.round(svc.price * S.currentSalon.salon.deposit_pct / 100) : 0;
  const step4 = w.service && w.time ? stepHtml(4, 'بياناتك وتأكيد الحجز', `
    <div class="input-row">
      <div class="field"><label>الاسم الكامل</label><input class="input" id="bk-name" value="${esc(S.user.name)}" /></div>
      <div class="field"><label>رقم الهاتف (واتساب)</label><input class="input" id="bk-phone" value="${esc(S.user.phone || '')}" placeholder="0612345678" /></div>
    </div>
    <div class="field"><label>ملاحظات (اختياري)</label><textarea class="input" id="bk-notes" placeholder="مثال: أفضّل التسريحة الكلاسيكية..."></textarea></div>
    <div class="card" style="background:var(--bg);box-shadow:none">
      <div class="row"><span class="muted small">الخدمة</span><span class="spacer"></span><b>${esc(svc.name)}</b></div>
      <div class="row mt-1"><span class="muted small">الموعد</span><span class="spacer"></span><b>${esc(todayLabel(w.date))} · ${esc(w.time)}</b></div>
      <div class="row mt-1"><span class="muted small">المدة</span><span class="spacer"></span><b>${svc.minutes} دقيقة</b></div>
      <hr style="border:none;border-top:1px dashed var(--line);margin:10px 0"/>
      <div class="row"><span class="muted small">السعر الإجمالي</span><span class="spacer"></span><b>${money(svc.price)}</b></div>
      <div class="row mt-1"><span class="muted small">العربون المطلوب (${S.currentSalon.salon.deposit_pct}%)</span><span class="spacer"></span><b style="color:var(--gold-600)">${money(deposit)}</b></div>
    </div>
    <div class="row wrap mt-2" style="gap:8px">
      <label class="row small"><input type="checkbox" id="pay-now" checked /> ادفعي العربون الآن (بطاقة تجريبية)</label>
      <label class="row small"><input type="checkbox" id="wa-confirm" checked /> إرسال تأكيد واتساب</label>
    </div>
    <button class="btn btn-gold btn-block btn-lg mt-2" id="confirm-booking" ${canSubmit ? '' : 'disabled'}>تأكيد الحجز</button>
  `, false) : '';

  box.innerHTML = `
    <div class="stepper">
      ${[['الخدمة', 1], ['الأخصائية', 2], ['الموعد', 3], ['التأكيد', 4]].map(([l, n], i) => `
        ${i ? '<span class="step-sep"></span>' : ''}
        <span class="step-item ${w.step === n ? 'active' : ''} ${w.step > n ? 'done' : ''}"><span class="num">${w.step > n ? '✓' : n}</span><span>${l}</span></span>`).join('')}
    </div>
    ${step1}${step2}${step3}${step4}`;

  box.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', () => {
    S.wizard.service = +b.dataset.svc; S.wizard.time = null; S.wizard.staff = null; S.wizard.step = 2; renderWizard();
  }));
  box.querySelectorAll('[data-staff]').forEach((b) => b.addEventListener('click', () => {
    S.wizard.staff = b.dataset.staff === 'auto' ? null : +b.dataset.staff; S.wizard.time = null; S.wizard.step = 3; renderWizard();
  }));
  box.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
    S.wizard.date = b.dataset.day; S.wizard.time = null; S.wizard.step = 3; renderWizard();
  }));
  $('#confirm-booking')?.addEventListener('click', submitBooking);
  if (w.service && w.date) loadSlots();
}

async function loadSlots() {
  const w = S.wizard;
  const host = $('#slots');
  if (!host || !w.service) return;
  host.innerHTML = '<div class="skeleton" style="height:70px"></div>';
  try {
    const q = new URLSearchParams({ date: w.date, service_id: w.service });
    if (w.staff) q.set('staff_id', w.staff);
    const data = await api(`/api/salons/${S.salonId}/availability?${q}`);
    w.slotData = data;
    if (data.closed) { host.innerHTML = '<div class="chip red">الصالون مغلق في هذا اليوم</div>'; return; }
    host.innerHTML = `<div class="pill-group">
      ${data.slots.map((sl) => `<button class="pill ${w.time === sl.time ? 'active' : ''}" ${sl.available ? '' : 'disabled'}
        title="${sl.reason === 'past' ? 'انتهى الوقت' : sl.reason === 'full' ? 'محجوز بالكامل' : sl.reason === 'short' ? 'لا يتّسع للخدمة' : 'متاح'}"
        data-slot="${sl.time}">${sl.time}</button>`).join('')}
    </div>`;
    host.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
      w.time = b.dataset.slot; w.step = 4; renderWizard();
    }));
  } catch (e) { host.innerHTML = `<div class="chip red">${esc(e.message)}</div>`; }
}

async function submitBooking() {
  const w = S.wizard;
  const btn = $('#confirm-booking');
  const name = $('#bk-name').value.trim();
  const phone = $('#bk-phone').value.trim();
  if (!name || phone.replace(/\D/g, '').length < 9) return toast('أدخلي اسماً ورقم هاتف صالحاً.', 'err');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> جارٍ الحجز...';
  try {
    const res = await api('/api/bookings', { method: 'POST', body: {
      salon_id: S.salonId, service_id: w.service, staff_id: w.staff, date: w.date, time: w.time,
      customer_name: name, customer_phone: phone, notes: $('#bk-notes').value,
      channel: $('#wa-confirm')?.checked ? 'whatsapp' : 'sms',
    } });
    w.lastBooking = res;
    if ($('#pay-now')?.checked && res.payment) {
      const checkout = await openCheckout(res.payment.id);
      if (checkout) {
        w.lastBooking.checkout = checkout;
        // نراقب حالة الدفعة في الخلفية ونحدّث الشاشة فور تأكيدها
        watchPayment(checkout.token, () => {
          w.lastBooking.paid = true;
          if (w.lastBooking.booking) w.lastBooking.booking.status = 'confirmed';
          toast('تم دفع العربون ✓', 'ok');
          renderWizard();
        });
      }
    }
    toast('تم إنشاء الحجز بنجاح 🎉', 'ok');
    renderWizard();
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false; btn.textContent = 'تأكيد الحجز';
  }
}

/* ==========================================================================
   الدفع الإلكتروني — صفحة دفع آمنة على الخادم + متابعة الحالة
   ========================================================================== */
const PAY_LABELS = {
  simulated: 'وضع تجريبي (بلا خصم حقيقي)',
  stripe: 'Stripe (بطاقات دولية)',
  cmi: 'CMI (البطاقة البنكية المغربية)',
};

/** يطلب رابط صفحة الدفع الآمنة ويفتحها في تبويب جديد. */
async function openCheckout(paymentId) {
  try {
    const res = await api(`/api/payments/${paymentId}/checkout`, { method: 'POST' });
    if (!res.ready) {
      toast(`مزوّد الدفع «${PAY_LABELS[res.provider] || res.provider}» غير مُهيّأ على الخادم.`, 'err');
      return null;
    }
    window.open(res.url, '_blank', 'noopener,noreferrer');
    return res;
  } catch (e) {
    toast('تعذّر بدء الدفع: ' + e.message, 'err');
    return null;
  }
}

/** يراقب حالة الدفعة عبر رمزها الآمن حتى تُؤكَّد (أو تنتهي المهلة). */
async function watchPayment(token, onPaid) {
  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const s = await api(`/api/pay/${token}/status`);
      if (s.status === 'paid') { onPaid(s); return; }
      if (s.status === 'failed') { toast('فشلت عملية الدفع: ' + (s.failure_reason || 'مرفوضة'), 'err'); return; }
    } catch { /* نتجاهل أخطاء الشبكة المؤقتة ونعيد المحاولة */ }
  }
}

function renderBookingSuccess(box) {
  const b = S.wizard.lastBooking;
  const awaitingPay = b.checkout && !b.paid;
  box.innerHTML = `
    <div class="card pad-lg center" style="border:2px solid var(--green)">
      <div class="avatar" style="width:64px;height:64px;background:var(--green);margin:0 auto 14px;font-size:30px">✓</div>
      <h2>تم تأكيد حجزك، ${esc(b.booking.customer_name)}</h2>
      <p class="muted">${esc(b.service.name)} · ${esc(todayLabel(b.booking.date))} · ${esc(b.booking.time)}${b.staff ? ' · مع ' + esc(b.staff.name) : ''}</p>
      <div class="row wrap" style="justify-content:center;gap:8px;margin-top:10px">
        <span class="chip ${b.booking.status === 'confirmed' ? 'green' : 'amber'}">${STATUS[b.booking.status]?.label || b.booking.status}</span>
        <span class="chip ${b.paid ? 'green' : 'gold'}">${b.paid ? 'العربون مدفوع ✓' : 'العربون: ' + money(b.booking.deposit)}</span>
        <span class="chip">الإجمالي: ${money(b.booking.price)}</span>
      </div>
      ${awaitingPay ? `<div class="card pad" style="background:#FFF8E8;border:1px solid #F5DBA0;margin-top:12px">
        <div class="small" style="color:#8A5B00"><b>🔒 لم يكتمل الدفع بعد.</b> أكمل العملية في النافذة التي فُتحت. ستُحدَّث هذه الصفحة تلقائياً.</div>
        <button class="btn btn-gold btn-sm mt-1" id="succ-pay">إعادة فتح صفحة الدفع</button>
      </div>` : ''}
      <div class="row mt-3" style="justify-content:center;gap:10px">
        <button class="btn btn-primary" id="succ-my">عرض حجوزاتي</button>
        <button class="btn btn-ghost" id="succ-another">حجز آخر</button>
      </div>
    </div>`;
  $('#succ-pay')?.addEventListener('click', async () => {
    const c = await openCheckout(b.payment?.id);
    if (c) watchPayment(c.token, () => { b.paid = true; if (b.booking) b.booking.status = 'confirmed'; toast('تم دفع العربون ✓', 'ok'); renderWizard(); });
  });
  $('#succ-my').addEventListener('click', () => { S.view = 'mybookings'; render(); });
  $('#succ-another').addEventListener('click', () => { S.wizard = { step: 1, service: null, staff: null, date: dateKey(), time: null, slotData: null, lastBooking: null }; renderWizard(); });
}

/* ==========================================================================
   حجوزاتي (الزبون)
   ========================================================================== */
async function renderMyBookings(main) {
  main.innerHTML = '<div class="mt-3"><div class="skeleton" style="height:120px"></div></div>';
  let bookings = [];
  try { bookings = (await api('/api/my/bookings')).bookings; } catch (e) { main.innerHTML = `<div class="empty"><div class="ico">⚠️</div><h3>${esc(e.message)}</h3></div>`; return; }
  const upcoming = bookings.filter((b) => b.date >= dateKey() && !['cancelled', 'completed', 'no_show'].includes(b.status));
  const past = bookings.filter((b) => !upcoming.includes(b));

  main.innerHTML = `
    <div class="section-title"><h2>حجوزاتي</h2><span class="spacer"></span><span class="chip blue">${bookings.length} حجز</span></div>
    <h3 class="mb-1">القادمة</h3>
    <div id="upcoming">${upcoming.length ? upcoming.map(bookingCard).join('') : '<div class="empty card"><div class="ico">📅</div><h3>لا حجوزات قادمة</h3><p>ابدئي بحجز موعد جديد.</p></div>'}</div>
    ${past.length ? `<h3 class="mb-1 mt-3">السابقة</h3><div>${past.slice(0, 20).map(bookingCard).join('')}</div>` : ''}`;

  main.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('هل تريدين إلغاء هذا الحجز؟')) return;
    try { await api(`/api/bookings/${b.dataset.cancel}`, { method: 'PATCH', body: { status: 'cancelled' } }); toast('تم إلغاء الحجز', 'ok'); renderMyBookings(main); }
    catch (e) { toast(e.message, 'err'); }
  }));
  main.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    const checkout = await openCheckout(b.dataset.pay);
    if (!checkout) return;
    toast('أكملي الدفع في النافذة الجديدة…', 'ok');
    watchPayment(checkout.token, () => { toast('تم دفع العربون ✓', 'ok'); renderMyBookings(main); });
  }));
}

function bookingCard(b) {
  const st = STATUS[b.status] || { label: b.status, cls: '' };
  const due = b.deposit - (b.paid_amount || 0);
  return `
  <div class="booking-row">
    <div class="time-box"><b>${esc(b.time)}</b><span>${esc(todayLabel(b.date))}</span></div>
    <div class="info">
      <b>${esc(b.service_name)} · ${esc(b.salon_name)}</b>
      <span>${esc(b.salon_city || '')}${b.staff_name ? ' · مع ' + esc(b.staff_name) : ''} · ${money(b.price)}</span>
    </div>
    <span class="chip ${st.cls}">${st.label}</span>
    <div class="actions">
      ${due > 0 && ['pending', 'confirmed'].includes(b.status) ? `<button class="btn btn-gold btn-sm" data-pay="${b.id}">دفع ${money(due)}</button>` : ''}
      ${['pending', 'confirmed'].includes(b.status) ? `<button class="icon-btn danger" title="إلغاء" data-cancel="${b.id}">✕</button>` : ''}
    </div>
  </div>`;
}

/* ==========================================================================
   لوحة تحكم الصالون
   ========================================================================== */
async function renderDashboard(main) {
  if (!S.mySalons.length) await loadMySalons();
  if (!S.mySalons.length) {
    main.innerHTML = `<div class="empty card mt-3"><div class="ico">🏪</div><h3>لا تملك صالوناً بعد</h3><p>أنشئ صالونك الأول لتبدأ إدارة الحجوزات.</p><button class="btn btn-primary mt-2" id="new-salon-cta">➕ إنشاء صالون</button></div>`;
    $('#new-salon-cta').addEventListener('click', openNewSalon);
    return;
  }
  if (!S.mySalons.some((s) => s.id === S.dashSalonId)) S.dashSalonId = S.mySalons[0].id;

  main.innerHTML = `
    <div class="section-title"><h2>لوحة التحكم</h2><span class="spacer"></span>
      <button class="btn btn-soft btn-sm" id="refresh">🔄 تحديث</button></div>
    <div class="salon-pick mb-2">
      ${S.mySalons.map((s) => `<button class="s ${S.dashSalonId === s.id ? 'active' : ''}" data-dsalon="${s.id}">
        <b>${esc(s.name)}</b><span>📍 ${esc(s.city || '—')} ${s.role === 'staff' ? '· موظفة' : ''}${s.parent_name ? ' · فرع من ' + esc(s.parent_name) : ''}</span></button>`).join('')}
    </div>
    <div class="dash-layout">
      <nav class="side-nav">
        ${[['analytics', '📊', 'التحليلات'], ['bookings', '📅', 'الحجوزات'], ['payments', '💳', 'المدفوعات'], ['services', '✂️', 'الخدمات'], ['staff', '👥', 'الطاقم'], ['notifications', '🔔', 'الإشعارات'], ['settings', '⚙️', 'الإعدادات']]
          .map(([k, i, l]) => `<button data-dtab="${k}" class="${S.dashTab === k ? 'active' : ''}"><span class="ico">${i}</span>${l}</button>`).join('')}
      </nav>
      <section id="dash-body"><div class="skeleton" style="height:300px"></div></section>
    </div>`;

  main.querySelectorAll('[data-dsalon]').forEach((b) => b.addEventListener('click', () => { S.dashSalonId = +b.dataset.dsalon; renderDashboard(main); }));
  main.querySelectorAll('[data-dtab]').forEach((b) => b.addEventListener('click', () => { S.dashTab = b.dataset.dtab; renderDashboard(main); }));
  $('#refresh').addEventListener('click', () => renderDashboard(main));

  const body = $('#dash-body');
  const salon = S.mySalons.find((s) => s.id === S.dashSalonId);
  if (S.dashTab === 'analytics') return dashAnalytics(body, salon);
  if (S.dashTab === 'bookings') return dashBookings(body, salon);
  if (S.dashTab === 'payments') return dashPayments(body, salon);
  if (S.dashTab === 'services') return dashServices(body, salon);
  if (S.dashTab === 'staff') return dashStaff(body, salon);
  if (S.dashTab === 'notifications') return dashNotifications(body, salon);
  if (S.dashTab === 'settings') return dashSettings(body, salon);
}

/* ------------------------- التحليلات ------------------------- */
async function dashAnalytics(host, salon) {
  host.innerHTML = '<div class="skeleton" style="height:300px"></div>';
  let a;
  try { a = await api(`/api/salons/${salon.id}/analytics?days=30`); }
  catch (e) { host.innerHTML = `<div class="empty card"><div class="ico">⚠️</div><h3>${esc(e.message)}</h3></div>`; return; }
  const k = a.kpis;
  host.innerHTML = `
    <div class="grid grid-3 mb-2">
      <div class="kpi solid-blue"><div class="kpi-label">إيرادات 30 يوماً</div><div class="kpi-value">${Number(k.revenue).toLocaleString('ar-MA')}</div><div class="kpi-sub">درهم مغربي</div></div>
      <div class="kpi solid-gold"><div class="kpi-label">إجمالي الحجوزات</div><div class="kpi-value">${k.bookings}</div><div class="kpi-sub">${k.completed} مكتمل · ${k.cancelled} ملغى</div></div>
      <div class="kpi solid-green"><div class="kpi-label">متوسط الفاتورة</div><div class="kpi-value">${k.avg_ticket}</div><div class="kpi-sub">د.م لكل حجز مكتمل</div></div>
    </div>
    <div class="grid grid-4 mb-2">
      <div class="kpi light"><div class="kpi-label muted">مواعيد اليوم</div><div class="kpi-value" style="color:var(--blue)">${k.today_count}</div></div>
      <div class="kpi light"><div class="kpi-label muted">إيراد اليوم</div><div class="kpi-value" style="color:var(--green)">${k.today_revenue}</div></div>
      <div class="kpi light"><div class="kpi-label muted">دفعات معلّقة</div><div class="kpi-value" style="color:var(--amber)">${k.pending_payments}</div></div>
      <div class="kpi light"><div class="kpi-label muted">نسبة الإلغاء</div><div class="kpi-value" style="color:var(--red)">${k.cancel_rate}%</div></div>
    </div>
    <div class="card mb-2"><h3 class="mb-2">الأداء خلال 30 يوماً</h3>${lineChart(a.series)}</div>
    <div class="grid grid-2">
      <div class="card"><h3 class="mb-2">أفضل الخدمات</h3>${barList(a.top_services.map((s) => ({ label: s.name, value: s.revenue })), { unit: ' د.م' })}</div>
      <div class="card"><h3 class="mb-2">أداء الطاقم (إيراد)</h3>${barList(a.staff.map((s) => ({ label: s.name, value: s.revenue })), { unit: ' د.م', color: 'linear-gradient(135deg,#F5B93A,#e0990c)' })}</div>
    </div>
    <div class="grid grid-2 mt-2">
      <div class="card"><h3 class="mb-2">حالات الحجوزات</h3>${donut(a.status_breakdown.map((s, i) => ({
        label: (STATUS[s.status] || {}).label || s.status, value: s.count,
        color: ['#F0A81C', '#2F3FB0', '#12805A', '#B42318', '#7C3AED'][i],
      })))}</div>
      <div class="card"><h3 class="mb-2">توزيع الساعات الأكثر ازدحاماً</h3>${barList(a.by_hour.filter((h) => h.count).map((h) => ({ label: `${h.hour}:00`, value: h.count })), { unit: ' حجز' })}</div>
    </div>`;
}

/* ------------------------- الحجوزات ------------------------- */
async function dashBookings(host, salon) {
  const f = S.bookingsFilter;
  host.innerHTML = `
    <div class="card mb-2">
      <div class="row wrap" style="gap:10px">
        <div class="field" style="margin:0"><label>التاريخ</label><input type="date" class="input" id="f-date" value="${f.date}" /></div>
        <div class="field" style="margin:0"><label>الحالة</label>
          <select class="input" id="f-status">
            <option value="">الكل</option>
            ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select></div>
        <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn btn-primary" id="f-apply">تصفية</button></div>
        <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn btn-ghost" id="f-today">اليوم</button></div>
        <span class="spacer"></span>
        <div class="field" style="margin:0"><label>&nbsp;</label><button class="btn btn-gold" id="new-booking">➕ حجز يدوي</button></div>
      </div>
    </div>
    <div id="bk-list"><div class="skeleton" style="height:200px"></div></div>`;

  const load = async () => {
    const q = new URLSearchParams();
    if (S.bookingsFilter.date) q.set('date', S.bookingsFilter.date);
    if (S.bookingsFilter.status) q.set('status', S.bookingsFilter.status);
    try {
      const { bookings } = await api(`/api/salons/${salon.id}/bookings?${q}`);
      $('#bk-list').innerHTML = bookings.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>التاريخ</th><th>الساعة</th><th>الزبونة</th><th>الخدمة</th><th>الأخصائية</th><th>السعر</th><th>المدفوع</th><th>الحالة</th><th>إجراءات</th></tr></thead>
          <tbody>${bookings.map((b) => {
            const st = STATUS[b.status] || { label: b.status, cls: '' };
            return `<tr>
              <td>${esc(b.date)}<div class="small muted">${esc(todayLabel(b.date))}</div></td>
              <td class="bold">${esc(b.time)}</td>
              <td>${esc(b.customer_name)}<div class="small muted">${esc(b.customer_phone)}</div></td>
              <td>${esc(b.service_name)}</td>
              <td>${esc(b.staff_name || '—')}</td>
              <td>${money(b.price)}</td>
              <td>${money(b.paid_amount || 0)}</td>
              <td><span class="chip ${st.cls}">${st.label}</span></td>
              <td><div class="row" style="gap:4px">
                <button class="icon-btn wa" title="تذكير واتساب" data-wa="${b.id}">💬</button>
                <select class="input" style="padding:5px 8px;font-size:12px;width:auto" data-status="${b.id}">
                  ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${b.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
                ${b.status === 'completed' ? `<button class="icon-btn" title="تحصيل المتبقي" data-collect="${b.id}">💰</button>` : ''}
              </div></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>` : '<div class="empty card"><div class="ico">📭</div><h3>لا حجوزات</h3><p>لا توجد حجوزات مطابقة للتصفية.</p></div>';

      document.querySelectorAll('[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
        try { await api(`/api/bookings/${sel.dataset.status}`, { method: 'PATCH', body: { status: sel.value } }); toast('تم تحديث الحالة', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }));
      document.querySelectorAll('[data-wa]').forEach((btn) => btn.addEventListener('click', () => sendWhatsApp(+btn.dataset.wa)));
      document.querySelectorAll('[data-collect]').forEach((btn) => btn.addEventListener('click', async () => {
        try { await api(`/api/bookings/${btn.dataset.collect}/pay-remaining`, { method: 'POST', body: { method: 'cash' } }); toast('تم تحصيل المتبقي ✓', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }));
    } catch (e) { $('#bk-list').innerHTML = `<div class="empty card"><h3>${esc(e.message)}</h3></div>`; }
  };

  $('#f-apply').addEventListener('click', () => { S.bookingsFilter = { date: $('#f-date').value, status: $('#f-status').value }; load(); });
  $('#f-today').addEventListener('click', () => { S.bookingsFilter = { date: dateKey(), status: '' }; $('#f-date').value = dateKey(); $('#f-status').value = ''; load(); });
  $('#new-booking').addEventListener('click', () => openManualBooking(salon, load));
  load();
}

async function sendWhatsApp(bookingId) {
  try {
    const { booking } = await api(`/api/bookings/${bookingId}`);
    const notifs = (await api(`/api/salons/${booking.salon_id}/notifications`)).notifications;
    const n = notifs.find((x) => x.booking_id === bookingId) || notifs[0];
    const msg = n ? n.message : `تذكير بموعدك في ${booking.salon_name} يوم ${booking.date} الساعة ${booking.time}`;
    let phone = booking.customer_phone.replace(/\D/g, '');
    if (phone.startsWith('0')) phone = '212' + phone.slice(1);
    if (n) api(`/api/notifications/${n.id}/send`, { method: 'POST' }).catch(() => {});
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  } catch (e) { toast(e.message, 'err'); }
}

function openManualBooking(salon, reload) {
  api(`/api/salons/${salon.id}`).then((data) => {
    openModal('حجز يدوي (هاتفي)', `
      <div class="field"><label>الزبونة</label><input class="input" id="mb-name" /></div>
      <div class="field"><label>الهاتف</label><input class="input" id="mb-phone" /></div>
      <div class="field"><label>الخدمة</label><select class="input" id="mb-svc">${data.services.map((s) => `<option value="${s.id}">${esc(s.name)} — ${money(s.price)}</option>`).join('')}</select></div>
      <div class="input-row">
        <div class="field"><label>التاريخ</label><input type="date" class="input" id="mb-date" value="${dateKey()}" /></div>
        <div class="field"><label>الساعة</label><input type="time" class="input" id="mb-time" value="10:00" /></div>
      </div>
      <div class="field"><label>الأخصائية</label><select class="input" id="mb-staff"><option value="">تلقائي</option>${data.staff.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
      <label class="row small"><input type="checkbox" id="mb-confirm" checked /> تأكيد فوري</label>`,
      { footer: '<button class="btn btn-primary" id="mb-save">حفظ الحجز</button><button class="btn btn-ghost" data-close>إلغاء</button>' });
    $('#mb-save').addEventListener('click', async () => {
      try {
        await api('/api/bookings', { method: 'POST', body: {
          salon_id: salon.id, service_id: +$('#mb-svc').value, staff_id: $('#mb-staff').value ? +$('#mb-staff').value : null,
          date: $('#mb-date').value, time: $('#mb-time').value, customer_name: $('#mb-name').value.trim(),
          customer_phone: $('#mb-phone').value.trim(), confirm_now: $('#mb-confirm').checked,
        } });
        closeModal(); toast('تم إنشاء الحجز', 'ok'); reload?.();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

/* ------------------------- المدفوعات ------------------------- */
async function dashPayments(host, salon) {
  host.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  try {
    const { payments, totals } = await api(`/api/salons/${salon.id}/payments?days=90`);
    host.innerHTML = `
      <div class="grid grid-2 mb-2">
        <div class="kpi solid-green"><div class="kpi-label">محصّل (90 يوماً)</div><div class="kpi-value">${totals.paid}</div><div class="kpi-sub">د.م</div></div>
        <div class="kpi solid-gold"><div class="kpi-label">معلّق</div><div class="kpi-value">${totals.pending}</div><div class="kpi-sub">د.م بانتظار الدفع</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>المرجع</th><th>الزبونة</th><th>الخدمة</th><th>النوع</th><th>الطريقة</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr></thead>
        <tbody>${payments.map((p) => `<tr>
          <td class="small muted">${esc(p.provider_ref || '—')}</td>
          <td>${esc(p.customer_name)}</td><td>${esc(p.service_name)}</td>
          <td>${p.kind === 'deposit' ? 'عربون' : p.kind === 'full' ? 'كامل' : 'استرجاع'}</td>
          <td>${{ card: 'بطاقة', cash: 'نقداً', transfer: 'تحويل', wallet: 'محفظة' }[p.method] || p.method}</td>
          <td class="bold">${money(p.amount)}</td>
          <td><span class="chip ${p.status === 'paid' ? 'green' : p.status === 'pending' ? 'amber' : 'red'}">${p.status === 'paid' ? 'مدفوع' : p.status === 'pending' ? 'معلّق' : 'فشل'}</span></td>
          <td class="small muted">${esc(String(p.created_at).slice(0, 16))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  } catch (e) { host.innerHTML = `<div class="empty card"><h3>${esc(e.message)}</h3></div>`; }
}

/* ------------------------- الخدمات ------------------------- */
async function dashServices(host, salon) {
  host.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  const data = await api(`/api/salons/${salon.id}`);
  host.innerHTML = `
    <div class="row mb-2"><h3>الخدمات (${data.services.length})</h3><span class="spacer"></span>
      <button class="btn btn-primary btn-sm" id="add-svc">➕ خدمة جديدة</button></div>
    <div class="grid grid-2">
      ${data.services.map((s) => `<div class="card">
        <div class="row"><b style="flex:1">${esc(s.name)}</b><span class="chip gold">${money(s.price)}</span></div>
        <div class="small muted mt-1">⏱ ${s.minutes} دقيقة</div>
        <div class="row mt-2" style="gap:8px">
          <button class="btn btn-soft btn-sm" data-edit-svc="${s.id}">تعديل</button>
          <button class="btn btn-danger btn-sm" data-del-svc="${s.id}">حذف</button>
        </div>
      </div>`).join('') || '<div class="empty card">لا خدمات بعد.</div>'}
    </div>`;

  const refresh = () => dashServices(host, salon);
  $('#add-svc').addEventListener('click', () => openServiceModal(salon, null, refresh));
  host.querySelectorAll('[data-edit-svc]').forEach((b) => b.addEventListener('click', () => openServiceModal(salon, data.services.find((s) => s.id === +b.dataset.editSvc), refresh)));
  host.querySelectorAll('[data-del-svc]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('حذف هذه الخدمة؟')) return;
    try { await api(`/api/services/${b.dataset.delSvc}`, { method: 'DELETE' }); toast('تم الحذف', 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); }
  }));
}

function openServiceModal(salon, svc, reload) {
  openModal(svc ? 'تعديل خدمة' : 'خدمة جديدة', `
    <div class="field"><label>اسم الخدمة</label><input class="input" id="sv-name" value="${esc(svc?.name || '')}" /></div>
    <div class="input-row">
      <div class="field"><label>السعر (د.م)</label><input class="input" type="number" id="sv-price" value="${svc?.price ?? 100}" /></div>
      <div class="field"><label>المدة (دقيقة)</label><input class="input" type="number" id="sv-mins" value="${svc?.minutes ?? 45}" /></div>
    </div>`,
    { footer: '<button class="btn btn-primary" id="sv-save">حفظ</button><button class="btn btn-ghost" data-close>إلغاء</button>' });
  $('#sv-save').addEventListener('click', async () => {
    try {
      const body = { name: $('#sv-name').value.trim(), price: +$('#sv-price').value, minutes: +$('#sv-mins').value };
      if (svc) await api(`/api/services/${svc.id}`, { method: 'PATCH', body });
      else await api(`/api/salons/${salon.id}/services`, { method: 'POST', body });
      closeModal(); toast('تم الحفظ ✓', 'ok'); reload();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------- الطاقم ------------------------- */
async function dashStaff(host, salon) {
  host.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  const data = await api(`/api/salons/${salon.id}`);
  host.innerHTML = `
    <div class="row mb-2"><h3>الطاقم (${data.staff.length})</h3><span class="spacer"></span>
      <button class="btn btn-primary btn-sm" id="add-staff">➕ إضافة موظفة</button></div>
    <div class="grid grid-3">
      ${data.staff.map((st) => `<div class="card center">
        <span class="avatar" style="width:56px;height:56px;font-size:22px;background:${st.color || '#2F3FB0'};margin:0 auto 10px">${esc(initials(st.name))}</span>
        <b>${esc(st.name)}</b><div class="small muted">${esc(st.title || '')}</div>
        <div class="small muted mt-1">${esc(st.phone || '—')}</div>
        <div class="row mt-2" style="gap:6px;justify-content:center">
          <button class="btn btn-soft btn-sm" data-edit-staff="${st.id}">تعديل</button>
          <button class="btn btn-danger btn-sm" data-del-staff="${st.id}">إزالة</button>
        </div>
      </div>`).join('') || '<div class="empty card" style="grid-column:1/-1">لا موظفات بعد.</div>'}
    </div>`;
  const refresh = () => dashStaff(host, salon);
  $('#add-staff').addEventListener('click', () => openStaffModal(salon, data, null, refresh));
  host.querySelectorAll('[data-edit-staff]').forEach((b) => b.addEventListener('click', () => openStaffModal(salon, data, data.staff.find((s) => s.id === +b.dataset.editStaff), refresh)));
  host.querySelectorAll('[data-del-staff]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('إزالة هذه الموظفة؟')) return;
    try { await api(`/api/staff/${b.dataset.delStaff}`, { method: 'DELETE' }); toast('تمت الإزالة', 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); }
  }));
}

function openStaffModal(salon, data, st, reload) {
  openModal(st ? 'تعديل موظفة' : 'إضافة موظفة', `
    <div class="field"><label>الاسم</label><input class="input" id="st-name" value="${esc(st?.name || '')}" /></div>
    <div class="input-row">
      <div class="field"><label>المسمى</label><input class="input" id="st-title" value="${esc(st?.title || '')}" placeholder="خبيرة شعر" /></div>
      <div class="field"><label>الهاتف</label><input class="input" id="st-phone" value="${esc(st?.phone || '')}" /></div>
    </div>
    <div class="field"><label>الخدمات التي تقدّمها</label>
      <div class="row wrap" style="gap:8px">${data.services.map((s) => `<label class="chip" style="cursor:pointer"><input type="checkbox" value="${s.id}" ${st?.service_ids?.includes(s.id) ? 'checked' : ''}/> ${esc(s.name)}</label>`).join('')}</div>
    </div>`,
    { footer: '<button class="btn btn-primary" id="st-save">حفظ</button><button class="btn btn-ghost" data-close>إلغاء</button>' });
  $('#st-save').addEventListener('click', async () => {
    try {
      const service_ids = [...document.querySelectorAll('.modal input[type=checkbox]:checked')].map((c) => +c.value);
      const body = { name: $('#st-name').value.trim(), title: $('#st-title').value.trim(), phone: $('#st-phone').value.trim(), service_ids };
      if (st) await api(`/api/staff/${st.id}`, { method: 'PATCH', body });
      else await api(`/api/salons/${salon.id}/staff`, { method: 'POST', body });
      closeModal(); toast('تم الحفظ ✓', 'ok'); reload();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------- الإشعارات ------------------------- */
async function dashNotifications(host, salon) {
  host.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  try {
    const { notifications } = await api(`/api/salons/${salon.id}/notifications`);
    host.innerHTML = `
      <div class="card mb-2 row wrap" style="gap:12px">
        <div><b>مركز الإشعارات</b><div class="small muted">أرسلي تذكيرات مواعيد الغد لجميع الحجوزات المؤكّدة.</div></div>
        <span class="spacer"></span>
        <button class="btn btn-gold" id="gen-reminders">🔔 جدولة تذكيرات الغد</button>
      </div>
      <div class="grid" style="gap:8px">
        ${notifications.length ? notifications.map((n) => `
          <div class="card" style="padding:14px 16px">
            <div class="row"><span class="chip ${n.channel === 'whatsapp' ? 'green' : 'blue'}">${n.channel === 'whatsapp' ? 'واتساب' : 'SMS'}</span>
              <span class="chip ${n.status === 'sent' ? 'green' : n.status === 'queued' ? 'amber' : 'red'}">${n.status === 'sent' ? 'أُرسل' : n.status === 'queued' ? 'في الانتظار' : 'فشل'}</span>
              <span class="spacer"></span><span class="small muted">${esc(String(n.created_at).slice(0, 16))}</span></div>
            <div class="mt-1"><b>${esc(n.customer_name || n.to_phone)}</b> <span class="small muted">· ${esc(n.to_phone)}</span></div>
            <div class="small mt-1" style="white-space:pre-line;color:var(--muted)">${esc(n.message)}</div>
            <div class="row mt-2" style="gap:8px">
              <a class="btn btn-soft btn-sm" href="${esc(n.link)}" target="_blank" rel="noopener" data-mark="${n.id}">💬 إرسال عبر واتساب</a>
              ${n.status !== 'sent' ? `<button class="btn btn-ghost btn-sm" data-sent="${n.id}">تعليم كمُرسل</button>` : ''}
            </div>
          </div>`).join('') : '<div class="empty card"><div class="ico">🔔</div><h3>لا إشعارات بعد</h3></div>'}
      </div>`;
    $('#gen-reminders').addEventListener('click', async () => {
      try { const r = await api(`/api/salons/${salon.id}/reminders`, { method: 'POST', body: { channel: 'whatsapp' } }); toast(`تمت جدولة ${r.queued} تذكير`, 'ok'); dashNotifications(host, salon); }
      catch (e) { toast(e.message, 'err'); }
    });
    host.querySelectorAll('[data-sent]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/notifications/${b.dataset.sent}/send`, { method: 'POST' }); toast('تم التعليم', 'ok'); dashNotifications(host, salon); } catch (e) { toast(e.message, 'err'); }
    }));
    host.querySelectorAll('[data-mark]').forEach((a) => a.addEventListener('click', () => api(`/api/notifications/${a.dataset.mark}/send`, { method: 'POST' }).catch(() => {})));
  } catch (e) { host.innerHTML = `<div class="empty card"><h3>${esc(e.message)}</h3></div>`; }
}

/* ------------------------- الإعدادات ------------------------- */
async function dashSettings(host, salon) {
  const [{ salon: s, branches }, payStatus] = await Promise.all([
    api(`/api/salons/${salon.id}`),
    api('/api/settings/payment').catch(() => null),
  ]);

  // هل المزوّد جاهز فعلاً على الخادم؟
  const payReady = (p) => !payStatus ? false
    : p === 'simulated' ? true
    : p === 'stripe' ? Boolean(payStatus.stripe?.configured && payStatus.stripe?.webhook_secret_set)
    : p === 'cmi' ? Boolean(payStatus.cmi?.configured)
    : false;

  const payCard = !payStatus ? '' : `
    <div class="card mt-2">
      <div class="row mb-2"><h3>💳 الدفع الإلكتروني</h3><span class="spacer"></span>
        <span class="chip ${payStatus.provider === 'simulated' ? 'amber' : 'green'}">${esc(PAY_LABELS[payStatus.provider] || payStatus.provider)}</span></div>
      <div class="field"><label>مزوّد الدفع</label>
        <select class="input" id="pay-provider">
          ${payStatus.available.map((p) => `<option value="${p}" ${payStatus.provider === p ? 'selected' : ''} ${payReady(p) ? '' : 'disabled'}>${esc(PAY_LABELS[p] || p)}${payReady(p) ? '' : ' — غير مُهيّأ'}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>رابط الموقع العام (لروابط الدفع والـ webhooks)</label>
        <input class="input" id="pay-base" value="${esc(payStatus.public_base_url)}" placeholder="https://hajzi.ma" dir="ltr" /></div>
      <div class="small muted mb-1">
        Stripe: ${payStatus.stripe.configured ? '✅ مُهيّأ' : '⚠️ غير مُهيّأ'}${payStatus.stripe.mode ? ' (' + esc(payStatus.stripe.mode) + ')' : ''}
        · CMI: ${payStatus.cmi.configured ? '✅ مُهيّأ' : '⚠️ غير مُهيّأ'}
      </div>
      <div class="small muted mb-2">عنوان الـ Webhook المسجَّل لدى المزوّد:<br>
        <code dir="ltr">${esc(payStatus.public_base_url)}/api/webhooks/stripe</code><br>
        <code dir="ltr">${esc(payStatus.public_base_url)}/api/webhooks/cmi</code></div>
      <button class="btn btn-primary" id="pay-save">حفظ إعدادات الدفع</button>
    </div>`;

  host.innerHTML = `
    <div class="card mb-2">
      <h3 class="mb-2">معلومات الصالون</h3>
      <div class="input-row">
        <div class="field"><label>الاسم</label><input class="input" id="se-name" value="${esc(s.name)}" /></div>
        <div class="field"><label>المدينة</label><input class="input" id="se-city" value="${esc(s.city || '')}" /></div>
      </div>
      <div class="field"><label>العنوان</label><input class="input" id="se-addr" value="${esc(s.address || '')}" /></div>
      <div class="input-row">
        <div class="field"><label>الهاتف</label><input class="input" id="se-phone" value="${esc(s.phone || '')}" /></div>
        <div class="field"><label>نسبة العربون %</label><input class="input" type="number" id="se-deposit" value="${s.deposit_pct}" /></div>
      </div>
      <div class="input-row">
        <div class="field"><label>وقت الفتح</label><input class="input" type="time" id="se-open" value="${esc(s.open_time)}" /></div>
        <div class="field"><label>وقت الإغلاق</label><input class="input" type="time" id="se-close" value="${esc(s.close_time)}" /></div>
      </div>
      <div class="input-row">
        <div class="field"><label>مدة الفترة (دقيقة)</label><input class="input" type="number" id="se-slot" value="${s.slot_minutes}" /></div>
        <div class="field"><label>يوم الإغلاق</label><select class="input" id="se-closed">${DAYS.map((d, i) => `<option value="${i}" ${s.closed_weekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      </div>
      <button class="btn btn-primary" id="se-save">حفظ التعديلات</button>
    </div>
    <div class="card">
      <div class="row mb-2"><h3>الفروع</h3><span class="spacer"></span><button class="btn btn-soft btn-sm" id="add-branch">➕ إضافة فرع</button></div>
      ${branches.length ? branches.map((b) => `<div class="booking-row">
        <span class="avatar" style="background:var(--blue)">${esc(b.logo_letter || 'ف')}</span>
        <div class="info"><b>${esc(b.name)}</b><span>📍 ${esc(b.city || '—')} · ${esc(b.open_time)}–${esc(b.close_time)}</span></div>
        <button class="btn btn-soft btn-sm" data-open-branch="${b.id}">إدارة</button></div>`).join('')
        : '<div class="small muted">لا فروع. أضف فرعاً لإدارة عدة مواقع.</div>'}
    </div>
    ${payCard}`;

  $('#se-save').addEventListener('click', async () => {
    try {
      await api(`/api/salons/${s.id}`, { method: 'PATCH', body: {
        name: $('#se-name').value, city: $('#se-city').value, address: $('#se-addr').value, phone: $('#se-phone').value,
        deposit_pct: +$('#se-deposit').value, open_time: $('#se-open').value, close_time: $('#se-close').value,
        slot_minutes: +$('#se-slot').value, closed_weekday: +$('#se-closed').value,
      } });
      toast('تم الحفظ ✓', 'ok'); await loadMySalons(); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#pay-save')?.addEventListener('click', async () => {
    try {
      await api('/api/settings/payment', { method: 'PATCH', body: {
        provider: $('#pay-provider').value,
        public_base_url: $('#pay-base').value,
      } });
      toast('تم حفظ إعدادات الدفع ✓', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#add-branch').addEventListener('click', () => openNewSalon(s.id));
  host.querySelectorAll('[data-open-branch]').forEach((b) => b.addEventListener('click', () => { S.dashSalonId = +b.dataset.openBranch; S.dashTab = 'analytics'; render(); }));
}

/* ==========================================================================
   نوافذ مساعدة
   ========================================================================== */
function openNewSalon(parentId = null) {
  openModal(parentId ? 'إضافة فرع' : 'صالون جديد', `
    <div class="field"><label>اسم ${parentId ? 'الفرع' : 'الصالون'}</label><input class="input" id="ns-name" /></div>
    <div class="input-row">
      <div class="field"><label>المدينة</label><input class="input" id="ns-city" /></div>
      <div class="field"><label>الهاتف</label><input class="input" id="ns-phone" /></div>
    </div>
    <div class="field"><label>العنوان</label><input class="input" id="ns-addr" /></div>
    <div class="input-row">
      <div class="field"><label>الفتح</label><input class="input" type="time" id="ns-open" value="09:00" /></div>
      <div class="field"><label>الإغلاق</label><input class="input" type="time" id="ns-close" value="18:00" /></div>
    </div>
    <div class="input-row">
      <div class="field"><label>نسبة العربون %</label><input class="input" type="number" id="ns-dep" value="20" /></div>
      <div class="field"><label>يوم الإغلاق</label><select class="input" id="ns-closed">${DAYS.map((d, i) => `<option value="${i}" ${i === 0 ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
    </div>`,
    { footer: '<button class="btn btn-primary" id="ns-save">إنشاء</button><button class="btn btn-ghost" data-close>إلغاء</button>' });
  $('#ns-save').addEventListener('click', async () => {
    try {
      await api('/api/salons', { method: 'POST', body: {
        name: $('#ns-name').value.trim(), city: $('#ns-city').value, phone: $('#ns-phone').value, address: $('#ns-addr').value,
        open_time: $('#ns-open').value, close_time: $('#ns-close').value, deposit_pct: +$('#ns-dep').value,
        closed_weekday: +$('#ns-closed').value, parent_id: parentId,
      } });
      closeModal(); toast('تم الإنشاء ✓', 'ok');
      await loadMySalons(); await loadSalons();
      S.view = 'dashboard'; S.dashTab = 'analytics'; render();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function openProfile() {
  const wa = S.user.whatsapp;
  openModal('الملف الشخصي', `
    <div class="row mb-2"><span class="avatar" style="width:56px;height:56px;font-size:24px;background:${S.user.avatar_color || '#2F3FB0'}">${esc(initials(S.user.name))}</span>
      <div><b>${esc(S.user.name)}</b><div class="small muted">${esc(S.user.email)}</div></div></div>
    <div class="field"><label>الاسم</label><input class="input" id="pr-name" value="${esc(S.user.name)}" /></div>
    <div class="field"><label>الهاتف</label><input class="input" id="pr-phone" value="${esc(S.user.phone || '')}" /></div>
    <div class="wa-box">
      <div class="wa-head">
        <span class="wa-badge">واتساب</span>
        ${wa ? '<span class="chip green">مرتبط</span>' : '<span class="chip">غير مرتبط</span>'}
      </div>
      ${wa
        ? `<div class="small muted" style="margin:6px 0 10px">الرقم المرتبط: <b dir="ltr">${esc(wa.phone)}</b></div>
           <div class="wa-actions">
             <button class="btn btn-ghost" id="wa-sync" type="button">مزامنة مع رقم الهاتف</button>
             <button class="btn btn-ghost" id="wa-unlink" type="button">إلغاء الربط</button>
           </div>`
        : `<p class="small muted" style="margin:6px 0 10px">اربط رقمك للدخول السريع بواتساب واستقبال التذكيرات.</p>
           <div class="field"><label>رقم الواتساب</label><input class="input" id="wa-phone" placeholder="0612345678" /></div>
           <button class="btn btn-primary" id="wa-link" type="button">إرسال رمز الربط</button>
           <div id="wa-link-code" style="display:none;margin-top:10px">
             <div class="field"><label>رمز التحقق</label><input class="input" id="wa-code" inputmode="numeric" maxlength="6" placeholder="______" /></div>
             <button class="btn btn-primary" id="wa-link-verify" type="button">تأكيد الربط</button>
           </div>`}
    </div>`,
    { footer: '<button class="btn btn-primary" id="pr-save">حفظ</button><button class="btn btn-ghost" data-close>إلغاء</button>' });

  $('#pr-save').addEventListener('click', async () => {
    try {
      const { user } = await api('/api/auth/me', { method: 'PATCH', body: { name: $('#pr-name').value, phone: $('#pr-phone').value } });
      setSession(S.token, user); closeModal(); toast('تم الحفظ ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#wa-link')?.addEventListener('click', async (e) => {
    const phone = $('#wa-phone').value.trim();
    if (!phone) return toast('أدخل رقم الواتساب.', 'err');
    e.target.disabled = true; e.target.textContent = 'جارٍ الإرسال...';
    try {
      const r = await api('/api/auth/whatsapp/start', { method: 'POST', body: { phone, purpose: 'link' } });
      $('#wa-link-code').style.display = 'block';
      $('#wa-link-code').dataset.phone = r.phone;
      toast(r.dev_code ? `وضع المحاكاة: الرمز ${r.dev_code}` : 'تم إرسال رمز الربط', 'ok');
    } catch (err) { toast(err.message, 'err'); }
    e.target.disabled = false; e.target.textContent = 'إرسال رمز الربط';
  });

  $('#wa-link-verify')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'جارٍ التأكيد...';
    try {
      const { user } = await api('/api/auth/whatsapp/link', { method: 'POST', body: { phone: $('#wa-link-code').dataset.phone, code: $('#wa-code').value.trim() } });
      setSession(S.token, user); toast('تم ربط واتساب ✓', 'ok'); render(); openProfile();
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; e.target.textContent = 'تأكيد الربط'; }
  });

  $('#wa-sync')?.addEventListener('click', async () => {
    try {
      const { user } = await api('/api/auth/whatsapp/sync', { method: 'POST' });
      setSession(S.token, user); toast('تمت مزامنة الرقم مع ملفك ✓', 'ok'); render(); openProfile();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#wa-unlink')?.addEventListener('click', async () => {
    try {
      const { user } = await api('/api/auth/whatsapp/link', { method: 'DELETE' });
      setSession(S.token, user); toast('تم إلغاء ربط واتساب', 'ok'); render(); openProfile();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ==========================================================================
   الإقلاع
   ========================================================================== */
(async function boot() {
  if (S.token) {
    try {
      const { user } = await api('/api/auth/me');
      S.user = user; localStorage.setItem('hajzi_user', JSON.stringify(user));
      await afterLogin();
      return;
    } catch { clearSession(); }
  }
  renderAuth();
})();
