# دليل نشر خادم حجزي Pro (Render / Railway / Docker)

الخادم **بلا أي اعتماديات خارجية** (`node:http` + `node:sqlite`) — يكفي Node 22+.
هذا الدليل يحصل لك على **رابط عام HTTPS** يستطيع تطبيق الأندرويد الاتصال به.

---

## الخيار 1 — Render (الأسهل، ويدعم Blueprint)

### أ) عبر Blueprint (نشر تلقائي من مستودع Git)

1. ارفع مجلد `hajzi-pro` إلى مستودع GitHub/GitLab.
2. Render Dashboard ← **New** ← **Blueprint** ← اختر المستودع.
3. سيكتشف Render ملف `render.yaml` تلقائياً ويطلب تأكيد المتغيرات.
4. بعد النشر ستحصل على رابط مثل: `https://hajzi-pro.onrender.com`
5. ارجع إلى **Environment** في الخدمة وضع:
   - `HAJZI_PUBLIC_URL` = `https://hajzi-pro.onrender.com`
   - متغيرات مزوّد الواتساب (انظر الأسفل).
6. أعِد النشر (Deploy).

### ب) عبر Docker مباشرة

1. Render ← **New** ← **Web Service** ← اربط المستودع.
2. اختر **Runtime: Docker** ومسار Dockerfile: `./Dockerfile`.
3. Health Check Path: `/health`.
4. أضف متغيرات البيئة المطلوبة ثم Deploy.

> ⚠️ **الخطة المجانية**: القرص غير دائم — تُعاد قاعدة البيانات للبيانات التجريبية عند كل
> إعادة تشغيل. للاحتفاظ بالبيانات: خطة `starter` + قرص مثبّت على `/data`
> (مفعّل في `render.yaml` عند إزالة التعليق عن قسم `disk`).

---

## الخيار 2 — Railway

1. Railway ← **New Project** ← **Deploy from GitHub repo** ← اختر المستودع.
2. سيكتشف `Dockerfile` و`railway.json` تلقائياً.
3. أضف **Volume** مثبّتاً على المسار `/data` (لحفظ قاعدة البيانات).
4. Railway يولّد نطاقاً عاماً: **Settings ← Networking ← Generate Domain**.
5. أضف المتغيرات:
   - `HAJZI_DB=/data/hajzi.db`
   - `HAJZI_SECRET=<سلسلة عشوائية طويلة>`
   - `HAJZI_PUBLIC_URL=https://<نطاقك>.up.railway.app`

---

## الخيار 3 — Docker على أي VPS

```bash
docker build -t hajzi-pro .
docker run -d --name hajzi-pro -p 80:4173 \
  -v /opt/hajzi-data:/data \
  -e HAJZI_SECRET="$(openssl rand -hex 32)" \
  -e HAJZI_DB=/data/hajzi.db \
  -e HAJZI_PUBLIC_URL=https://your-domain.ma \
  -e WHATSAPP_PROVIDER=ultramsg \
  -e ULTRAMSG_INSTANCE_ID=... -e ULTRAMSG_TOKEN=... \
  hajzi-pro
```

ضع الخادم خلف Nginx/Caddy مع شهادة TLS (HTTPS إلزامي للدفع وللاتصال من التطبيق).

---

## مزوّدو الواتساب المدعومون

يُكتشف المزوّد تلقائياً من المتغيرات، أو يدوياً عبر `WHATSAPP_PROVIDER`.

| المزوّد | القيمة | المتغيرات المطلوبة |
|---|---|---|
| محاكاة (بلا إرسال) | `simulated` | — (يُطبع الرمز في السجل/الواجهة) |
| Meta الرسمي | `meta` | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` |
| Twilio | `twilio` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` |
| UltraMsg | `ultramsg` | `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN` |
| Green API | `greenapi` | `GREENAPI_ID_INSTANCE`, `GREENAPI_TOKEN` |
| بوابة عامة | `webhook` | `WHATSAPP_WEBHOOK_URL`, واختياري `WHATSAPP_WEBHOOK_TOKEN` |

### مثال Twilio
```env
WHATSAPP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=+14155238886
```

### مثال UltraMsg
```env
WHATSAPP_PROVIDER=ultramsg
ULTRAMSG_INSTANCE_ID=instance12345
ULTRAMSG_TOKEN=xxxxxxxxxxxx
```

### مثال Green API
```env
WHATSAPP_PROVIDER=greenapi
GREENAPI_ID_INSTANCE=1101000000
GREENAPI_TOKEN=xxxxxxxxxxxxxxxx
```

### بوابة عامة (Webhook)
يُرسل الخادم `POST` بصيغة JSON: `{ "to": "2126...", "message": "..." }`
مع ترويسة `Authorization: Bearer <WHATSAPP_WEBHOOK_TOKEN>` إن حُدّد.
```env
WHATSAPP_PROVIDER=webhook
WHATSAPP_WEBHOOK_URL=https://my-gateway.example.com/send
WHATSAPP_WEBHOOK_TOKEN=optional-secret
```

### التحقق من المزوّد
```bash
curl https://<نطاقك>/api/auth/whatsapp/status
# {"config":{"provider":"ultramsg","ready":true,...}, ...}
```
> عندما يكون المزوّد غير `simulated`، **لا يُعاد رمز التحقق** في استجابة الـ API أبداً.

---

## ربط التطبيق بالخادم

بعد الحصول على الرابط العام:

1. افتح تطبيق **حجزي Pro**.
2. **حسابي ← عنوان الخادم** ← أدخل الرابط، مثلاً `https://hajzi-pro.onrender.com/` (مع الشرطة المائلة في النهاية).
3. احفظ، ثم أعد تشغيل التطبيق.

> إن أردت أن يكون الرابط هو الافتراضي داخل التطبيق (بلا إدخال يدوي)،
> أعد بناء الـ APK مع تمرير العنوان — اطلب ذلك.

---

## قائمة تحقق سريعة

- [ ] `/health` يردّ `{"ok":true,...}` من الرابط العام.
- [ ] `HAJZI_SECRET` مضبوط بقيمة عشوائية قوية (وإلا أُبطلت الجلسات عند كل إعادة تشغيل).
- [ ] `HAJZI_PUBLIC_URL` = الرابط العام بالضبط (بلا `/` في النهاية).
- [ ] قرص/Volume مثبّت على `/data` (للاحتفاظ بالبيانات).
- [ ] `WHATSAPP_PROVIDER` مضبوط ومفاتيحه صحيحة، و`ready:true` في `/api/auth/whatsapp/status`.
- [ ] HTTPS مفعّل (إلزامي للدفع الإلكتروني).
