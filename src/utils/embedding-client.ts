/**
 * Thin embedding client for the knowledge-base search path.
 *
 * Mirrors the two providers dagster-quickstart supports so that the
 * search query is embedded in the SAME vector space the ingest wrote
 * — cross-provider cosine distances are meaningless, so the write and
 * read sides MUST use the same provider + model.
 *
 * Providers:
 *   - voyage        — Voyage AI native REST. Uses `input_type: "query"`
 *                     for asymmetric embedding (the ingest wrote with
 *                     "document"); this is what boosts retrieval
 *                     quality vs a symmetric-only model.
 *   - openai_compat — /v1/embeddings on any OpenAI-compatible endpoint
 *                     (Together AI, Fireworks, HuggingFace TEI,
 *                     self-hosted vLLM). No input_type — those
 *                     providers use a single symmetric head.
 *
 * Env vars (same as dagster-quickstart, so a single config source):
 *   EMBEDDING_PROVIDER   = "voyage" | "openai_compat"
 *   EMBEDDING_MODEL
 *   EMBEDDING_API_KEY
 *   EMBEDDING_BASE_URL   (required for openai_compat)
 *   EMBEDDING_DIMENSIONS (must match the pgvector column)
 *
 * No SDK dependency — Voyage and OpenAI-compatible embedding endpoints
 * are both simple POST + JSON and we don't want another package for
 * something this small.
 */

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const EXPECTED_DIMENSIONS = 1024;

export interface EmbeddingConfig {
  provider: "voyage" | "openai_compat";
  model: string;
  apiKey: string;
  baseUrl?: string;
  dimensions: number;
}

export function loadEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "voyage").trim().toLowerCase();
  if (provider !== "voyage" && provider !== "openai_compat") {
    throw new Error(
      `Unsupported EMBEDDING_PROVIDER=${provider}. Expected 'voyage' or 'openai_compat'.`,
    );
  }
  const model = requireEnv("EMBEDDING_MODEL");
  const apiKey = requireEnv("EMBEDDING_API_KEY");
  const dimensions = Number.parseInt(process.env.EMBEDDING_DIMENSIONS ?? "1024", 10);
  if (dimensions !== EXPECTED_DIMENSIONS) {
    // Same guard as the Python provider — fail loud instead of silently
    // returning wrong-length vectors that the SQL cast would then
    // truncate or reject.
    throw new Error(
      `EMBEDDING_DIMENSIONS=${dimensions} does not match the pgvector column ` +
        `dimension (${EXPECTED_DIMENSIONS}).`,
    );
  }
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  if (provider === "openai_compat" && !baseUrl) {
    throw new Error("EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=openai_compat.");
  }
  return { provider, model, apiKey, baseUrl, dimensions };
}

/**
 * Embed a single search query. Returns the raw float vector — the
 * caller formats it as a `'[…]'::vector(1024)` literal at SQL time.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const config = loadEmbeddingConfig();
  const vec =
    config.provider === "voyage"
      ? await embedViaVoyage(text, config)
      : await embedViaOpenAICompat(text, config);
  if (vec.length !== config.dimensions) {
    throw new Error(
      `Embedding provider returned ${vec.length} dimensions; expected ${config.dimensions}. ` +
        `Provider ${config.provider}/${config.model} config may be wrong.`,
    );
  }
  return vec;
}

async function embedViaVoyage(text: string, config: EmbeddingConfig): Promise<number[]> {
  const resp = await fetch(VOYAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: [text],
      model: config.model,
      // Asymmetric embedding: ingest writes with "document", search
      // queries with "query". Same model, different heads. Skipping
      // this on the query side effectively halves recall on Voyage.
      input_type: "query",
      output_dimension: config.dimensions,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage embedding failed: HTTP ${resp.status} ${body.slice(0, 500)}`);
  }
  const payload = (await resp.json()) as { data?: Array<{ embedding: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error(`Voyage embedding response missing data[0].embedding: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return embedding;
}

async function embedViaOpenAICompat(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  const url = `${config.baseUrl!.replace(/\/+$/, "")}/embeddings`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: config.model,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI-compat embedding failed: HTTP ${resp.status} ${body.slice(0, 500)}`);
  }
  const payload = (await resp.json()) as { data?: Array<{ embedding: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error(
      `OpenAI-compat embedding response missing data[0].embedding: ${JSON.stringify(payload).slice(0, 500)}`,
    );
  }
  return embedding;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var ${name}. Set it in .env or export it before running.`);
  }
  return value;
}
