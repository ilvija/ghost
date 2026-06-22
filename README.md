# Ghost Help Assistant

A Salomon-style AI knowledge base built over the [Ghost Help Center](https://ghost.org/help/). Ask a question in plain language; it retrieves the most relevant passages from the official help articles and answers with inline citations and source links.

This is a retrieval-augmented generation (RAG) app:

```
question ─▶ embed ─▶ pgvector similarity search (Supabase) ─▶ top passages ─▶ LLM answer + citations
```

## Stack

| Layer        | Choice                                          | Why |
|--------------|-------------------------------------------------|-----|
| Framework    | Next.js (App Router), deploy on Vercel          | One repo for UI + API, zero-config deploy |
| Vector store | Supabase Postgres + `pgvector`                  | You already use it; cheap, SQL-native |
| Embeddings   | OpenAI `text-embedding-3-small` (1536-dim)      | ~$0.01 to embed the entire help center |
| Generation   | OpenAI `gpt-4o-mini`                            | Fast, cheap, grounded by the retrieved context |

Swapping the answer model for Claude later is a small change in `app/api/chat/route.ts` — only generation needs to change; retrieval is provider-agnostic.

## Setup

### 1. Install
```bash
npm install
```

### 2. Configure environment
A pre-filled `.env.local` is already included, pointing at **sambt94's Project** (`qunrmtryornazloeaydr`) with the Supabase URL and publishable key set. You only need to add two secrets:
- `OPENAI_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard → Project Settings → API → `service_role` (used only by the ingest script)

### 3. Database schema — already provisioned ✅
The schema has been applied to your Supabase project (migration `ghost_help_ai_init`): `pgvector` is enabled and the `help_chunks` table, the ANN index, and the `match_help_chunks` search function are live. The SQL also lives in `supabase/migrations/0001_init.sql` for reference / re-applying elsewhere.

### 4. Ingest the help center
```bash
npm run ingest              # crawl + embed all ~130 articles
npm run ingest -- --limit 5 # quick smoke test on 5 articles first
```
The script discovers article URLs from the help center sitemap (falling back to the bundled `data/urls.json`), extracts heading-aware text, chunks it, embeds in batches, and upserts into Supabase. A local copy is written to `data/corpus.json` for inspection.

### 5. Run
```bash
npm run dev      # http://localhost:3000
```

## Deploy to Vercel
1. Push this repo to GitHub.
2. Import it in Vercel.
3. Add the same env vars (`OPENAI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) in Project Settings → Environment Variables. The service-role key is **not** needed in Vercel — it's only used by the local ingest step.
4. Deploy. Re-run `npm run ingest` locally whenever the help center changes (or wire it into a scheduled job).

## Scheduled re-indexing
A GitHub Actions workflow (`.github/workflows/reindex.yml`) re-runs the ingest **every Monday at 06:00 UTC** (and on-demand from the Actions tab) so the vector index tracks changes to the help center. After pushing to GitHub, add three repository secrets under **Settings → Secrets and variables → Actions**:
- `OPENAI_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL` → `https://qunrmtryornazloeaydr.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`

Why GitHub Actions rather than an in-app schedule: the crawl+embed job needs your secrets, network access, and a persistent runtime — Actions gives all three for free and keeps the secrets out of the browser. Change the `cron:` line to adjust the cadence.

## How it works

- **`scripts/ingest.mjs`** — the crawler/indexer. Robust extraction via DOM selectors with a Readability fallback; heading-aware chunking (~300 tokens, 150-char overlap).
- **`lib/rag.ts`** — embeds the query, calls the `match_help_chunks` RPC, builds the grounded prompt, and de-dupes sources.
- **`app/api/chat/route.ts`** — streams the answer token-by-token; passes citation sources to the client via the `x-sources` header.
- **`app/page.tsx`** — the chat widget (streaming bubbles, suggested questions, source links).

## Guardrails
The system prompt instructs the model to answer **only** from retrieved context and to say so when the help center doesn't cover something — so it won't invent prices, DNS values, or settings. Tune `MATCH_COUNT` and `SIMILARITY_THRESHOLD` in `lib/config.ts`.

## Reusing this for other sources
Point `scripts/ingest.mjs` at a different sitemap (or feed it your own list of URLs / documents) and the rest of the pipeline is unchanged — this is the same shape as an internal-docs / Jira / Slack knowledge base.
