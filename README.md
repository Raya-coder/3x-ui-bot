# 🤖 3x-UI Telegram Bot

ربات تلگرام مدیریت پنل 3x-UI، Cloudflare و SSH  
نسخه کامل چندزبانه با پشتیبانی از Telegram Stars

---

## 🌟 معرفی

این ربات یک پنل مدیریتی کامل برای:
- 3x-ui (مدیریت کاربران و سرورها)
- Cloudflare (DNS Management)
- SSH Terminal (اجرای دستورات)
- پرداخت با Telegram Stars
- چندزبانگی (FA / EN / ZH / RU)

اجرا روی Cloudflare Workers

---

## ✨ قابلیت‌ها

### 🖥 مدیریت 3x-ui
- ساخت، حذف، تمدید و افزایش حجم کاربران
- پشتیبانی از نسخه‌های v2.x / v3.x / v3.4.x
- کاربران آنلاین و IP
- لاگ Xray
- بکاپ خودکار
- هشدار منابع
- QR Code اشتراک
- نمودار مصرف

---

### ☁️ مدیریت Cloudflare
- DNS CRUD
- Zone management
- Proxy toggle
- Record wizard
- A / AAAA / CNAME / TXT / MX / NS / SRV / CAA

---

### 🖥 SSH Terminal
- اجرای دستورات روی سرور
- دکمه‌های تعاملی
- تشخیص context
- دستورات سریع

---

### ⭐ Telegram Stars
- خرید اشتراک
- مدیریت پلن‌ها
- ثبت پرداخت‌ها

---

### 🌐 چندزبانه
- فارسی / English / 中文 / Русский
- ذخیره زبان کاربر

---

### 🔔 هشدارها
- مصرف 90٪
- انقضا 3 روز قبل
- CPU / RAM
- توقف Xray

---

### 👥 نقش‌ها

#### 👑 سوپر ادمین
- دسترسی کامل

#### 🛠 ادمین
- مدیریت کاربران خودش

#### 👤 کاربر
- مشاهده مصرف و خرید

---

## 🚀 نصب سریع

git clone https://github.com/Raya-coder/3x-ui-bot.git
cd 3x-ui-bot

wrangler kv:namespace create "BOT_KV"
wrangler kv:namespace create "BOT_STATE"

wrangler secret put BOT_TOKEN
wrangler secret put SUPER_ADMINS

wrangler deploy

---

## 🏗 معماری

Telegram → Cloudflare Worker → 3x-ui / Cloudflare / SSH

---

## 📜 لایسنس

MIT
