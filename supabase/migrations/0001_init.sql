-- Ghost Help AI — schema
-- Run this once against your Supabase project (SQL editor, CLI, or the Supabase MCP).

-- 1. Enable pgvector
create extension if not exists vector;

-- 2. Chunks table. One row per retrievable passage.
--    1536 dims = OpenAI text-embedding-3-small.
create table if not exists public.help_chunks (
  id            bigint generated always as identity primary key,
  url           text        not null,
  title         text        not null,
  topic         text,                       -- e.g. "Ghost(Pro)", "FAQ", "Ghost manual"
  heading       text,                       -- nearest section heading for the chunk
  content       text        not null,
  token_count   int,
  embedding     vector(1536) not null,
  created_at    timestamptz not null default now()
);

-- 3. Approximate-nearest-neighbor index (cosine).
create index if not exists help_chunks_embedding_idx
  on public.help_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. Similarity search RPC used by the chat API.
create or replace function public.match_help_chunks (
  query_embedding vector(1536),
  match_count int default 6,
  similarity_threshold float default 0.0
)
returns table (
  id bigint,
  url text,
  title text,
  topic text,
  heading text,
  content text,
  similarity float
)
language sql stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.url,
    c.title,
    c.topic,
    c.heading,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.help_chunks c
  where 1 - (c.embedding <=> query_embedding) > similarity_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Row Level Security: keep the table readable only via the RPC / service role.
alter table public.help_chunks enable row level security;
-- No public SELECT policy. The anon key reaches data only through match_help_chunks,
-- which is SECURITY DEFINER and therefore bypasses RLS for the controlled query below.
grant execute on function public.match_help_chunks to anon, authenticated;
