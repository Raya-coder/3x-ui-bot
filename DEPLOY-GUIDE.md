# 🚀 راهنمای استقرار 3X-UI Bot — Cloudflare Worker v4.0

راهنمای کامل نصب ربات مدیریت 3x-ui، Cloudflare و SSH روی Cloudflare Worker — به دو روش: با Wrangler CLI یا از داشبورد Cloudflare.

---

## 📋 فهرست

- [روش ۱: استقرار با Wrangler CLI](#روش-۱-استقرار-با-wrangler-cli)
- [روش ۲: استقرار از داشبورد Cloudflare](#روش-۲-استقرار-از-داشبورد-cloudflare)
- [تنظیم Webhook تلگرام](#تنظیم-webhook-تلگرام)
- [ساخت اولین سوپر ادمین](#ساخت-اولین-سوپر-ادمین)
- [راه‌اندازی SSH Terminal](#راه‌اندازی-ssh-terminal)
- [تنظیم Cloudflare DNS Management](#تنظیم-cloudflare-dns-management)
- [راه‌اندازی پرداخت Stars](#راه‌اندازی-پرداخت-stars)
- [تغییر زبان](#تغییر-زبان)
- [مدیریت نقش‌ها و محدودیت‌ها](#مدیریت-نقش‌ها-و-محدودیت‌ها)
- [عیب‌یابی](#عیب‌یابی)

---

## روش ۱: استقرار با Wrangler CLI

### قدم ۱: نصب Wrangler

```bash
npm install -g wrangler
wrangler login
```

### قدم ۲: ساخت KV Namespaces

```bash
wrangler kv:namespace create "BOT_KV"
wrangler kv:namespace create "BOT_STATE"
```

### قدم ۳: ساخت wrangler.toml

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
  "*/10 * * * *",   # Resource + Client alerts (90% volume + 3-day expiry)
  "0 9 * * *",      # Daily report
  "0 */6 * * *",    # Auto backup
  "*/30 * * * *",   # Renewal check
]
```

### قدم ۴: تنظیم Secrets

```bash
# الزامی
wrangler secret put BOT_TOKEN
wrangler secret put SUPER_ADMINS          # مثال: 123456789,987654321

# اختیاری: Cloudflare DNS management
wrangler secret put CLOUDFLARE_API_TOKEN

# اختیاری: SSH bridge (برای همه پنل‌ها)
wrangler secret put SSH_BRIDGE_URL        # مثال: http://YOUR_SERVER:8022
wrangler secret put SSH_BRIDGE_TOKEN

# اختیاری: تنظیمات پنل
wrangler secret put PANELS_JSON
```

### قدم ۵: استقرار

```bash
wrangler deploy
```

---

## روش ۲: استقرار از داشبورد Cloudflare

### قدم ۱: ساخت KV Namespaces

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **KV**
2. **Create a namespace** → نام `BOT_KV` → **Create**
3. دوباره: نام `BOT_STATE` → **Create**

### قدم ۲: ساخت Worker

1. **Workers & Pages** → **Create** → **Create Worker**
2. نام: `3xui-bot` → **Deploy**
3. روی **Edit Code** کلیک کنید
4. کل کد `3xui-bot-worker.js` را کپی و پیست کنید
5. **Deploy**

### قدم ۳: اتصال KV Namespaces

**Settings** → **Bindings** → **Add**:
1. KV Namespace → Variable name: `BOT_KV` → انتخاب namespace `BOT_KV` → Save
2. KV Namespace → Variable name: `BOT_STATE` → انتخاب namespace `BOT_STATE` → Save

### قدم ۴: تنظیم متغیرهای محیطی

**Settings** → **Environment Variables**:

| Variable | Type | مقدار |
|----------|------|-------|
| `BOT_TOKEN` | Encrypt | توکن ربات از @BotFather |
| `SUPER_ADMINS` | Encrypt | آیدی تلگرام سوپر ادمین‌ها (با کاما) |
| `CLOUDFLARE_API_TOKEN` | Encrypt | توکن Cloudflare (اختیاری) |
| `SSH_BRIDGE_URL` | Text | `http://YOUR_SERVER:8022` (اختیاری) |
| `SSH_BRIDGE_TOKEN` | Encrypt | توکن SSH bridge (اختیاری) |
| `SUPPORT_USERNAME` | Text | آیدی پشتیبانی (اختیاری) |
| `PANELS_JSON` | Encrypt | JSON تنظیمات پنل (اختیاری) |

### قدم ۵: تنظیم Cron Triggers

**Settings** → **Triggers** → **Cron Triggers**:

| Cron | توضیح |
|------|--------|
| `*/5 * * * *` | بررسی وضعیت Xray |
| `*/10 * * * *` | هشدار CPU/RAM + هشدار حجم ۹۰٪ + یادآوری انقضا |
| `0 9 * * *` | گزارش روزانه |
| `0 */6 * * *` | بکاپ خودکار |
| `*/30 * * * *` | بررسی درخواست‌های تمدید |

---

## تنظیم Webhook تلگرام

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://3xui-bot.your-username.workers.dev/webhook"
```

پاسخ `{"ok":true}` = موفق ✅

---

## ساخت اولین سوپر ادمین

**اگر `SUPER_ADMINS` تنظیم کرده‌اید**: خودکار شناخته می‌شوید.

**اگر نه**:
1. `/start` بزنید
2. `/makeadmin` بفرستید (فقط اولین بار)
3. `/admin` بزنید

Chat ID از [@userinfobot](https://t.me/userinfobot).

---

## راه‌اندازی SSH Terminal

### ۱. نصب SSH Bridge روی سرور

```bash
# فایل ssh-bridge.js را روی سرور کپی کنید
scp ssh-bridge.js root@your-server:/root/

# ورود به سرور
ssh root@your-server

# ویرایش توکن (ضروری!)
nano /root/ssh-bridge.js
# خط زیر را پیدا و تغییر دهید:
# const BRIDGE_TOKEN = "CHANGE_ME_TO_A_RANDOM_SECRET";

# اجرا
node /root/ssh-bridge.js

# یا با pm2 برای اجرای دائمی
pm2 start /root/ssh-bridge.js --name ssh-bridge
pm2 save
pm2 startup
```

### ۲. تنظیم در ربات

**روش ۱: در PANELS_JSON:**
```json
{
  "panels": [{
    "id": "server1",
    "name": "سرور اصلی",
    "panelUrl": "https://your-panel.com:54321",
    "apiToken": "your-api-token",
    "sshBridgeUrl": "http://YOUR_SERVER_IP:8022",
    "sshBridgeToken": "YOUR_BRIDGE_TOKEN"
  }]
}
```

**روش ۲: با wrangler secret:**
```bash
wrangler secret put SSH_BRIDGE_URL
wrangler secret put SSH_BRIDGE_TOKEN
```

### ۳. استفاده

1. `/ssh` بزنید یا دکمه **🖥️ ترمینال SSH** را بزنید
2. سرور را انتخاب کنید
3. دستور را تایپ کنید یا از **📋 دستورات سریع** استفاده کنید:
   - 📊 System Info
   - 🔄 Xray Status
   - 📋 Xray Logs
   - 🌐 Network
   - 👥 Who
   - 📦 Top Processes

### امنیت SSH Bridge

- ✅ محافظت با توکن
- ✅ مسدودسازی دستورات خطرناک (rm -rf /, mkfs, dd, shutdown, reboot, halt)
- ✅ Timeout ۳۰ ثانیه
- ✅ فقط سوپر ادمین دسترسی دارد
- ⚠️ برای تولید، از nginx reverse proxy با HTTPS استفاده کنید

---

## تنظیم Cloudflare DNS Management

### ۱. ساخت توکن

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **My Profile** → **API Tokens**
2. **Create Token** → **"Edit zone DNS"** template
3. **Zone Resources** → **"All zones"**
4. توکن را کپی کنید

### ۲. تنظیم در Worker

```bash
wrangler secret put CLOUDFLARE_API_TOKEN
```

### ۳. استفاده

`/start` → منوی دوگانه: **🖥 پنل 3x-ui** | **☁️ Cloudflare** → **☁️ Cloudflare**

امکانات: لیست دامنه‌ها، افزودن/حذف DNS record، toggle پروکسی

---

## راه‌اندازی پرداخت Stars

### ۱. سوپر ادمین: ساخت طرح پرداخت

```
/stars
→ ➕ افزودن طرح
→ نام طرح: اشتراک ماهانه
→ تعداد Stars: 100
→ توضیحات: 30 روز + 50GB
```

### ۲. کاربران/ادمین‌ها: خرید

دکمه **⭐ خرید اشتراک** (کاربران) یا **⭐ خرید اعتبار** (ادمین‌ها) → انتخاب طرح → پرداخت با Stars

### ۳. مشاهده پرداخت‌ها

```
/stars → 📋 لیست پرداخت‌ها
```

---

## تغییر زبان

دکمه **🌐 زبان** را در هر منویی بزنید یا:

```
/lang fa  — فارسی
/lang en  — English
/lang zh  — 中文
/lang ru  — Русский
```

زبان انتخابی ذخیره می‌شود و کل ربات (منوها، دکمه‌ها، پیام‌ها) به آن زبان تغییر می‌کند.

---

## مدیریت نقش‌ها و محدودیت‌ها

### افزودن ادمین پنل با محدودیت

```bash
# فرمت: /addadmin <chatId> <panelIds> [maxUsers] [maxTrafficGB]
/addadmin 123456789 US,DE 50 1000
# حداکثر ۵۰ کاربر، حداکثر ۱۰۰۰ GB ترافیک
```

### مشاهده لیست ادمین‌ها

```
/admins
```

خروجی:
```
👥 ادمین‌ها (2):

👑 123456789 — سوپر
🛠️ 987654321 — پنل
   👤 12 کاربر/50 | 📦 234.5 GB/1000
```

### سطوح دسترسی

| قابلیت | سوپر ادمین | ادمین پنل | کاربر |
|--------|-----------|----------|-------|
| مدیریت کاربران (همه) | ✅ | ❌ | ❌ |
| مدیریت کاربران (خودش) | ✅ | ✅ | ❌ |
| تنظیمات پنل | ✅ | ❌ | ❌ |
| Cloudflare DNS | ✅ | ❌ | ❌ |
| SSH Terminal | ✅ | ❌ | ❌ |
| مدیریت ادمین‌ها | ✅ | ❌ | ❌ |
| بن/تعلیق | ✅ | ❌ | ❌ |
| Stars management | ✅ | ❌ | ❌ |
| خرید Stars | ✅ | ✅ | ✅ |
| تغییر زبان | ✅ | ✅ | ✅ |
| مشاهده مصرف | ✅ | ✅ | ✅ |

---

## 📋 دستورات کامل

### 👤 کاربر عادی

| دستور | توضیح |
|-------|-------|
| `/start` | شروع / ثبت‌نام |
| `/usage` | مشاهده مصرف |
| `/renew` | درخواست تمدید |
| `/lang <fa\|en\|zh\|ru>` | تغییر زبان |
| `/stars` | خرید اشتراک با Stars |
| `/help` | راهنما |

### 🛠️ ادمین پنل

| دستور | توضیح |
|-------|-------|
| `/admin` | پنل مدیریت (محدود) |
| `/create` `/delete` `/addgb` `/renew` `/search` `/user` `/link` `/clients` | مدیریت کاربران (فقط خودش) |
| `/stars` | خرید اعتبار |

### 👑 سوپر ادمین

| دستور | توضیح |
|-------|-------|
| `/ssh` | ترمینال SSH |
| `/cf` | مدیریت Cloudflare |
| `/chart` | نمودار ترافیک |
| `/stars` | مدیریت Stars |
| `/paneltest` | تست endpoint‌ها |
| `/status` `/online` `/versions` `/report` `/backup` | مدیریت سرور |
| `/addpanel` `/dellpanel` `/panels` | مدیریت پنل‌ها |
| `/addadmin <chatId> <panelIds> [maxUsers] [maxTrafficGB]` | افزودن ادمین |
| `/removeadmin <chatId>` | حذف ادمین |
| `/admins` | لیست ادمین‌ها |
| `/ban` `/unban` `/suspend` `/unsuspend` `/bannedlist` | بن و تعلیق |

---

## عیب‌یابی

### ربات جواب نمی‌دهد
1. Webhook: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
2. KV bindings چک کنید
3. `BOT_TOKEN` چک کنید
4. Logs در Cloudflare Dashboard → Worker → **Logs**

### SSH کار نمی‌کند
- `ssh-bridge.js` روی سرور در حال اجرا است؟ (`pm2 status`)
- `BRIDGE_TOKEN` در سرور و ربات یکی است؟
- پورت 8022 در فایروال باز است؟ (`ufw allow 8022`)
- از سرور تست کنید: `curl -X POST http://localhost:8022 -H "Content-Type: application/json" -d '{"token":"YOUR_TOKEN","command":"whoami"}'`

### Cloudflare کار نمی‌کند
- `CLOUDFLARE_API_TOKEN` تنظیم شده؟
- توکن دسترسی `Zone:Read` و `DNS:Edit` دارد؟

### دکمه‌ها ارور 400 می‌دهند
- این مشکل با callback_data طولانی رفع شده (act: tokens)
- اگر باز هم رخ داد، `/paneltest` بزنید

### زبان تغییر نمی‌کند
- دکمه **🌐 زبان** را بزنید (نه دستور `/lang`)
- زبان در KV ذخیره می‌شود — بعد از تغییر، منو بازسازی می‌شود

### محدودیت maxTrafficGB کار نمی‌کند
- `/admins` بزنید — `maxTrafficGB` باید > 0 باشد
- شمارش از کلاینت‌های پنل با `comment: TG:<chatId>` است

### کاربران آنلاین ۰ است
- `/paneltest` بزنید
- نسخه 3x-ui را آپدیت کنید

---

## 📋 اطلاعات KV

| کلید | توضیح |
|------|--------|
| `user:<chatId>` | کاربر ثبت‌نام شده |
| `userbackup:<chatId>` | بکاپ کاربر |
| `panels:config` | تنظیمات پنل‌ها |
| `admin:ids` | لیست ادمین‌ها |
| `admin:role:<chatId>` | نقش ادمین (با maxTrafficGB) |
| `banned:<chatId>` | کاربر بن شده |
| `suspended:<chatId>` | کاربر تعلیق شده |
| `renewal:<id>` | درخواست تمدید |
| `error:<id>` | لاگ خطا |
| `stars:plans` | طرح‌های Stars |
| `stars:payments` | سابقه پرداخت‌ها |
| `volwarn:<panelId>:<email>` | هشدار حجم ۹۰٪ |
| `expwarn:<panelId>:<email>` | هشدار انقضا |
| `subcfg:<panelId>` | کش تنظیمات subscription |
| `lang:<chatId>` | زبان ادمین |

---

## 🔄 آپدیت ربات

1. کد جدید `3xui-bot-worker.js` را جایگزین کنید
2. `wrangler deploy` (یا Deploy در داشبورد)
3. نیازی به تنظیم مجدد متغیرها نیست

---

## 💡 نکات

- **هزینه**: Cloudflare Workers رایگان تا ۱۰۰K درخواست/روز
- **KV**: رایگان تا ۱۰۰K خواندن و ۱K نوشتن/روز
- **SSH Bridge**: Node.js 18+ روی سرور کافی است
- **Stars**: ربات‌های تلگرام به‌صورت پیش‌فرض از Stars پشتیبانی می‌کنند
- **زبان**: پیش‌فرض فارسی، با `/lang` قابل تغییر
- **دکمه‌های تعاملی**: همه پیام‌ها دکمه برگشت دارند
- **Method-swap**: اگر GET کار نکرد، خودکار POST امتحان می‌کند
- **Auto-derive sub link**: اگر `subBaseUrl` تنظیم نشده، از تنظیمات پنل استخراج می‌شود

---

## 🆘 پشتیبانی

1. `/paneltest` بزنید
2. **📋 لاگ خطاها** را در منوی ادمین چک کنید
3. `getWebhookInfo` را چک کنید
4. [GitHub](https://github.com/Raya-coder/3x-ui-bot) — Issues
