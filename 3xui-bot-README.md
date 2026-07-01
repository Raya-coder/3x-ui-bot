# 3X-UI Telegram Bot — Cloudflare Worker v4.0

> ربات مدیریت پنل 3x-ui، اکانت Cloudflare و دسترسی SSH — نسخه کامل چندزبانه

ربات تلگرام قدرتمند برای مدیریت [3x-ui](https://github.com/MHSanaei/3x-ui)، اکانت Cloudflare و اجرای دستورات SSH روی سرورها. روی **Cloudflare Workers** اجرا می‌شود و از چهار زبان فارسی، انگلیسی، چینی و روسی پشتیبانی می‌کند.

🔗 **GitHub**: [https://github.com/Raya-coder/3x-ui-bot](https://github.com/Raya-coder/3x-ui-bot)

---

## ✨ قابلیت‌های اصلی

### 🖥 مدیریت پنل 3x-ui
- **مدیریت کامل کاربران**: ساخت، حذف، تمدید، افزایش حجم، فعال/غیرفعال
- **مدیریت چند پنل**: اضافه/حذف پنل‌های متعدد به‌صورت داینامیک
- **پشتیبانی از 3x-ui v3.4.x**: هماهنگ با آخرین تغییرات API
- **کاربران آنلاین**: نمایش لیست کاربران آنلاین با IP
- **لاگ سرور**: مشاهده لاگ‌های پنل و Xray
- **بکاپ خودکار**: ارسال بکاپ به ادمین در بازه‌های زمانی مشخص
- **هشدار Xray**: هشدار در صورت کرش یا توقف Xray با ریستارت فوری
- **هشدار منابع**: هشدار CPU/RAM هنگام عبور از آستانه
- **هشدار حجم ۹۰٪**: هشدار خودکار وقتی مصرف کاربر به ۹۰٪ برسد
- **یادآوری انقضا**: یادآوری ۳ روز قبل از انقضا به خود کاربر
- **گزارش روزانه**: ارسال گزارش کامل وضعیت سرور و کاربران
- **QR Code اشتراک**: ارسال خودکار QR Code لینک اشتراک (auto-derive از تنظیمات پنل)
- **نوتیفیکیشن کاربر جدید**: اطلاع‌رسانی به ادمین‌ها هنگام ثبت‌نام کاربر جدید
- **نوار پیشرفت بصری**: نمایش گرافیکی درصد مصرف حجم

### ☁️ مدیریت Cloudflare
- **مدیریت DNS Records**: افزودن، حذف، ویرایش رکوردهای DNS
- **لیست دامنه‌ها**: مشاهده همه zones اکانت Cloudflare
- **پروکسی هوشمند**: فعال/غیرفعال‌کردن پروکسی Cloudflare با یک کلیک
- **پشتیبانی از همه نوع رکورد**: A, AAAA, CNAME, TXT, MX, NS, SRV, CAA
- **ویزارد ۵ مرحله‌ای**: ساخت رکورد جدید با راهنمای تعاملی

### 🖥️ ترمینال SSH (جدید!)
- **اجرای دستورات**: اجرای دستورات شل روی سرور از طریق تلگرام
- **دستورات سریع**: ۶ دستور آماده (System Info, Xray Status, Xray Logs, Network, Who, Top Processes)
- **SSH Bridge**: اسکریپت سبک `ssh-bridge.js` روی سرور اجرا می‌شود
- **امنیت**: محافظت با توکن، مسدودسازی دستورات خطرناک، timeout ۳۰ ثانیه
- **فقط سوپر ادمین**: دسترسی فقط برای سوپر ادمین

### 📊 نمودارها و آمار
- **نمودار مقایسه ترافیک**: مقایسه آپلود/دانلود بین پنل‌ها (Bar Chart)
- **نوار پیشرفت**: نمایش بصری درصد مصرف هر کاربر
- **آمار ادمین‌ها**: نمایش کاربران و ترافیک هر ادمین

### ⭐ پرداخت با Telegram Stars (جدید!)
- **مدیریت طرح‌ها**: سوپر ادمین طرح‌های پرداخت ایجاد می‌کند
- **خرید برای همه**: ادمین‌ها و کاربران عادی می‌توانند خرید کنند
- **پرداخت خودکار**: فاکتور تلگرام با currency=XTR
- **ثبت پرداخت‌ها**: سابقه کامل پرداخت‌ها
- **نوتیفیکیشن**: اطلاع‌رسانی پرداخت به سوپر ادمین‌ها

### 🌐 چندزبانه (جدید!)
- **۴ زبان**: فارسی، انگلیسی، چینی (中文)، روسی (Русский)
- **تغییر زباñ کامل**: همه منوها، دکمه‌ها و پیام‌ها به زبان انتخابی
- **انتخاب تعاملی**: دکمه «🌐 زبان» در همه منوها
- **ذخیره خودکار**: زبان هر کاربر/ادمین ذخیره می‌شود

### 👥 سیستم نقش‌ها
- **👑 سوپر ادمین**: دسترسی کامل به پنل 3x-ui + Cloudflare + SSH + مدیریت ادمین‌ها
- **🛠️ ادمین پنل**: فقط ساخت/تمدید/حذف کاربرانی که خودش ساخته
- **👤 کاربر عادی**: مشاهده مصرف، درخواست تمدید، خرید اشتراک با Stars

### 🔒 محدودیت‌های ادمین
- **maxUsers**: حداکثر تعداد کاربر قابل ساخت
- **maxTrafficGB**: حداکثر مجموع ترافیک قابل تخصیص (جدید!)
- **فیلتر کاربران**: ادمین فقط کاربرانی که خودش ساخته را می‌بیند

### 🔔 هشدارهای هوشمند
- **هشدار حجم ۹۰٪**: به ادمین‌ها هنگام رسیدن به ۹۰٪ حجم
- **یادآوری انقضا**: ۳ روز قبل از انقضا فقط به خود کاربر
- **هشدار منابع**: CPU/RAM بالای آستانه
- **هشدار Xray**: توقف یا کرش Xray
- **نوتیفیکیشن کاربر جدید**: به ادمین‌ها هنگام ثبت‌نام

---

## 📋 پیش‌نیازها

| نیازمندی | توضیح |
|----------|-------|
| اکانت Cloudflare | برای اجرای Worker + مدیریت DNS (اختیاری) |
| Wrangler CLI | ابزار استقرار (یا داشبورد Cloudflare) |
| Telegram Bot Token | از [@BotFather](https://t.me/BotFather) |
| پنل 3x-ui | نسخه v2.x یا v3.x (شامل v3.4.x) |
| توکن API 3x-ui | از Settings → API Tokens پنل |
| توکن API Cloudflare | اختیاری، برای مدیریت DNS |
| Node.js | برای اجرای SSH Bridge روی سرور (اختیاری) |

---

## 🚀 نصب و راه‌اندازی

### ۱. تنظیم wrangler.toml

```toml
name = "3xui-bot"
main = "3xui-bot-worker.js"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "BOT_KV"
id = "YOUR_BOT_KV_ID"

[[kv_namespaces]]
binding = "BOT_STATE"
id = "YOUR_BOT_STATE_ID"

[triggers]
crons = [
  "*/5 * * * *",    # Xray health check
  "*/10 * * * *",   # Resource alerts + Client alerts (90% volume + 3-day expiry)
  "0 9 * * *",      # Daily report
  "0 */6 * * *",    # Auto backup
  "*/30 * * * *",   # Renewal check
]
```

### ۲. ساخت KV Namespaces

```bash
wrangler kv:namespace create "BOT_KV"
wrangler kv:namespace create "BOT_STATE"
```

### ۳. تنظیم متغیرهای محیطی

```bash
# الزامی
wrangler secret put BOT_TOKEN
wrangler secret put SUPER_ADMINS

# اختیاری: Cloudflare DNS management
wrangler secret put CLOUDFLARE_API_TOKEN

# اختیاری: SSH bridge (برای همه پنل‌ها)
wrangler secret put SSH_BRIDGE_URL
wrangler secret put SSH_BRIDGE_TOKEN

# اختیاری: تنظیمات پنل
wrangler secret put PANELS_JSON
```

### ۴. استقرار و Webhook

```bash
wrangler deploy
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER>.workers.dev/webhook"
```

### ۵. ساخت اولین سوپر ادمین

اگر `SUPER_ADMINS` تنظیم نکرده‌اید: `/makeadmin` بزنید.

---

## 🖥️ راه‌اندازی SSH Terminal

### ۱. نصب SSH Bridge روی سرور

فایل `ssh-bridge.js` را روی سرور کپی کنید:

```bash
# کپی فایل به سرور
scp ssh-bridge.js root@your-server:/root/

# ورود به سرور
ssh root@your-server

# ویرایش توکن
nano ssh-bridge.js
# تغییر BRIDGE_TOKEN به یک رشته تصادفی

# اجرا
node ssh-bridge.js

# یا با pm2 برای اجرای دائمی
pm2 start ssh-bridge.js --name ssh-bridge
pm2 save
```

### ۲. تنظیم در ربات

**روش ۱: در PANELS_JSON:**
```json
{
  "panels": [{
    "id": "server1",
    "name": "سرور اصلی",
    "panelUrl": "https://your-panel.com:54321",
    "apiToken": "...",
    "sshBridgeUrl": "http://YOUR_SERVER_IP:8022",
    "sshBridgeToken": "YOUR_BRIDGE_TOKEN"
  }]
}
```

**روش ۲: با wrangler secret (برای همه پنل‌ها):**
```bash
wrangler secret put SSH_BRIDGE_URL    # http://YOUR_SERVER_IP:8022
wrangler secret put SSH_BRIDGE_TOKEN  # YOUR_BRIDGE_TOKEN
```

### ۳. استفاده

- `/ssh` بزنید یا دکمه **🖥️ ترمینال SSH** را در منو بزنید
- سرور را انتخاب کنید
- دستور را تایپ کنید یا از **دستورات سریع** استفاده کنید
- خروجی نمایش داده می‌شود

### امنیت SSH Bridge
- ✅ محافظت با توکن
- ✅ مسدودسازی دستورات خطرناک (rm -rf /, mkfs, shutdown, reboot)
- ✅ Timeout ۳۰ ثانیه
- ✅ فقط سوپر ادمین دسترسی دارد
- ⚠️ برای تولید، از HTTPS (nginx reverse proxy) استفاده کنید

---

## ☁️ راه‌اندازی Cloudflare DNS Management

### ۱. ساخت توکن API

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **My Profile** → **API Tokens**
2. **Create Token** → قالب **"Edit zone DNS"**
3. **Zone Resources** → **"All zones"**
4. توکن را کپی کنید

### ۲. تنظیم در Worker

```bash
wrangler secret put CLOUDFLARE_API_TOKEN
```

### ۳. استفاده

`/start` → منوی دوگانه: **🖥 پنل 3x-ui** | **☁️ Cloudflare**

---

## ⭐ راه‌اندازی پرداخت Stars

### ۱. سوپر ادمین: ساخت طرح

```
/stars
→ ➕ افزودن طرح
→ نام: اشتراک ماهانه
→ Stars: 100
→ توضیحات: 30 روز + 50GB
```

### ۲. کاربر/ادمین: خرید

دکمه **⭐ خرید اشتراک** یا **⭐ خرید اعتبار** را بزنید → طرح را انتخاب کنید → با Stars پرداخت کنید.

---

## 🌐 تغییر زبان

دکمه **🌐 زبان** را در هر منویی بزنید یا:

```
/lang fa  — فارسی
/lang en  — English
/lang zh  — 中文
/lang ru  — Русский
```

زبان انتخابی ذخیره می‌شود و کل ربات به آن زبان تغییر می‌کند.

---

## 🎮 دستورات

### 👑 سوپر ادمین — 3x-ui

| دستور | توضیح |
|-------|-------|
| `/admin` | پنل مدیریت (منوی کامل) |
| `/search` `/user` `/create` `/delete` `/enable` `/disable` `/addgb` `/renew` `/link` `/clients` | مدیریت کاربران |
| `/status [پنل]` | وضعیت سرور |
| `/online` | کاربران آنلاین |
| `/versions` | نسخه پنل و Xray |
| `/xray_restart` `/xray_stop` `/xray_update` | مدیریت Xray |
| `/report` | گزارش روزانه |
| `/backup [پنل]` | دریافت بکاپ |
| `/paneltest` | تست اتصال endpoint‌ها |

### 👑 سوپر ادمین — Cloudflare

| دستور | توضیح |
|-------|-------|
| `/cf` | باز کردن منوی Cloudflare |

### 👑 سوپر ادمین — SSH

| دستور | توضیح |
|-------|-------|
| `/ssh` | باز کردن ترمینال SSH |

### 👑 سوپر ادمین — آمار و پرداخت

| دستور | توضیح |
|-------|-------|
| `/chart` | نمودار مقایسه ترافیک پنل‌ها |
| `/stars` | مدیریت طرح‌های Stars (سوپر) / خرید (بقیه) |

### 👑 سوپر ادمین — مدیریت

| دستور | توضیح |
|-------|-------|
| `/addpanel` | افزودن پنل |
| `/addadmin <chatId> <panelIds> [maxUsers] [maxTrafficGB]` | افزودن ادمین پنل |
| `/removeadmin <chatId>` | حذف ادمین |
| `/admins` | لیست ادمین‌ها (با آمار ترافیک) |
| `/ban` `/unban` `/suspend` `/unsuspend` `/bannedlist` | بن و تعلیق |

### 🌐 همه کاربران

| دستور | توضیح |
|-------|-------|
| `/lang <fa\|en\|zh\|ru>` | تغییر زبان |
| `/stars` | خرید اشتراک با Stars |
| `/help` | راهنما |

---

## 🔧 سیستم نقش‌ها

### 👑 سوپر ادمین
- دسترسی کامل به 3x-ui + Cloudflare + SSH + Stars management
- مدیریت ادمین‌ها با maxUsers و maxTrafficGB
- بن/تعلیق کاربران
- هشدارها و بکاپ‌ها

### 🛠️ ادمین پنل
- فقط ساخت/تمدید/حذف کاربرانی که خودش ساخته
- محدودیت maxUsers + maxTrafficGB
- خرید اعتبار با Stars
- تغییر زبان

### 👤 کاربر عادی
- مشاهده مصرف با نوار پیشرفت بصری
- درخواست تمدید
- خرید اشتراک با Stars
- تغییر زبان
- یادآوری انقضا (فقط به خودش)

---

## 🏗️ معماری

### سازگاری با 3x-ui

| نسخه | وضعیت |
|------|-------|
| v2.x | ✅ پشتیبانی کامل |
| v3.x | ✅ پشتیبانی کامل |
| v3.4.x | ✅ پشتیبانی کامل |

### KV Keys

| کلید | توضیح |
|------|-------|
| `user:<chatId>` | کاربر ثبت‌نام شده |
| `panels:config` | تنظیمات پنل‌ها |
| `admin:role:<chatId>` | نقش ادمین (شامل maxTrafficGB) |
| `stars:plans` | طرح‌های پرداخت Stars |
| `stars:payments` | سابقه پرداخت‌ها |
| `volwarn:<panelId>:<email>` | حالت هشدار حجم ۹۰٪ |
| `expwarn:<panelId>:<email>` | حالت هشدار انقضا |
| `subcfg:<panelId>` | کش تنظیمات subscription |
| `lang:<chatId>` | زبان ادمین (بدون ثبت‌نام) |

---

## 📝 Changelog

### v4.0 (آخرین تغییرات)
- ✅ اضافه شد: ترمینال SSH با bridge service (`ssh-bridge.js`)
- ✅ اضافه شد: چندزبانه کامل (fa/en/zh/ru) — همه منوها و دکمه‌ها
- ✅ اضافه شد: پرداخت Stars برای کاربران عادی (نه فقط ادمین‌ها)
- ✅ اضافه شد: محدودیت maxTrafficGB برای ادمین‌ها
- ✅ اضافه شد: هشدار حجم ۹۰٪
- ✅ اضافه شد: یادآوری انقضا ۳ روز قبل (فقط به کاربر)
- ✅ اضافه شد: نوتیفیکاشن کاربر جدید به ادمین‌ها
- ✅ اضافه شد: نوار پیشرفت بصری در جزئیات کاربر
- ✅ اضافه شد: دکمه GitHub در همه منوها
- ✅ اضافه شد: نمودار مقایسه ترافیک پنل‌ها
- ✅ بهبود: i18n کامل برای همه منوها

### v3.0
- ماژول مدیریت Cloudflare DNS
- منوی دوگانه برای سوپر ادمین
- پشتیبانی از 3x-ui v3.4.x
- /paneltest برای عیب‌یابی
- همه دکمه‌های تعاملی
- maxUsers + auto-derive sub link
- رفع باگ‌های متعدد

### v2.0
- سیستم نقش‌ها
- مدیریت چند پنل
- درخواست تمدید
- بکاپ خودکار
- هشدار Xray و منابع

### v1.0
- ربات پایه مدیریت 3x-ui
