🤖 3x-UI Telegram Bot
ربات تلگرام مدیریت پنل 3x-UI، Cloudflare و SSH — نسخه کامل چندزبانه با پرداخت Telegram Stars

GitHubCloudflare Workers3x-ui v3.4.x4 Languages

رباتی قدرتمند و کاربرپسند برای مدیریت 3x-UI، اکانت Cloudflare و اجرای دستورات SSH — همه از طریق تلگرام روی Cloudflare Workers. با پشتیبانی از ۴ زبان (فارسی، انگلیسی، چینی، روسی) و پرداخت داخلی با Telegram Stars.

🌟 قابلیت‌ها
🖥 مدیریت پنل 3x-ui
✅ مدیریت کامل کاربران (ساخت، حذف، تمدید، افزایش حجم، فعال/غیرفعال)
✅ پشتیبانی از 3x-ui v2.x، v3.x و v3.4.x (با method-swap خودکار)
✅ مدیریت چند پنل به‌صورت داینامیک
✅ کاربران آنلاین با IP
✅ لاگ سرور و Xray
✅ بکاپ خودکار
✅ هشدار Xray و منابع (CPU/RAM)
✅ گزارش روزانه
✅ QR Code اشتراک (auto-derive از تنظیمات پنل)
✅ نوار پیشرفت بصری مصرف
✅ /paneltest برای عیب‌یابی endpoint‌ها
☁️ مدیریت Cloudflare
✅ مدیریت کامل DNS Records (CRUD)
✅ لیست دامنه‌ها (Zones)
✅ فعال/غیرفعال‌کردن پروکسی با یک کلیک
✅ ویزارد ۵ مرحله‌ای ساخت رکورد
✅ پشتیبانی از A, AAAA, CNAME, TXT, MX, NS, SRV, CAA
🖥️ ترمینال SSH تعاملی
✅ اجرای دستورات شل روی سرور
✅ تشخیص context — وقتی apt upgrade دیالوگ نشان می‌دهد، دکمه‌های OK/Cancel نمایش داده می‌شود
✅ دکمه‌های تعاملی: Enter, Y, N, Ctrl+C, Esc, Tab
✅ دستورات سریع (System Info, Xray Status, Xray Logs, Network, Who, Top)
✅ Session management برای دستورات چندمرحله‌ای
✅ مسدودسازی دستورات خطرناک
✅ فقط سوپر ادمین
📊 نمودارها و آمار
✅ نمودار مقایسه ترافیک بین پنل‌ها (Bar Chart)
✅ نوار پیشرفت بصری در جزئیات کاربر
✅ آمار ادمین‌ها (کاربران + ترافیک)
⭐ پرداخت با Telegram Stars
✅ سوپر ادمین: ساخت و مدیریت طرح‌های پرداخت
✅ ادمین‌ها و کاربران عادی: خرید با Stars
✅ فاکتور خودکار تلگرام (currency=XTR)
✅ ثبت سابقه پرداخت‌ها
✅ نوتیفیکیشن پرداخت به سوپر ادمین‌ها
🌐 چندزبانه (۴ زبان)
✅ فارسی 🇮🇷
✅ English 🇬🇧
✅ 中文 🇨🇳
✅ Русский 🇷🇺
✅ تغییر زبان کامل (منوها، دکمه‌ها، پیام‌ها)
✅ ذخیره خودکار زبان هر کاربر
🔔 هشدارهای هوشمند
✅ هشدار حجم ۹۰٪ (به ادمین‌ها)
✅ یادآوری انقضا ۳ روز قبل (فقط به کاربر)
✅ هشدار CPU/RAM
✅ هشدار توقف Xray
✅ نوتیفیکیشن کاربر جدید (به ادمین‌ها)
👥 سیستم نقش‌ها
👑 سوپر ادمین: دسترسی کامل (3x-ui + Cloudflare + SSH + Stars + مدیریت ادمین‌ها)
🛠️ ادمین پنل: فقط ساخت/تمدید/حذف کاربرانی که خودش ساخته
👤 کاربر عادی: مشاهده مصرف، درخواست تمدید، خرید Stars
🔒 محدودیت‌های ادمین
✅ maxUsers — حداکثر تعداد کاربر
✅ maxTrafficGB — حداکثر مجموع ترافیک
✅ فیلتر کاربران (ادمین فقط کاربران خودش را می‌بیند)
✨ تجربه کاربری
✅ همه دکمه‌های تعاملی (هیچ‌گاه گیر نمی‌کنید)
✅ دکمه برگشت در همه پیام‌ها
✅ منوی دوگانه برای سوپر ادمین (3x-ui / Cloudflare)
✅ دکمه زبان و GitHub در همه منوها
✅ دکمه پشتیبانی (اختیاری)
📋 پیش‌نیازها
نیازمندی	توضیح
Cloudflare Account	برای اجرای Worker
Wrangler CLI یا Dashboard	استقرار
Telegram Bot Token	از @BotFather
3x-ui Panel	v2.x یا v3.x (شامل v3.4.x)
Cloudflare API Token	اختیاری — برای DNS management
Node.js	اختیاری — برای SSH bridge
🚀 نصب سریع
# ۱. کلون مخزنgit clone https://github.com/Raya-coder/3x-ui-bot.gitcd 3x-ui-bot# ۲. ساخت KV Namespaceswrangler kv:namespace create "BOT_KV"wrangler kv:namespace create "BOT_STATE"# ۳. تنظیم wrangler.toml (با ID های دریافتی)# ۴. تنظیم Secretswrangler secret put BOT_TOKENwrangler secret put SUPER_ADMINS          # 123456789,987654321wrangler secret put CLOUDFLARE_API_TOKEN  # اختیاریwrangler secret put SSH_BRIDGE_URL        # اختیاریwrangler secret put SSH_BRIDGE_TOKEN      # اختیاری# ۵. استقرارwrangler deploy# ۶. تنظیم Webhookcurl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER>.workers.dev/webhook"# ۷. ساخت اولین سوپر ادمین# در تلگرام: /start → /makeadmin
📖 راهنمای کامل: DEPLOY-GUIDE.md

🎮 دستورات
👑 سوپر ادمین
دستور
توضیح
/admin	پنل مدیریت
/ssh	ترمینال SSH سرورها
/cf	مدیریت Cloudflare DNS
/chart	نمودار مقایسه ترافیک
/stars	مدیریت Stars (سوپر) / خرید (بقیه)
/lang <fa|en|zh|ru>	تغییر زبان
/paneltest	تست اتصال endpoint‌ها
/status /online /versions	وضعیت سرور
/search /create /delete /renew /addgb	مدیریت کاربران
/addadmin <chatId> <panelIds> [maxUsers] [maxTrafficGB]	افزودن ادمین
/ban /unban /suspend /unsuspend	بن و تعلیق

🛠️ ادمین پنل
دستور
توضیح
/admin	پنل مدیریت (محدود)
/create /delete /addgb /renew	مدیریت کاربران (فقط خودش)
/stars	خرید اعتبار

👤 کاربر عادی
دستور
توضیح
/start	ثبت‌نام / مشاهده اطلاعات
/usage	مشاهده مصرف
/renew	درخواست تمدید
/lang	تغییر زبان
/stars	خرید اشتراک با Stars

🖥️ راه‌اندازی SSH Terminal
۱. نصب ssh-bridge.js روی سرور
bash

scp ssh-bridge.js root@your-server:/root/
ssh root@your-server
nano ssh-bridge.js  # تغییر BRIDGE_TOKEN
node ssh-bridge.js  # یا: pm2 start ssh-bridge.js --name ssh-bridge
۲. تنظیم در ربات
در PANELS_JSON:

json

{
  "panels": [{
    "id": "server1",
    "panelUrl": "https://your-panel.com:54321",
    "apiToken": "...",
    "sshBridgeUrl": "http://YOUR_SERVER:8022",
    "sshBridgeToken": "YOUR_BRIDGE_TOKEN"
  }]
}
یا با wrangler:

bash

wrangler secret put SSH_BRIDGE_URL
wrangler secret put SSH_BRIDGE_TOKEN
۳. استفاده
/ssh → انتخاب سرور → تایپ دستور یا استفاده از دستورات سریع → دکمه‌های تعاملی برای پاسخ به دیالوگ‌ها

☁️ راه‌اندازی Cloudflare DNS
Cloudflare Dashboard → My Profile → API Tokens
Create Token → "Edit zone DNS" → All zones
wrangler secret put CLOUDFLARE_API_TOKEN
⭐ راه‌اندازی پرداخت Stars
سوپر ادمین:

text

/stars → ➕ افزودن طرح → نام → تعداد Stars → توضیحات
کاربران:

text

/stars → انتخاب طرح → پرداخت با Stars
🌐 تغییر زبان
دکمه 🌐 زبان در هر منو یا:

text

/lang fa  — فارسی
/lang en  — English
/lang zh  — 中文
/lang ru  — Русский
📁 فایل‌های پروژه
فایل
توضیح
3xui-bot-worker.js	کد اصلی ربات (۱۰,۰۰۰+ خط)
ssh-bridge.js	SSH bridge با تشخیص context تعاملی
README.md	این فایل — راهنمای صفحه GitHub
3xui-bot-README.md	راهنمای فنی کامل
DEPLOY-GUIDE.md	راهنمای استقرار گام‌به‌گام

🏗️ معماری
text

┌──────────────────┐     Webhook (HTTPS)      ┌──────────────────┐
│  Telegram Bot    │ ◄─────────────────────►  │  Cloudflare      │
│  (User/Admin)    │                          │  Worker          │
└──────────────────┘                          │  (10,000+ lines) │
                                              └──────┬───────────┘
                                                     │
                    ┌────────────────────────────────┼────────────────────┐
                    │                                │                    │
                    ▼                                ▼                    ▼
          ┌─────────────────┐         ┌─────────────────┐     ┌─────────────────┐
          │  3x-ui Panel    │         │  Cloudflare API │     │  SSH Bridge     │
          │  (REST API)     │         │  (DNS Records)  │     │  (ssh-bridge.js)│
          │  v2.x / v3.4.x  │         │                 │     │  Context detect │
          └─────────────────┘         └─────────────────┘     └────────┬────────┘
                                                                          │
                                                                          ▼
                                                                ┌─────────────────┐
                                                                │  Your Server    │
                                                                │  (Shell access) │
                                                                └─────────────────┘
🔧 سازگاری با 3x-ui
نسخه
وضعیت
نکات
v2.x	✅ پشتیبانی کامل	—
v3.x	✅ پشتیبانی کامل	—
v3.4.x	✅ پشتیبانی کامل	/setting/all POST، /clients/onlines POST، /server/logs/:count POST

ربات به‌صورت خودکار نسخه را تشخیص می‌دهد و از مسیرهای API مناسب استفاده می‌کند (method-swap).

📊 محدودیت‌های Cloudflare Workers (Plan رایگان)
منبع
محدودیت
CPU per request	10ms
Memory	128MB
Requests/day	100,000
KV reads/day	100,000
KV writes/day	1,000
Cron triggers	3 (5 با paid)

📝 Changelog
v4.0 (آخرین)
🆕 ترمینال SSH تعاملی با تشخیص context (مثل apt dialogs, confirm prompts)
🆕 چندزبانه کامل (fa/en/zh/ru) — همه منوها و دکمه‌ها
🆕 پرداخت Stars برای کاربران عادی
🆕 محدودیت maxTrafficGB برای ادمین‌ها
🆕 هشدار حجم ۹۰٪
🆕 یادآوری انقضا ۳ روز قبل (فقط به کاربر)
🆕 نوتیفیکیشن کاربر جدید به ادمین‌ها
🆕 نوار پیشرفت بصری
🆕 دکمه GitHub و زبان در همه منوها
🆕 نمودار مقایسه ترافیک
🔧 پشتیبانی از 3x-ui v3.4.x
🔧 رفع باگ callback_data طولانی
🔧 همه دکمه‌های تعاملی (۹۳+ پیام)
🔧 auto-derive subBaseUrl از تنظیمات پنل
🔧 رفع باگ US:Pp در callback tokens
🔧 cascade cleanup در حذف کاربر
v3.0
ماژول مدیریت Cloudflare DNS
منوی دوگانه برای سوپر ادمین
/paneltest برای عیب‌یابی
فیلتر ادمین پلل (فقط کاربران خودش)
v2.0
سیستم نقش‌ها (سوپر/ادمین/کاربر)
مدیریت چند پنل
درخواست تمدید
بکاپ خودکار و هشدار
v1.0
ربات پایه مدیریت 3x-ui
📜 مجوز
MIT License — فایل LICENSE را مطالعه کنید.

🙏 تشکر
3x-ui — پروژه پنل مدیریت Xray
eazy-ssh — الهام بخش سیستم تشخیص context SSH
Cloudflare Workers — پلتفرم اجرا
QuickChart — نمودارها
<p align="center">
<a href="https://github.com/Raya-coder/3x-ui-bot">
<img src="https://img.shields.io/badge/GitHub-Raya--coder%2F3x--ui--bot-blue?style=for-the-badge&logo=github" alt="GitHub">
</a>
<br>
ساخته‌شده با ❤️ برای جامعه متن‌باز
</p>
```
