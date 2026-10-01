# JanitorAI Proxy for Vercel AI Gateway and Google AI Studio

A small proxy that lets JanitorAI use either:

- Google AI Studio / Gemini API
- Vercel AI Gateway

The provider is selected automatically from the API key. Vercel keys starting with `vck_` use Vercel; other non-empty API keys use Google. This fallback is intentional so newer Google key formats are not rejected because they do not use the historical `AIza` prefix.

## What changed in this version

### Google error handling

The Google key pool now follows Google's documented error categories more carefully:

- `401` authentication failures: rotate to the next Google key and temporarily quarantine the failing key.
- `403` permission/access failures: do **not** rotate. A 403 can indicate project permissions, region/access restrictions, or other account-level conditions, so switching keys is not a safe assumption.
- `429 RESOURCE_EXHAUSTED`: rotate to another Google key when available. Daily quota exhaustion is held until the next midnight Pacific reset; other rate limits use Google's `retryDelay` when present.
- Other client/server errors are passed through instead of being incorrectly treated as key failures.

Google documents 401 as an authentication problem, 403 as a permission problem, and 429 as rate-limit/quota exhaustion. Google also recommends exponential backoff for transient retryable errors. See the official Gemini API error and troubleshooting documentation.

### Important quota detail

Gemini rate limits are applied **per Google Cloud project, not per API key**. Therefore, three keys from the same project do not provide three independent daily quotas. Rotation is useful when your keys belong to projects with independent quota.

Daily requests-per-day quotas reset at midnight Pacific Time according to Google's current rate-limit documentation.

### English-only interface

All built-in UI messages, CLI output, comments, and documentation are now English and left-to-right friendly.

The SQLite schema was already English, so no schema migration is required. Existing `logs.db` files remain compatible. User-generated request/response text stored inside the database is not rewritten, because that is data rather than application UI.

## Google AI Studio / Gemini API

The proxy uses Google's OpenAI-compatible endpoint:

```text
https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
```

Google's OpenAI compatibility documentation currently shows this base endpoint and Bearer API-key authentication through the OpenAI-compatible client.

### Model syntax

```text
gemini-model
 gemini-model/reasoning
 google/gemini-model/reasoning
```

Examples:

```text
gemini-3.8-flash
gemini-3.8-flash/high
google/gemini-3.8-flash/high
```

The current Gemini 3.8 Flash documentation lists `gemini-3.8-flash` as a stable model and supports thinking levels `low`, `medium`, and `high`. `minimal` is not supported by that model. Gemini 3 models cannot disable thinking entirely.

The proxy maps JanitorAI/OpenAI-style reasoning values as follows:

| Input | Google value |
|---|---|
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |
| `max` | `high` |
| `none` or omitted | Do not send `reasoning_effort`; keep the model default |

For `gemini-3.8-flash`, the documented default thinking level is `medium`.

## Multiple Google keys

Put multiple Google keys in JanitorAI's API key field, separated by commas or new lines:

```text
AIzaKEY1,AIzaKEY2,AIzaKEY3
```

The proxy tries available keys in their original order. When a key is marked exhausted for a model, it is temporarily skipped. The same model can therefore use a different key on a later request.

The proxy never stores the actual API keys in SQLite. It only exposes a diagnostic response header such as:

```text
X-Proxy-Key-Slot: 2/3
```

This header identifies the key position, not the key itself.

### Why a key can still fail after rotation

If all keys belong to the same Google Cloud project, they share that project's Gemini quota. Rotation cannot create additional quota in that situation. This is a Google-side quota rule, not a proxy limitation.

Also, a `403` is intentionally not rotated because it is not necessarily a bad API key. Google documents permission and access restrictions as possible causes.

## Vercel AI Gateway

Vercel requests use:

```text
https://ai-gateway.vercel.sh/v1/chat/completions
```

### Model syntax

```text
provider/model
provider/model/reasoning
```

Examples:

```text
zai/glm-4.6
zai/glm-4.6/high
groq/openai/gpt-oss-120b
```

The first path component is treated as the selected Vercel provider. The remaining model path is sent as the model name, and the provider is placed in `providerOptions.gateway.only`.

## JanitorAI configuration

| Field | Value |
|---|---|
| Proxy URL | Your deployed proxy URL only |
| API key | Google key(s), or a Vercel `vck_...` key |
| Model for Google | `gemini-3.8-flash/high` |
| Model for Vercel | `zai/glm-4.6/high` |

JanitorAI can append `/chat/completions` to the proxy URL. The local server also accepts the normal HTTP request regardless of the exact incoming path.

## Deploy to Vercel

1. Install the Vercel CLI:

```bash
npm i -g vercel
```

2. From the project directory:

```bash
vercel deploy --prod
```

Or connect the repository to Vercel and deploy it from the Vercel dashboard.

No environment variables are required for the standard Vercel deployment.

## Run locally on Termux

The local server is a plain Node.js HTTP server and does not require npm dependencies.

Node.js **22.5+** is required because the logger uses the built-in `node:sqlite` module.

### Install prerequisites

```bash
pkg update
pkg install -y nodejs cloudflared git
```

### Start the server

```bash
cd local-server
node server.mjs
```

Default address:

```text
http://localhost:5000
```

You can change the port:

```bash
PORT=8080 node server.mjs
```

### Expose it with Cloudflare Tunnel

In another Termux session:

```bash
cloudflared tunnel --url http://localhost:5000
```

Use the generated HTTPS URL as the JanitorAI Proxy URL.

## Local SQLite logging

Only the local-server version stores request logs. The database file is:

```text
local-server/logs.db
```

The same database file is reused after restarts. WAL mode allows the log viewer to read the database while the server is running.

The schema contains English column names, including:

- request timestamp and duration
- provider and model
- original model field
- reasoning effort
- input messages
- output content
- finish reason
- reasoning text when available
- token usage
- Vercel generation ID
- delayed Vercel cost information
- error messages

API keys are not stored in the database.

### Existing database handling

If `local-server/logs.db` already exists, the server uses it and keeps the existing rows. The current schema uses English column names, so no Arabic-to-English database migration is necessary.

Arabic or other language text inside `input_messages`, `output_content`, or other user-generated fields is preserved exactly as data. Only application UI/documentation was translated to English.

### View logs

```bash
node view-logs.mjs
node view-logs.mjs --last 50
node view-logs.mjs 2026-09-25
node view-logs.mjs --all
node view-logs.mjs --stats
node view-logs.mjs --full <id-or-generation-id>
```

### Direct SQLite query

```bash
sqlite3 local-server/logs.db "SELECT ts, model, total_cost FROM requests ORDER BY id DESC LIMIT 5;"
```

Delete `local-server/logs.db` if you intentionally want to start a new empty log database.

## Manual tests

### Google

```bash
curl -X POST https://YOUR-PROXY.example/chat/completions \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash/high",
    "messages": [{"role":"user","content":"Say hello."}]
  }'
```

### Vercel

```bash
curl -X POST https://YOUR-PROXY.example/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai/glm-4.6/high",
    "messages": [{"role":"user","content":"Say hello."}]
  }'
```

## Security notes

- API keys are forwarded to the selected upstream service and are not written to the SQLite database.
- The diagnostic key-slot header never contains the actual key.
- Restrict Google API keys to the Gemini API as recommended by Google's current API-key documentation.
- Keep `logs.db` private because it can contain complete prompts and model responses.

## Official references

- Google Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- Google Gemini API errors: https://ai.google.dev/gemini-api/docs/api-errors
- Google Gemini troubleshooting: https://ai.google.dev/gemini-api/docs/troubleshooting
- Google Gemini rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Google Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Google Gemini models: https://ai.google.dev/gemini-api/docs/models
