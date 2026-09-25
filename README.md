# JanitorAI ↔ Vercel AI Gateway Proxy

بروكسي بسيط (Vercel Edge Function واحدة، بدون سيرفر دائم وبدون تخزين أي بيانات) يوصل
JanitorAI بـ **Vercel AI Gateway**، بحيث:

- **المزوّد (Provider)** و**الـ reasoning effort** يتحددوا من خلال خانة **Model** في
  JanitorAI نفسها، بصيغة: `provider/modelname/reasoningeffort`.
- **الـ Proxy URL** رابط الـ cloudflare (أو Vercel) الخام **بس، من غير أي إضافة**
  زي `/chat/completions` — المسار ده متعامل معاه جوه السيرفر نفسه (`local-server/server.mjs`)،
  فالبروكسي بيستقبل POST على أي مسار (`/`, `/chat/completions`, `/v1/chat/completions`...)
  ويتعامل معاه كنفس الطلب. يعني تقدر تسيب زرار "Add /chat/completions" في JanitorAI
  مفعّل أو لأ، النتيجة واحدة.
- الـ **API key** بتاع Vercel AI Gateway بيتبعت من JanitorAI في خانة "API key" ويتمرر
  مباشرة في هيدر `Authorization` — البروكسي مايخزنش ولا يشوف المفتاح، بس بيمرره.
- نسخة `local-server` بتسجّل كل طلب (مدخلات/مخرجات/تفكير/توكنز/تكلفة) في **لوج محلي
  على جهازك بس** — تفاصيل تحت في قسم [تسجيل الطلبات محليًا (اللوج)](#تسجيل-الطلبات-محليًا-اللوج).

## صيغة خانة Model

```
provider/modelname/reasoningeffort   (الجزء الأخير اختياري)
```

| ما تكتبه في Model | المعنى |
|---|---|
| `zai/glm-4.6` | مزوّد `zai`، موديل `glm-4.6`، بدون reasoning |
| `zai/glm-4.6/high` | نفس السابق + reasoning effort عالي |
| `anthropic/claude-sonnet-5/medium` | مزوّد `anthropic`، reasoning متوسط |
| `groq/openai/gpt-oss-120b` | لو الموديل نفسه فيه `/` (زي عند Groq)، يتحدد صح طالما آخر جزء مش كلمة reasoning معروفة |
| `groq/openai/gpt-oss-120b/low` | نفس السابق + reasoning منخفض |

**قيم reasoning المدعومة:** `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
— القيمة دي بتتبعت كـ `reasoning.effort` لـ Vercel AI Gateway، وهو بيترجمها للصيغة
المناسبة للموديل (سواء OpenAI أو Anthropic thinking أو غيره). لو الجزء الأخير مش من
القيم دي، البروكسي هيعتبره جزء من اسم الموديل مش reasoning (زي مثال `groq/openai/gpt-oss-120b`).

## ما اللي JanitorAI بيبعته وينتظره (عشان تفهم ليه البروكسي مبني كده)

JanitorAI بيتعامل مع أي "Proxy" كأنه سيرفر متوافق مع OpenAI:

- بيعمل `POST` على: `<Proxy URL اللي كتبته>/chat/completions`
- بيبعت هيدر: `Authorization: Bearer <API key>`
- بيبعت body بصيغة OpenAI القياسية، فيها `model` بالنص اللي كتبته بالظبط، و`messages`
  (array بأدوار system/user/assistant)، و`stream`, `temperature`, إلخ.
- وبينتظر رد بنفس صيغة OpenAI (`choices[0].message.content`)، أو stream بصيغة SSE لو
  `stream: true`.

البروكسي بيفك خانة `model` لاستخراج المزوّد والـ reasoning، وبيبعت الباقي زي ما هو
لـ `https://ai-gateway.vercel.sh/v1/chat/completions`.

> **ملاحظة عن الـ `/chat/completions`:** JanitorAI هو اللي بيضيفها تلقائيًا على آخر
> الـ Proxy URL وقت إرسال الطلب. سيرفر `local-server/server.mjs` عندنا مش بيفرّق
> أصلًا بين المسارات — أي POST بيوصله (سواء على `/` أو `/chat/completions` أو أي
> حاجة تانية) بيتعامل معاه كطلب chat/completions. يعني حتى لو JanitorAI مستقبلًا
> بعت المسار بصيغة مختلفة، البروكسي لسه هيشتغل من غير أي تعديل.

> **ملاحظة:** بالرجوع لسورس [GeminiForJanitors](https://github.com/vu5eruz/GeminiForJanitors)
> الأصلي، هو كمان بيحدد المزوّد جوه خانة Model بصيغة `provider/model` (زي OpenRouter)،
> فالتصميم ده قريب من نفس الفكرة، بس بإضافة جزء ثالث اختياري للـ reasoning.

## النشر على Vercel

1. ثبّت Vercel CLI:
   ```bash
   npm i -g vercel
   ```
2. من داخل مجلد المشروع:
   ```bash
   vercel deploy --prod
   ```
   أو ارفع المشروع على GitHub واربطه من [vercel.com/new](https://vercel.com/new).

مفيش أي Environment Variables مطلوبة — البروكسي stateless بالكامل.

## تشغيله محليًا على Termux (Android) + cloudflared — بديل مجاني عن Vercel

الملف الجاهز لده في `local-server/server.mjs` (نفس منطق `api/[...slug].js` بالظبط،
بصيغة سيرفر Node عادي بدون أي مكتبات خارجية).

### 1) تثبيت Node.js و cloudflared و git

```bash
pkg update
pkg install -y nodejs cloudflared git
```

### 2) نسخ المشروع (لو الـ repo خاص/private)

لو الـ repo عندك private، لازم Personal Access Token بدل الباسورد العادي:

1. من GitHub: صورتك (فوق يمين) → **Settings** → **Developer settings**
2. **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**
3. حدد صلاحية **repo** فقط، ثم **Generate token** وانسخه فورًا

```bash
git clone https://github.com/<username>/<repo>.git
```

هيطلب `Username` (اسم حسابك) و`Password` (الصق التوكن هنا، مش الباسورد الحقيقي).

### 3) تشغيل السيرفر

```bash
cd <repo>/local-server
node server.mjs
```

هيشتغل افتراضيًا على `http://localhost:5000` (تقدر تغيّر البورت بـ `PORT=8080 node server.mjs`).

### 4) عمل tunnel في جلسة Termux تانية (أو بنفس الجلسة في الخلفية)

```bash
cloudflared tunnel --url http://localhost:5000
```

هيديك رابط زي:
```
https://random-words-1234.trycloudflare.com
```

> ملاحظة: رابط `trycloudflare.com` المجاني بيتغيّر كل مرة تشغّل cloudflared، فلازم
> تحدّث الـ Proxy URL في JanitorAI كل مرة.

### التشغيل في الخلفية على Termux (اختياري)

```bash
termux-wake-lock
node server.mjs &
cloudflared tunnel --url http://localhost:5000 &
```

## الإعداد في JanitorAI

| الحقل | القيمة |
|---|---|
| Proxy URL | `https://random-words-1234.trycloudflare.com` **فقط** (سيبها من غير أي إضافة — سواء ضغطت "Add /chat/completions" في JanitorAI أو لأ، هتشتغل بنفس الشكل) |
| API key | مفتاح AI Gateway بتاعك |
| Model | `zai/glm-4.6/high` (أو أي صيغة `provider/model/reasoning` تانية) |

## اختبار محلي / يدوي

```bash
curl -X POST https://your-project.vercel.app/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai/glm-4.6/high",
    "messages": [{"role":"user","content":"قول مرحبا"}]
  }'
```

## تسجيل الطلبات محليًا (اللوج)

نسخة `local-server` بس (مش نسخة Vercel، لأن دي stateless ومفيهاش تخزين دائم) بتسجّل
كل طلب في ملف على جهازك، جوه `local-server/logs/`. الملفات من نوع **JSON Lines**
(سطر = حدث JSON واحد) — ملف منفصل لكل يوم بصيغة `YYYY-MM-DD.ndjson`، عشان تقدر
تلاقي وتنضف القديم بسهولة.

كل سطر "request" فيه:

- التاريخ والوقت (`ts`)، ومدة الطلب (`duration_ms`)
- `provider`، `model`، `reasoning_effort` (المستخرجين من خانة Model)
- `input.messages` (كل الرسايل اللي اتبعتت — النص الكامل)
- `output.content` (رد الموديل الكامل) و`output.finish_reason`
- `reasoning.text` (نص التفكير الكامل لو الموديل بعت reasoning)
- `usage` (توكنز الإدخال/الإخراج/التفكير لو Vercel رجّعتهم)
- `generation_id` بتاع Vercel لكل طلب

**التكلفة (`cost`)** بتوصل متأخرة شوية (ثواني معدودة) لأن Vercel بتسجل الـ usage
events بشكل غير متزامن، فالبروكسي بيحاول يجيبها في الخلفية (من غير ما يأخر الرد
اللي راجع لـ JanitorAI) وبيضيفها كسطر `"type":"cost"` منفصل مربوط بنفس الـ
`generation_id`.

**مهم:** الـ **API key** بتاعك **مابيتسجلش خالص** في اللوج — بس بيتمرر في الهيدر
ولا بيتحفظ في أي ملف.

### عرض اللوج

من جوه `local-server/`:

```bash
node view-logs.mjs                 # ملخّص طلبات النهارده
node view-logs.mjs 2026-09-20      # ملخّص يوم معيّن
node view-logs.mjs --all           # كل التواريخ المتوفرة
node view-logs.mjs --stats         # إجمالي التوكنز والتكلفة على كل الأيام
node view-logs.mjs --full <id>     # التفاصيل الكاملة (input/output/reasoning) لطلب واحد بالـ generation_id بتاعه
```

لو عايز تمسح اللوجات القديمة، امسح الملفات اللي جوه `local-server/logs/` عادي —
مفيش أي حاجة بتتحدّث تلقائيًا بترجع تاني.

> **خصوصية:** مجلد `local-server/logs/` مضاف في `.gitignore`، يعني لو الـ repo بتاعك
> على GitHub (حتى لو private) مش هيترفع فيه، وهيفضل على جهازك بس.

## ملاحظات

- CORS مفتوح للجميع (`Access-Control-Allow-Origin: *`) لأن JanitorAI بيستدعي البروكسي
  مباشرة من متصفح المستخدم.
- الـ streaming (`stream: true`) بيتمرر كما هو (pass-through) من غير أي تعديل.
