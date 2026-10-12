# شاهد معي | Shahid Ma3i

تطبيق مساعدة مرئية عن بُعد مبني على WebRTC وSocket.IO، مع دعم إعادة الاتصال، وتبادل ICE candidates، وإنهاء الجلسة بشكل منظم.

## المزايا
- إنشاء جلسة مؤقتة برمز ورابط دعوة.
- دعم session token لتأمين إشارات WebRTC.
- perfect-negotiation style handling لتقليل تعارض العروض.
- إعادة اتصال تلقائية ومحاولة استعادة الجلسة عند ضعف الشبكة أو انقطاعها.
- دعم STUN افتراضيًا، وإمكانية تفعيل TURN عبر متغيرات البيئة.
- إدارة جلسات وrooms مع تنظيف تلقائي.

## التشغيل المحلي
```bash
npm install
npm start
```

ثم افتح:
```bash
http://localhost:3000
```

## متغيرات البيئة
انسخ `.env.example` وأضف القيم المناسبة:
- `PORT`
- `CORS_ORIGIN`
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_PASSWORD`

## ملاحظات الإنتاج
- الخادم يرسل أحداث Socket.IO التالية: `create-room` و`join-room` و`offer` و`answer` و`ice-candidate` و`leave` و`reconnect` و`end-session`.
- العميل والخادم يعتمدان نفس الحقول الأساسية: `roomId` و`sessionToken` و`offer` و`answer` و`candidate`.
- عند إنهاء الجلسة أو خروج أحد الطرفين يتم تنظيف الـ peer connection والجلسة على الخادم.

## بنية الملفات
- `server.js`: الخادم وSocket.IO وإدارة الجلسات.
- `app.js`: منطق العميل وWebRTC.
- `index.html`: الواجهة.
- `style.css`: التصميم.
- `docs/`: ملفات توثيق إضافية.
