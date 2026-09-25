# JanitorAI ↔ Vercel AI Gateway Proxy

بروكسي بسيط (Vercel Edge Function واحدة، بدون سيرفر دائم وبدون تخزين أي بيانات) يوصل
JanitorAI بـ **Vercel AI Gateway**، بحيث:

- **المزوّد (Provider)** و**الـ reasoning effort** يتحددوا من خلال الـ URL نفسه (الـ Proxy URL).
- **الموديل (Model)** يتحدد من خلال خانة "Model" في JanitorAI زي ما هي، ويتمرر كما هو لـ AI Gateway
  (مثلاً `zai/glm-4.6`, `anthropic/claude-sonnet-5`, إلخ).
- الـ **API key** بتاع Vercel AI Gateway بيتبعت من JanitorAI في خانة "API key" ويتمرر مباشرة
  في هيدر `Authorization` — البروكسي مايخزنش ولا يشوف المفتاح، بس بيمرره.

## ما اللي JanitorAI بيبعته وينتظره (عشان تفهم ليه البروكسي مبني كده)

JanitorAI بيتعامل مع أي "Proxy" كأنه سيرفر متوافق مع OpenAI:

- بيعمل `POST` على: `<Proxy URL اللي كتبته>/chat/completions`
  (الزرار "Add /chat/completions" في واجهة JanitorAI بيضيف الجزء ده تلقائيًا آخر رابطك)
- بيبعت هيدر: `Authorization: Bearer <API key>`
- بيبعت body بصيغة OpenAI القياسية:
  ```json
  {
    "model": "zai/glm-4.6",
    "messages": [{ "role": "user", "content": "..." }],
    "temperature": 0.8,
    "max_tokens": 500,
    "stream": true
  }
  ```
- وبينتظر رد بنفس صيغة OpenAI (`choices[0].message.content`)، أو stream بصيغة SSE
  (`data: {"choices":[{"delta":{"content":"..."}}]}`) لو `stream: true`.

Vercel AI Gateway متوافق أصلاً 100% مع صيغة OpenAI على `/v1/chat/completions`، فالبروكسي
مش محتاج يترجم حاجة — كل شغله إنه يضيف حقلين إضافيين خاصين بـ AI Gateway مش موجودين في
صيغة OpenAI العادية: `providerOptions.gateway.order` (لتحديد المزوّد) و`reasoning.effort`
(لتحديد قوة التفكير)، بناءً على أجزاء الـ URL.

## النشر على Vercel

1. ثبّت Vercel CLI:
   ```bash
   npm i -g vercel
   ```
2. من داخل مجلد المشروع:
   ```bash
   vercel deploy --prod
   ```
   أو ارفع المشروع على GitHub واربطه من [vercel.com/new](https://vercel.com/new) (Import Project).

مفيش أي Environment Variables مطلوبة — البروكسي stateless بالكامل، مفتاح الـ API بييجي
من JanitorAI نفسه في كل طلب.

بعد النشر هتاخد رابط زي:
```
https://your-project.vercel.app
```

## إعداد JanitorAI

| الحقل في JanitorAI | القيمة |
|---|---|
| Name | أي اسم (مثلاً Glm) |
| Proxy URL | `https://your-project.vercel.app/<provider>/<reasoning>` |
| API key | مفتاح AI Gateway بتاعك (`AI_GATEWAY_API_KEY`) |
| Model | اسم الموديل بصيغة `provider/model` (مثلاً `zai/glm-4.6`) |

اضغط "Add /chat/completions" في JanitorAI عشان يضيف الجزء ده تلقائيًا، فيصبح المسار
النهائي: `.../<provider>/<reasoning>/chat/completions`

### أمثلة على الـ Proxy URL

| Proxy URL | المعنى |
|---|---|
| `https://your-project.vercel.app/auto/none` | بدون تحديد مزوّد، بدون reasoning |
| `https://your-project.vercel.app/zai/none` | يفرض المزوّد `zai`، بدون reasoning |
| `https://your-project.vercel.app/anthropic/high` | يفرض `anthropic`، مع reasoning effort عالي |
| `https://your-project.vercel.app/anthropic,bedrock/medium` | قائمة مزوّدين احتياطية (fallback) + reasoning متوسط |

### قيم reasoning المدعومة

`none` (أو `off`) لتعطيلها تمامًا، أو: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
— القيمة دي بتتبعت كـ `reasoning.effort` لـ AI Gateway، وهو بدوره يترجمها للصيغة
المناسبة للموديل (سواء OpenAI أو Anthropic thinking أو غيره).

> لو الموديل اللي اخترته مش بيدعم reasoning، AI Gateway هيتجاهل الحقل غالبًا، لكن لو
> حصل خطأ من مزوّد معيّن بسبب الحقل ده، جرّب `none`.

## تشغيله محليًا على Termux (Android) + cloudflared — بديل مجاني عن Vercel

بدل نشر المشروع على Vercel، تقدر تشغّل نفس الفكرة على جهازك بنفس طريقة GeminiForJanitors:
سيرفر Node.js محلي + نفق (tunnel) بـ `cloudflared`. الملف الجاهز لده موجود في
`local-server/server.mjs` (نفس منطق `api/[...slug].js` بالظبط، لكن بصيغة سيرفر Node
عادي بدون أي مكتبات خارجية).

### 1) تثبيت Node.js و cloudflared على Termux

```bash
pkg update
pkg install -y nodejs cloudflared
```

### 2) تشغيل السيرفر

```bash
cd janitorai-vercel-gateway/local-server
node server.mjs
```

هيشتغل افتراضيًا على `http://localhost:5000` (تقدر تغيّر البورت بـ `PORT=8080 node server.mjs`).

### 3) عمل tunnel في جلسة Termux تانية (أو بنفس الجلسة في الخلفية)

```bash
cloudflared tunnel --url http://localhost:5000
```

هيديك رابط زي:
```
https://random-words-1234.trycloudflare.com
```

> ملاحظة: نفق `trycloudflare.com` المجاني ده رابطه بيتغيّر في كل مرة تشغّله، فلازم تحدّث
> الـ Proxy URL في JanitorAI كل ما تعيد تشغيل cloudflared. لو عايز رابط ثابت، محتاج
> حساب Cloudflare وربط domain (نفس الخطوة الموجودة في GeminiForJanitors نفسه).

### 4) الإعداد في JanitorAI

نفس الفكرة بالظبط:

| الحقل | القيمة |
|---|---|
| Proxy URL | `https://random-words-1234.trycloudflare.com/<provider>/<reasoning>` |
| API key | مفتاح AI Gateway بتاعك |
| Model | `zai/glm-4.6` أو أي موديل تاني بصيغة `provider/model` |

### التشغيل في الخلفية على Termux (اختياري)

عشان السيرفر والـ tunnel يفضلوا شغالين حتى لو قفلت الشاشة، ثبّت `termux-services` أو
استخدم `tmux`/`screen`، أو ببساطة شغّلهم بـ `&` واحتفظ بالجلسة عن طريق `termux-wake-lock`:

```bash
termux-wake-lock
node server.mjs &
cloudflared tunnel --url http://localhost:5000 &
```

## اختبار محلي / يدوي

```bash
curl -X POST https://your-project.vercel.app/zai/none/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai/glm-4.6",
    "messages": [{"role":"user","content":"قول مرحبا"}]
  }'
```

## ملاحظات

- CORS مفتوح للجميع (`Access-Control-Allow-Origin: *`) لأن JanitorAI بيستدعي البروكسي
  مباشرة من متصفح المستخدم.
- الـ streaming (`stream: true`) بيتمرر كما هو (pass-through) من غير أي تعديل.
- لو عايز تضيف مزايا زي إخفاء الموديل الحقيقي أو تحديد موديلات مسموحة بس، ده سهل تضيفه
  في نفس الملف `api/[...slug].js`.
