# حجزي Pro — نظام حجز مواعيد الصالونات (Full-stack)

تطبيق كامل لحجز مواعيد الصالونات في المغرب، مبني **بلا أي مكتبات خارجية**:
`node:http` + `node:sqlite` + `node:crypto` فقط. لا حاجة إلى `npm install`.

---

## التشغيل السريع

```bash
cd hajzi-pro
node server.js
# افتح http://localhost:4173
```

يُنشئ الخادم قاعدة البيانات تلقائياً في `./data/hajzi.db` مع بيانات تجريبية.

### متغيرات البيئة

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `PORT` | `4173` | منفذ الخادم |
| `HOST` | `0.0.0.0` | عنوان الاستماع |
| `HAJZI_DB` | `./data/hajzi.db` | مسار قاعدة البيانات |
| `HAJZI_SECRET` | قيمة عشوائية | مفتاح توقيع جلسات JWT — **عيّنه في الإنتاج** |
| `HAJZI_PUBLIC_URL` | `http://localhost:4173` | الرابط العام (لروابط الدفع والـ webhooks) |
| `HAJZI_PAYMENT_PROVIDER` | `simulated` | مزوّد الدفع الافتراضي |
| `WHATSAPP_PROVIDER` | تلقائي | مزوّد الواتساب: `simulated` \| `meta` \| `twilio` \| `ultramsg` \| `greenapi` \| `webhook` |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` | — | Meta WhatsApp Cloud API |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | — | Twilio WhatsApp |
| `ULTRAMSG_INSTANCE_ID` / `ULTRAMSG_TOKEN` | — | UltraMsg |
| `GREENAPI_ID_INSTANCE` / `GREENAPI_TOKEN` | — | Green API |
| `WHATSAPP_WEBHOOK_URL` / `WHATSAPP_WEBHOOK_TOKEN` | — | بوابة/وسيط HTTP عام |
| `WHATSAPP_BUSINESS_NUMBER` | — | رقم واتساب التجاري (للعرض فقط) |
| `WHATSAPP_GRAPH_VERSION` | `v20.0` | إصدار Graph API |

### الحسابات التجريبية

| الدور | البريد | كلمة المرور |
|---|---|---|
| صاحب صالون | `owner@hajzi.ma` | `owner123` |
| موظفة | `sara@hajzi.ma` | `staff123` |
| زبون | `client@hajzi.ma` | `client123` |

---

## الميزات

- **قاعدة بيانات حقيقية** (SQLite) — 11 جدولاً: مستخدمون، صالونات، فروع، خدمات، طاقم، ربط الطاقم بالخدمات، حجوزات، مدفوعات، أحداث الدفع، إشعارات، إعدادات.
- **مصادقة كاملة** — تشفير كلمات المرور بـ `scrypt` + جلسات JWT موقّعة، وصلاحيات على كل مسار.
- **الدخول بواتساب (OTP) ومزامنة الرقم** — دخول برقم واتساب عبر رمز تحقق، ربط/إلغاء ربط رقم بحساب قائم، ومزامنة الرقم مع الملف الشخصي. يعمل بوضع محاكاة بلا مفاتيح، ويرسل فعلياً عبر WhatsApp Cloud API عند ضبط المتغيرات.
- **عدة صالونات وفروع** — عبر `salons.parent_id` مع مبدّل سريع في اللوحة.
- **حجز ذكي** — معالج 4 خطوات، تعيين تلقائي لأول أخصائية متاحة، وتعطيل الفترات الماضية/المحجوزة.
- **دفع إلكتروني حقيقي** — Stripe و CMI مع صفحة دفع آمنة وتحقق Webhook (انظر الأسفل).
- **تذكيرات واتساب/SMS** — مركز إشعارات + جدولة تذكيرات الغد بضغطة واحدة.
- **تقارير وتحليلات** — إيرادات، متوسط فاتورة، نسبة إلغاء، رسم خطي، أفضل الخدمات، أداء الطاقم، الساعات الأكثر ازدحاماً.
- **إدارة الطاقم والخدمات** — CRUD كامل مع ربط كل موظفة بالخدمات التي تقدّمها.
- **واجهة عربية RTL** حديثة ومتجاوبة مع الجوال.

---

## تكامل الدفع (Stripe / CMI)

### نظرة عامة

الدفع يمرّ عبر ثلاث مراحل مفصولة، بحيث **لا يُعلَن أي دفع مدفوعاً إلا بتأكيد موقّع من المزوّد**:

```
الزبون ──▶ POST /api/payments/:id/checkout ──▶ رابط صفحة الدفع
                                                     │
                            GET /pay/<token>  ◀──────┘   (صفحة آمنة يستضيفها خادمنا)
                                     │
                    POST /pay/<token>/start
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        simulated                Stripe                   CMI
   (تأكيد فوري للتجربة)    (تحويل إلى Checkout)   (نموذج موقّع → البوابة)
                                     │                      │
                                     └────── Webhook ───────┘
                                                │
                              POST /api/webhooks/stripe
                              POST /api/webhooks/cmi
                                     │
                          تحقق من التوقيع + المبلغ + منع التكرار
                                     │
                              الدفعة تصبح paid
```

### الوضع التجريبي (الافتراضي)

`provider = simulated` — لا خصم حقيقي. تُعلَّم الدفعة مدفوعة عند تأكيد المستخدم على صفحة الدفع.
مناسب للعرض والتطوير. للانتقال إلى الإنتاج:

```bash
export HAJZI_PAYMENT_PROVIDER=stripe   # أو cmi
```

أو من لوحة التحكم: **الإعدادات ← الدفع الإلكتروني ← مزوّد الدفع** (لن يسمح الخادم
بتفعيل مزوّد غير مُهيّأ).

---

### Stripe

**المتطلبات:** حساب Stripe (وضع الاختبار يكفي للبدء).

```bash
export STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx
export STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
export STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxxxxxx   # اختياري (للعرض في اللوحة)
export HAJZI_PAYMENT_PROVIDER=stripe
export HAJZI_PUBLIC_URL=https://your-domain.ma        # مهم: يحدد روابط العودة
node server.js
```

**إعداد الـ Webhook:**

1. Stripe Dashboard ← *Developers* ← *Webhooks* ← *Add endpoint*.
2. Endpoint URL: `https://your-domain.ma/api/webhooks/stripe`
3. الأحداث المطلوبة:
   - `checkout.session.completed` — الدفع نجح
   - `checkout.session.expired` — انتهت صلاحية الجلسة
   - `payment_intent.payment_failed` — فشل الدفع
   - `charge.refunded` — استرجاع
4. انسخ *Signing secret* (`whsec_...`) إلى `STRIPE_WEBHOOK_SECRET`.

**الاختبار محلياً** باستخدام Stripe CLI:

```bash
stripe login
stripe listen --forward-to localhost:4173/api/webhooks/stripe
# سيطبع whsec_... استخدمه في STRIPE_WEBHOOK_SECRET
stripe trigger checkout.session.completed
```

> ملاحظة: المبالغ تُرسَل بالسنتيم (المبلغ × 100) بالعملة `mad`.

---

### CMI (البطاقة البنكية المغربية)

**المتطلبات:** حساب تاجر CMI + `store_key` من البنك.

```bash
export CMI_MERCHANT_ID=000000000000000      # clientid
export CMI_STORE_KEY=xxxxxxxxxxxxxxxx       # المفتاح السرّي من CMI
export CMI_GATEWAY_URL=https://payment.cmi.co.ma/fim/est3Dgate   # اختياري
export HAJZI_PAYMENT_PROVIDER=cmi
export HAJZI_PUBLIC_URL=https://your-domain.ma
node server.js
```

**إعداد الـ Webhook / العودة:**

| الحقل في CMI | القيمة |
|---|---|
| `okUrl` | `https://your-domain.ma/pay/<token>/done?status=success` |
| `failUrl` | `https://your-domain.ma/pay/<token>/done?status=fail` |
| `callbackUrl` | `https://your-domain.ma/api/webhooks/cmi` |

هذه الحقول يرسلها الخادم تلقائياً في نموذج الدفع، لذا لا تحتاج إعدادها يدوياً —
فقط تأكد أن `HAJZI_PUBLIC_URL` صحيح ومتاح من الإنترنت.

**التوقيع:** `base64(HMAC-SHA256(values joined by "|", store_key))` مع تهريب `\` و `|`.
يتحقق الخادم من توقيع رد CMI بترتيب المفاتيح الأبجدي، وإن فشل يجرّب ترتيب الطلب.
الدفعة تُقبل فقط إذا تطابق التوقيع **و** `ProcReturnCode == 00` **و** المبلغ مطابق.

> ⚠️ **مهم:** تفاصيل ترتيب حقول التوقيع قد تختلف حسب إصدار بوابة CMI ووثائق البنك.
> راجع `src/payments/cmi.js` وعدّل `REQUEST_FIELDS` إن لزم. اختبر دائماً على بيئة CMI التجريبية أولاً.

---

### صفحة الدفع الآمنة

`GET /pay/<token>` — صفحة HTML يستضيفها خادمك، تعرض ملخص الحجز والمبلغ المطلوب.

- الرمز `<token>` = 24 بايت عشوائي (`randomBytes`) — 48 حرفاً سِت عشرياً، غير قابل للتخمين.
- الصفحة **لا تعرض أي مفاتيح سرّية** ولا تحتفظ ببيانات البطاقة.
- الرابط يُعاد توليده عند كل محاولة دفع، ويمكن إبطاله بتغيير الحالة.

### إجراءات الأمان المطبَّقة

| الإجراء | التفصيل |
|---|---|
| **تحقق التوقيع** | Stripe: HMAC-SHA256 على `${t}.${rawBody}` بمقارنة `timingSafeEqual` |
| **منع إعادة الإرسال** | رفض التوقيعات الأقدم من 300 ثانية |
| **منع التكرار (Idempotency)** | جدول `payment_events` بقيد `UNIQUE(event_id)` |
| **تحقق المبلغ** | يُقارن مبلغ الـ webhook بالمبلغ المخزّن — أي فرق يُرفض |
| **عدم الثقة بالعميل** | لا يُعلَن الدفع مدفوعاً إلا من مسار الخادم |
| **الجسم الخام** | الـ webhooks تُقرأ كـ Buffer خام قبل أي تحليل JSON |
| **ترويسات الحماية** | `CSP`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` |
| **المفاتيح السرّية** | من متغيرات البيئة فقط — لا تُخزَّن في قاعدة البيانات ولا تُعاد في أي استجابة |
| **حدّ الجسم** | 1 ميغابايت كحد أقصى لأي طلب |

---

## واجهة الـ API

### المصادقة
```
POST   /api/auth/register        إنشاء حساب
POST   /api/auth/login           تسجيل الدخول → { token, user }
GET    /api/auth/me              بيانات المستخدم الحالي
PATCH  /api/auth/me              تحديث الاسم/الهاتف
```

### الدخول بواتساب ومزامنة الرقم
```
GET    /api/auth/whatsapp/status        حالة الخدمة + رقم واتساب المرتبط
POST   /api/auth/whatsapp/start         طلب رمز (body: { phone, purpose: login|link })
POST   /api/auth/whatsapp/verify        التحقق من الرمز → دخول أو { needs_registration, signup_token }
POST   /api/auth/whatsapp/complete      إنشاء حساب واتساب جديد (body: { signup_token, name, role, phone?, email? })
POST   /api/auth/whatsapp/link          ربط رقم بحساب مسجّل (يتطلب Bearer + { phone, code })
DELETE /api/auth/whatsapp/link          إلغاء الربط
POST   /api/auth/whatsapp/sync          مزامنة رقم واتساب المرتبط مع حقل الهاتف
```

**تدفق الدخول:**
```
1. start(phone)            → يُرسل رمزاً من 6 أرقام على واتساب (صالح 5 دقائق، 5 محاولات، حدّ 5 طلبات/10 دقائق)
2. verify(phone, code)     → إن وُجد حساب مطابق للرقم: { token, user } (دخول)
                            → إن لم يوجد: { needs_registration: true, signup_token }
3. complete(signup_token, name, role) → يُنشئ الحساب ويربط الرقم ويزامنه
```

> في **وضع المحاكاة** (بلا `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID`) يُعاد الرمز في الحقل `dev_code`
> ويُطبع في سجل الخادم — لتسهيل التطوير والعرض. عند ضبط مفاتيح Cloud API الحقيقية لا يُعاد الرمز أبداً.

### الصالونات والخدمات والطاقم
```
GET    /api/salons               قائمة الصالونات (بحث بالمدينة/الاسم)
GET    /api/salons/:id           تفاصيل + خدمات + طاقم + فروع
POST   /api/salons               إنشاء صالون (owner)
PATCH  /api/salons/:id           تعديل (owner)
DELETE /api/salons/:id           حذف (owner)
GET    /api/my/salons            صالونات المستخدم (owner/staff)
POST   /api/salons/:id/services  إضافة خدمة
PATCH  /api/services/:id         تعديل خدمة
DELETE /api/services/:id         حذف خدمة
POST   /api/salons/:id/staff     إضافة موظفة
PATCH  /api/staff/:id            تعديل موظفة
DELETE /api/staff/:id            حذف موظفة
GET    /api/salons/:id/availability?date=&service_id=&staff_id=
```

### الحجوزات
```
POST   /api/bookings             إنشاء حجز → { booking, payment, pay_url }
GET    /api/my/bookings          حجوزاتي
GET    /api/bookings/:id         تفاصيل + مدفوعات
GET    /api/salons/:id/bookings  حجوزات الصالون (owner/staff)
PATCH  /api/bookings/:id         تغيير الحالة
```

### المدفوعات
```
POST   /api/payments/:id/checkout      تهيئة رابط صفحة الدفع الآمنة
POST   /api/payments/:id/pay           تسجيل دفع نقدي/تحويلي (طاقم فقط)
POST   /api/bookings/:id/pay-remaining تحصيل المتبقي (نقداً أو برابط دفع)
GET    /api/salons/:id/payments        سجل المدفوعات (owner/staff)
GET    /api/pay/:token/status          حالة الدفعة (عام، بالرمز)
GET    /api/settings/payment           إعدادات الدفع (owner)
PATCH  /api/settings/payment           تغيير المزوّد/الرابط العام (owner)
POST   /api/webhooks/stripe            Webhook موقّع من Stripe
POST   /api/webhooks/cmi               رد موقّع من CMI
```

### الإشعارات والتحليلات
```
GET    /api/salons/:id/notifications
POST   /api/notifications/:id/send
POST   /api/salons/:id/reminders       جدولة تذكيرات الغد
GET    /api/salons/:id/analytics?days=30
```

---

## قاعدة البيانات

`users`, `salons` (بفروع عبر `parent_id`), `services`, `staff`, `staff_services`,
`bookings`, `payments`, `payment_events`, `notifications`, `settings`.

الترحيل تلقائي وآمن (`migrate()`) — يضيف الأعمدة الجديدة للقواعد الموجودة دون فقدان بيانات.

```bash
node scripts/reset.js   # حذف البيانات وإعادة الإنشاء
node scripts/seed.js    # بيانات تجريبية إضافية
```

---

## النشر (Render / Railway / Docker)

الخادم جاهز للنشر: يوجد `Dockerfile` و`render.yaml` و`railway.json`.
للحصول على رابط عام HTTPS يتصل به تطبيق الأندرويد، راجع **[DEPLOY.md](DEPLOY.md)**.

---

## النشر في الإنتاج

1. **HTTPS إلزامي** — بوابات الدفع و Stripe يرفضان `http://` في الإنتاج.
   ضع الخادم خلف Nginx/Caddy مع شهادة TLS.
2. **`HAJZI_SECRET` قوي وعشوائي** — وإلا أُبطلت جلسات JWT عند كل إعادة تشغيل.
3. **`HAJZI_PUBLIC_URL`** = نطاقك العام بالضبط (يُستخدم في روابط العودة والـ webhooks).
4. **المفاتيح السرّية من متغيرات البيئة فقط** (Secrets manager / systemd `EnvironmentFile`).
5. **نسخ احتياطي دوري** لملف `data/hajzi.db` (وضع WAL مُفعَّل).
6. **لا تفعّل** `provider=simulated` في الإنتاج.
7. بدّل روابط `wa.me` بـ WhatsApp Business API، وروابط `tel:` بمزوّد SMS (Twilio / Ozone).

### مثال systemd

```ini
[Service]
WorkingDirectory=/opt/hajzi-pro
EnvironmentFile=/etc/hajzi/env
ExecStart=/usr/bin/node server.js
Restart=always
User=hajzi
```

```ini
# /etc/hajzi/env  (chmod 600)
PORT=4173
HAJZI_SECRET=...
HAJZI_PUBLIC_URL=https://hajzi.ma
HAJZI_PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## تطبيق الأندرويد

مشروع أصلي بلغة **Kotlin + Jetpack Compose** في `hajzi-android/` — وليس WebView ولا PWA.

- **البناء:** افتح المجلد في Android Studio واختر *Run*، أو `./gradlew assembleDebug`.
- **عنوان الخادم:** قابل للتغيير من داخل التطبيق (شاشة «حسابي») — الافتراضي `http://10.0.2.2:4173/` للمحاكي.
- **الدفع:** يفتح صفحة الدفع الآمنة في **متصفح النظام** (لا WebView) حفاظاً على أمان البطاقة،
  ثم يتحقق من النتيجة عبر `GET /api/pay/:token/status`.
- **العمل دون اتصال:** قاعدة بيانات محلية (Room) مع طابور حجوزات يُرفع تلقائياً عند عودة الشبكة.
