# Talky – Design

## How it works

Talky is a Node ≥20 HTTP server (`server.js`) and a thin browser client (`app.js`).  
The agent has exactly one tool: **Google Search grounding** via Gemini 2.5 Flash.

### Request lifecycle

1. The browser posts to `POST /api/chat/stream`.
2. The server retrieves cross-conversation memory, assembles a system prompt with that context, and calls Gemini's **streaming** `generateContent` endpoint (`alt=sse`).
3. Token deltas are forwarded to the browser as Server-Sent Events as they arrive—the first words appear within ~1 s instead of after a 30–90 s blank wait.
4. When the stream closes, the server sends a final `done` event carrying grounding citations and extracted entities. The assistant message is persisted atomically to `data/talky.json`.

### Memory

Every user and assistant message is stored with its UTC timestamp and the user's IANA timezone. On each new turn the server runs a retrieval step:

- **Date-first path**: if the query mentions "last Tuesday", "3 November", "last week", or "N days ago", only exchanges from that date/range are candidates. This prevents a superficially similar exchange from another week from displacing the exact dated one.
- **Scoring**: Jaccard token overlap + a recency half-life of 7 days + a small bonus for the active chat. Stopwords are removed before scoring.
- Up to 7–10 retrieved pairs are injected as `MEMORY` in the system prompt, alongside the last 8 turns of the current conversation.
- Each assistant message stores **extracted entities** (prices, product names) so "has the pricing changed?" has explicit old values in the retrieved context rather than relying on the model to reconstruct them from prose.

The model is instructed to compare the saved answer with fresh search results, state what changed and what stayed the same, and to say clearly when no matching memory is found rather than guessing.

### Security

- The static-file handler blocks dotfiles, `data/`, and any path segment beginning with `.` before path resolution—`/.env`, `/data/talky.json`, and `/.git/` return 403.
- An in-flight set prevents duplicate concurrent Gemini calls for the same conversation.
- API keys never reach the browser.

### Reliability

- Gemini 429 and 5xx responses are retried up to 3× with exponential back-off (1 s, 3 s, 7 s), honouring `Retry-After` headers.
- The `--watch` flag in `npm run dev` falls back to a plain `node server.js` if the kernel lacks sufficient file-watcher resources.
- Persistence uses an atomic write-then-rename pattern to avoid partial JSON files on crash.

---

## Why this design

**Memory needs timestamps, not just content.**  
Storing `createdAt` and timezone on every message makes the benchmark test cases—"what did I ask on 3 November?", "is that still correct?"—trivially auditable. Date filtering runs before relevance scoring; no semantic similarity can override an exact date match.

**One bounded request, not a tool loop.**  
Gemini's native `googleSearch` grounding integrates retrieval and synthesis in a single call. This keeps latency predictable and avoids the extra round-trips of an agentic tool loop.

**Streaming for perceived speed.**  
The hardest UX problem with grounding-augmented LLMs is that the model must finish searching before it can start writing. Streaming the token output means users see words within ~1 s and can read while the model is still generating, making the 10–20 s end-to-end latency feel far shorter.

**Lexical retrieval without embeddings.**  
A Jaccard token overlap with recency decay is sufficient for a single-user prototype with hundreds of messages. It needs no additional model, vector database, or cold-start data. The design notes where embeddings would become worthwhile (paraphrase-heavy histories, > ~1 k conversations).

**Server-side entity snapshots.**  
The `extractEntities` function snapshots prices and product names from every assistant response without an extra LLM call. These structured values travel with the retrieved memory context, giving the model explicit "old price: \$29/mo" data points rather than asking it to re-read prose.

---

## What I considered and rejected

| Option | Why rejected |
|---|---|
| Send the entire message archive on every turn | Latency and token cost grow with history; unrelated context degrades answer quality |
| Embeddings + vector store | Another service, model dependency, and cold-start failure mode before there is enough data to justify it; lexical overlap is measurably adequate at this scale |
| A second "memory tool" | The challenge limits the agent to one tool; server-side retrieval delivers memory as context, adding no tool round-trip |
| Home-grown search scraper | Duplicates Gemini's ranking and citation work; brittle to HTML changes |
| Provider-managed conversation state | Does not give the application timestamp-queryable records across chats or preserve citation provenance |
| OpenAI / other providers | Gemini's native `googleSearch` grounding returns citations in the same call; no separate search API key or rate limit to manage |

---

## What I would do with another week

1. **Evaluation harness**: A fixed dataset of ~30 questions covering exact-date recall, weekday recall, follow-up entity recall (e.g. "those five tools"), pricing-change comparisons, citation support, and "no match" honesty. Measure recall@1, citation hit-rate, and p50/p95 answer latency before and after every change.
2. **Hybrid retrieval**: Add an embedding layer (e.g. `@google/generative-ai` `embedContent`) only if evals show meaningful misses on paraphrased or cross-topic follow-ups. Keep the timestamp index for exact-date queries.
3. **SQLite backend**: Replace the flat JSON file with SQLite (`better-sqlite3`). Index `(chat_id, created_at)` for fast time-range queries and `(role, created_at)` for retrieval; use transactions for atomic writes.
4. **Search freshness signal**: Store the `groundingMetadata.searchEntryPoint` and snippet publication dates. Expose a "sources from: Jan 2025" note in the UI so the user can judge whether the web evidence is recent enough.
5. **Observability**: Log per-turn latency, token counts, Gemini model version, and grounding-chunk count. Tune the retrieved-pair count and `maxOutputTokens` against eval scores rather than intuition.

---

## Run it

```
cp .env.example .env
# add your GEMINI_API_KEY (free at https://aistudio.google.com/app/apikey)
npm install   # zero third-party runtime packages
npm run dev   # http://localhost:3000
```

Requires Node 20 or later. No database setup required.
