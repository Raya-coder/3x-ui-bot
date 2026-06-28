# 3X-UI Telegram Bot — Cloudflare Worker v2.0

## قابلیت‌های جدید

### ✅ قابلیت‌های درخواستی
1. **مشاهده مصرف توسط کاربر غیر ادمین** — کاربران با `/start` ثبت‌نام کرده و با `/usage` مصرف خود را می‌بینند
2. **مدیریت Nodes توسط ادمین** — افزودن/حذف پنل با `/addpanel` و `/dellpanel`
3. **هماهنگی با آخرین نسخه 3x-ui** — پشتیبانی از API نسخه v2.x و v3.x
4. **مدیریت چند پنل** — اضافه کردن و مدیریت پنل‌های متعدد به صورت داینامیک
5. **درخواست تمدید از سمت کاربر** — با `/renew` و تایید فوری توسط ادمین
6. **بکاپ خودکار** — ارسال بکاپ خودکار به ادمین در بازه‌های زمانی مشخص
7. **هشدار Xray** — هشدار در صورت کرش یا توقف Xray با امکان ریستارت فوری

### 🆕 قابلیت‌های اضافه شده
- **گزارش روزانه** — ارسال گزارش کامل وضعیت سرور و کاربران
- **هشدار منابع** — هشدار CPU/RAM هنگام عبور از آستانه
- **API HTTP** — اندپوینت `/api/usage?email=xxx` برای دریافت مصرف به صورت API
- **خروجی تنظیمات** — `/export` برای صادر کردن کانفیگ پنل‌ها
- **QR Code اشتراک** — ارسال QR Code لینک اشتراک
- **تشخیص خودکار نسخه API** — تلاش خودکار مسیرهای مختلف API

---

## نصب و راه‌اندازی

### ۱. پیش‌نیازها
- اکانت Cloudflare
- Wrangler CLI نصب شده
- یک Telegram Bot Token (از @BotFather)

### ۲. تنظیم wrangler.toml

```toml
name = "3xui-bot"
main = "3xui-bot-worker.js"
compatibility_date = "2024-01-01"

# KV Namespace برای ذخیره‌سازی
[[kv_namespaces]]
binding = "BOT_KV"
id = "YOUR_KV_NAMESPACE_ID"

# Cron Triggers
[triggers]
crons = [
  "*/5 * * * *",    # Xray health check - هر 5 دقیقه
  "*/10 * * * *",   # Resource alerts - هر 10 دقیقه
  "0 9 * * *",      # Daily report - هر روز ساعت 9
  "0 */6 * * *",    # Auto backup - هر 6 ساعت
  "*/30 * * * *",   # Renewal check - هر 30 دقیقه
]
```

### ۳. تنظیم متغیرهای محیطی

```bash
# Telegram Bot Token
wrangler secret put BOT_TOKEN

# تنظیمات پنل‌ها (JSON)
wrangler secret put PANELS_JSON
```

### مثال PANELS_JSON:

```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "adminChatIds": ["123456789"],
  "alertChatIds": ["123456789"],
  "alertCooldownMinutes": 60,
  "cpuRamAlertThreshold": 80,
  "backupIntervalHours": 24,
  "dailyReportEnabled": true,
  "panels": [
    {
      "id": "server1",
      "name": "سرور آلمان",
      "panelUrl": "https://de.example.com:54321",
      "apiToken": "YOUR_API_TOKEN",
      "inboundIds": [1, 2, 3],
      "subBaseUrl": "https://sub.example.com",
      "subPath": "sub",
      "authType": "bearer"
    },
    {
      "id": "server2",
      "name": "سرور هلند",
      "panelUrl": "https://nl.example.com:54321",
      "apiToken": "YOUR_API_TOKEN_2",
      "authType": "bearer"
    }
  ]
}
```

### ۴. تنظیم Webhook

```bash
# Deploy
wrangler deploy

# Set webhook
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER>.workers.dev/webhook"
```

### ۵. ساخت KV Namespace

```bash
wrangler kv:namespace create "BOT_KV"
# سپس ID دریافتی را در wrangler.toml قرار دهید
```

---

## دستورات

### 👤 دستورات کاربر
| دستور | توضیح |
|--------|--------|
| `/start` | شروع و ثبت‌نام |
| `/usage` | مشاهده مصرف |
| `/renew <days> [gb]` | درخواست تمدید |
| `/help` | راهنما |

### 🛠️ دستورات ادمین
| دستور | توضیح |
|--------|--------|
| `/admin` | پنل مدیریت |
| `/status [panelId]` | وضعیت سرور |
| `/panels` | لیست پنل‌ها |
| `/addpanel` | افزودن پنل جدید |
| `/dellpanel <id>` | حذف پنل |
| `/adduser <email> <days> <gb> [panelId]` | افزودن کاربر |
| `/users [page]` | لیست کاربران |
| `/backup [panelId]` | دریافت بکاپ |
| `/renewals` | درخواست‌های تمدید معلق |
| `/report` | گزارش روزانه |
| `/export` | خروجی تنظیمات |

---

## API HTTP

### دریافت مصرف کاربر

```
GET /api/usage?email=user@example.com&panel=server1
```

پاسخ:
```json
{
  "email": "user@example.com",
  "enabled": true,
  "expired": false,
  "upload": 1073741824,
  "download": 2147483648,
  "totalUsed": 3221225472,
  "totalLimit": 107374182400,
  "remaining": 104153956992,
  "expiryTime": 1735689600000,
  "uploadGB": "1.00 GB",
  "downloadGB": "2.00 GB",
  "totalUsedGB": "3.00 GB",
  "totalLimitGB": "100.00 GB"
}
```

### Health Check

```
GET /health
```

پاسخ:
```json
{
  "status": "ok",
  "version": "2.0.0"
}
```

---

## معماری

### ذخیره‌سازی (KV)
- `user:<chatId>` — اطلاعات کاربر ثبت‌نام شده
- `panels:config` — تنظیمات پنل‌ها (داینامیک)
- `renewal:<id>` — درخواست‌های تمدید
- `alert:xray:<panelId>` — وضعیت هشدار Xray
- `alert:resource:<panelId>` — وضعیت هشدار منابع
- `backup:<panelId>` — زمان آخرین بکاپ

### ساختار ماژولار
1. **Constants** — ثابت‌ها و تنظیمات پیش‌فرض
2. **KV Helpers** — عملیات ذخیره‌سازی
3. **User Management** — ثبت‌نام و مدیریت کاربران
4. **Renewal System** — سیستم تمدید
5. **Panel Config** — مدیریت پنل‌ها
6. **Telegram API** — ارتباط با تلگرام
7. **Panel API** — ارتباط با 3x-ui
8. **Client Operations** — عملیات کاربران 3x-ui
9. **Health Monitoring** — نظارت بر سلامت Xray و منابع
10. **Command Handlers** — پردازش دستورات
