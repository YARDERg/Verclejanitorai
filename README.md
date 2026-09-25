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
