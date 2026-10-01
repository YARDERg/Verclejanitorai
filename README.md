# JanitorAI ↔ Vercel AI Gateway / Google AI Studio Proxy

بروكسي بسيط (Vercel Edge Function واحدة، بدون سيرفر دائم وبدون تخزين أي بيانات) يوصل
JanitorAI بـ **Vercel AI Gateway** أو **Google AI Studio (Gemini API)**، ويختار الخدمة
تلقائيًا من شكل الـ API key الذي تضعه في JanitorAI، بحيث:

- مع **Vercel** يتحدد **المزوّد (Provider)** والـ **reasoning effort** من خانة **Model** بصيغة
  `provider/modelname/reasoningeffort`. مع **Google AI Studio** يكفي اسم موديل Gemini، ويمكن إضافة
  `/reasoning` في النهاية.
- **الـ Proxy URL** رابط الـ cloudflare (أو Vercel) الخام **بس، من غير أي إضافة**
  زي `/chat/completions` — المسار ده متعامل معاه جوه السيرفر نفسه (`local-server/server.mjs`)،
  فالبروكسي بيستقبل POST على أي مسار (`/`, `/chat/completions`, `/v1/chat/completions`...)
  ويتعامل معاه كنفس الطلب. يعني تقدر تسيب زرار "Add /chat/completions" في JanitorAI
  مفعّل أو لأ، النتيجة واحدة.
- الـ **API key** بتاع Vercel AI Gateway بيتبعت من JanitorAI في خانة "API key" ويتمرر
  مباشرة في هيدر `Authorization` — البروكسي مايخزنش ولا يشوف المفتاح، بس بيمرره.
- نسخة `local-server` بتسجّل كل طلب (مدخلات/مخرجات/تفكير/توكنز/تكلفة) في **لوج محلي
  على جهازك بس** — تفاصيل تحت في قسم [تسجيل الطلبات محليًا (اللوج)](#تسجيل-الطلبات-محليًا-اللوج).

## اختيار Vercel أو Google من الـ API key

لا تحتاج لتغيير Proxy URL عندما تنتقل بين الخدمتين. استخدم فقط مفتاح الخدمة التي تريدها:

| بداية الـ API key | الوجهة | مثال Model |
|---|---|---|
| `vck_` | Vercel AI Gateway | `zai/glm-4.6/high` |
| `AIza` | Google AI Studio | `gemini-3.8-flash/high` |

مفاتيح Vercel AI Gateway الجديدة تستخدم بادئة `vck_`، بينما مفتاح Gemini API من Google AI Studio
يُستخدم مباشرة مع OpenAI-compatible endpoint الخاص بـ Gemini. Google توثّق أن endpoint هو
`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` وأن المصادقة تتم بـ
`Authorization: Bearer <GEMINI_API_KEY>`. citeturn335181search0turn586504search0

### صيغة خانة Model مع Vercel

```
provider/modelname/reasoningeffort   (الجزء الأخير اختياري)
```

| ما تكتبه في Model | المعنى |
|---|---|
| `zai/glm-4.6` | مزوّد `zai`، موديل `glm-4.6`، بدون reasoning |
| `zai/glm-4.6/high` | نفس السابق + reasoning effort عالي |

> مع Vercel يُرسل المزوّد كـ `providerOptions.gateway.only` (حصر صارم في هذا المزوّد، بدون fallback).
| `groq/openai/gpt-oss-120b` | مزوّد `groq`، واسم الموديل نفسه يحتوي `/` |

### صيغة خانة Model مع Google AI Studio

```
gemini-model/reasoningeffort
```

البروكسي يقبل أيضًا `google/gemini-model/reasoningeffort`، لكنه يحذف `google/` قبل إرسال الطلب
إلى Google. لو لم تضع reasoning أصلًا (أو وضعت `none`)، فلا تتم إضافة `reasoning_effort`، وبالتالي يظل إعداد
التفكير الافتراضي للنموذج هو المستخدم.

تحويل القيم مع Google: `minimal` ← `low`، و`xhigh` و`max` ← `high`، و`low/medium/high` كما هي.
(`gemini-3.8-flash` لا يدعم `minimal` ولا يمكن إيقاف التفكير فيه.) Google توثّق دعم `reasoning_effort` في OpenAI-compatible
API لنماذج التفكير. citeturn586504search0

مثال:

```
gemini-3.8-flash
gemini-3.8-flash/high
google/gemini-3.8-flash/high
```

> ملاحظة: اسم الموديل نفسه يجب أن يكون اسم Gemini المتاح في حسابك/نسخة الـ API التي تستخدمها.


## ما اللي JanitorAI بيبعته وينتظره (عشان تفهم ليه البروكسي مبني كده)

JanitorAI بيتعامل مع أي "Proxy" كأنه سيرفر متوافق مع OpenAI:

- بيعمل `POST` على: `<Proxy URL اللي كتبته>/chat/completions`
- بيبعت هيدر: `Authorization: Bearer <API key>`
- بيبعت body بصيغة OpenAI القياسية، فيها `model` بالنص اللي كتبته بالظبط، و`messages`
  (array بأدوار system/user/assistant)، و`stream`, `temperature`, إلخ.
- وبينتظر رد بنفس صيغة OpenAI (`choices[0].message.content`)، أو stream بصيغة SSE لو
  `stream: true`.

البروكسي يحدد الخدمة من الـ API key، ثم يفك خانة `model` ويحوّل reasoning إلى الصيغة المناسبة
للخدمة. Vercel يستخدم `https://ai-gateway.vercel.sh/v1/chat/completions`، وGoogle يستخدم
`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`.

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
بصيغة سيرفر Node عادي بدون أي مكتبات خارجية، وبيسجّل كل طلب في قاعدة بيانات SQLite
محلية — راجع [تسجيل الطلبات محليًا](#تسجيل-الطلبات-محليًا-قاعدة-البيانات) تحت).

> يحتاج Node **22.5 أو أحدث** عشان `node:sqlite` (لتسجيل الطلبات) تكون متاحة.
> `pkg install nodejs` على Termux بيجيب أحدث نسخة عادةً، فمفروض تكون متاحة.

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
| API key | `vck_...` لـ Vercel أو `AIza...` لـ Google AI Studio |
| Model | مثال Vercel: `zai/glm-4.6/high` — مثال Google: `gemini-3.8-flash/high` |

## اختبار محلي / يدوي

### Vercel AI Gateway

```bash
curl -X POST https://your-project.vercel.app/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai/glm-4.6/high",
    "messages": [{"role":"user","content":"قول مرحبا"}]
  }'
```

### Google AI Studio

```bash
curl -X POST https://your-project.vercel.app/chat/completions \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash/high",
    "messages": [{"role":"user","content":"قول مرحبا"}]
  }'
```

في الاختبار الثاني لا تحتاج لتغيير الـ URL؛ البروكسي سيعرف أنه طلب Google من بداية المفتاح.

## تسجيل الطلبات محليًا (قاعدة البيانات)

نسخة `local-server` بس (مش نسخة Vercel، لأن دي stateless ومفيهاش تخزين دائم) بتسجّل
كل طلب في **قاعدة بيانات SQLite حقيقية، ملف واحد بس**: `local-server/logs.db`.

مبني على `node:sqlite` **المدمجة جوه Node نفسه** (متاحة من Node 22.5+) — يعني مفيش
أي `npm install`. الملف ده بيتفتح ويضاف عليه في كل مرة تشغّل `node server.mjs`،
حتى لو قفلت جلسة Termux وفتحتها تاني بعد يوم أو أسبوع — البيانات بتفضل موجودة
وبيكمّل يضيف عليها من غير ما يعمل ملفات جديدة أو يصفّرها.

فيه جدول واحد اسمه `requests`، وكل سطر فيه:

- التاريخ والوقت (`ts`)، ومدة الطلب (`duration_ms`)
- `provider`، `model`، `reasoning_effort` (المستخرجين من خانة Model)
- `input_messages` (كل الرسايل اللي اتبعتت — النص الكامل، JSON)
- `output_content` (رد الموديل الكامل) و`finish_reason`
- `reasoning_text` (نص التفكير الكامل لو الموديل بعت reasoning)
- توكنز الإدخال/الإخراج/التفكير (`usage_prompt_tokens`... إلخ)
- `generation_id` بتاع Vercel، وعمود `total_cost` (وتفاصيل التكلفة الفرعية)

**التكلفة (`total_cost`)** بتوصل متأخرة شوية (ثواني معدودة) لأن Vercel بتسجل الـ
usage events بشكل غير متزامن، فالبروكسي بيحاول يجيبها في الخلفية (من غير ما يأخر
الرد اللي راجع لـ JanitorAI) وبيعمل `UPDATE` على نفس السطر لما توصل.

**مهم:** الـ **API key** بتاعك **مابيتسجلش خالص** في قاعدة البيانات — بس بيتمرر في
الهيدر ولا بيتحفظ في أي مكان.

### عرض قاعدة البيانات

من جوه `local-server/`:

```bash
node view-logs.mjs                 # آخر 20 طلب (بغض النظر عن التاريخ)
node view-logs.mjs --last 50       # آخر 50 طلب
node view-logs.mjs 2026-09-20      # كل طلبات يوم معيّن
node view-logs.mjs --all           # كل التواريخ اللي فيها طلبات
node view-logs.mjs --stats         # إجمالي التوكنز والتكلفة على كل الفترة
node view-logs.mjs --full <id>     # التفاصيل الكاملة (input/output/reasoning) لطلب واحد — الـ id رقم السطر أو generation_id بتاع Vercel
```

أو لو عايز تستعلم بنفسك بـ SQL مباشرة (بعد تثبيت أداة `sqlite3` أو أي برنامج زي
DB Browser for SQLite):

```bash
sqlite3 local-server/logs.db "SELECT ts, model, total_cost FROM requests ORDER BY id DESC LIMIT 5;"
```

لو عايز تصفّر السجل كله، امسح `local-server/logs.db` (وملفات `logs.db-wal` /
`logs.db-shm` المرافقة له لو موجودة) — هيتعمل من جديد أول ما تشغّل السيرفر تاني.

> **خصوصية:** `local-server/logs.db` مضاف في `.gitignore`، يعني لو الـ repo بتاعك
> على GitHub (حتى لو private) مش هيترفع فيه، وهيفضل على جهازك بس.

## ملاحظات

- CORS مفتوح للجميع (`Access-Control-Allow-Origin: *`) لأن JanitorAI بيستدعي البروكسي
  مباشرة من متصفح المستخدم.
- الـ streaming (`stream: true`) بيتمرر لحظيًا للعميل زي ما هو (pass-through حقيقي)،
  وفي نفس الوقت بيتجمّع في الخلفية عشان يتسجل في قاعدة البيانات بعد ما يخلص.
