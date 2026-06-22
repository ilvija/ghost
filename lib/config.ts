export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
// Embeddings still use OpenAI (Claude has no embeddings endpoint).
// Generation uses Claude — override via env if needed.
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "claude-haiku-4-5-20251001";
export const EMBEDDING_DIMS = 1536;

// Retrieval tuning
export const MATCH_COUNT = 6;
export const SIMILARITY_THRESHOLD = 0.15;

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
