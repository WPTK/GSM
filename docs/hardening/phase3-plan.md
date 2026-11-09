# Phase 3 plan: Claude through the owner's API key

Brief for the Phase 3 session. Read `PROMPT.md` (How to work with me, Hard rules, Phase 3) and `STRIPPED.md` first.
Baseline: branch `hardened` at c435e17e.

## Decisions (coordinator defaults; the owner may override)

1. Never delete user data on upgrade. Migration v5 does NOT drop `ai_configs` or the `activeAIConfig` row: the
   server stops reading and serving them, the rows stay on disk untouched. (Owner decision 2026-11-09.)
2. Keep the "include keys" backup toggle as it is. (Owner decision.)
3. Keep the custom analysis prompt. Move it to a server setting (`ai.customAnalysisPrompt`), migrated from the active
   config's custom prompt if one exists, editable in the new Claude settings panel, and used in the analysis prompt
   prefix. (Owner decision.)
4. Search, rerank, translate and release summaries use `CLAUDE_MODEL_BULK`; chat and tools use `CLAUDE_MODEL_CHAT`.
5. If the cache prefix is below the model's minimum, skip caching and report it; do not pad the prompt.
6. Fail-closed for `API_SECRET`, `ENCRYPTION_KEY`, `GITHUB_TOKEN` stays in Phase 4. This phase fails closed on `ANTHROPIC_API_KEY` and the two model IDs only.
7. Step 8 of Phase 3 (dry-run estimate on the real star count, real 3-repo analysis) costs real money: the coordinator runs it with the owner's go, after the key is placed at `C:\Users\billp\.gsm\anthropic_api_key` (read via `ANTHROPIC_API_KEY_FILE`). Workers never call the real API; tests use a fake SDK client.

## Current state (file map)

- All AI calls go through `src/services/aiService.ts` (3263 lines). Transport: `requestTextResult` :557,
  `requestText` :1201, `requestTextStream` :955, `generateWithTools` :1343. Each either uses
  `backend.proxyAIRequestWithFallback` (:634, :772, :877, :1419) or a direct provider `fetch` (:636, :774, :879,
  :1059, :1432), already blocked by `connect-src 'self'`. Provider parsing :251-338. Streaming bypasses the backend.
- Callers: analysis `useRepositoryAnalysisJob.ts:224` + `aiAnalysisOptimizer.ts:276`, `aiAnalysisHelper.ts:34,57`,
  discovery `useDiscoveryActions.ts:369`; chat `chat/loop.ts:342,451,911`, `agentToolLoop.ts:168,625`,
  `useRepositoryChat.ts:463`; search `useSearchActions.ts:169-170`, `semanticRepoSearchService.ts:261,710,839`,
  `useDiscoveryActions.ts:172`; release summary `useReleaseArtifactActions.ts:88`; translate
  `translateService.ts:364,374`; connection test `useAIConfigActions.ts:30`; similar repos
  `useRepositoryCardActions.ts:323` + `similarRepositoryPipeline.ts:417,511`; vector `useSearchActions.ts:257` +
  `vectorSearchPipeline.ts:639,757`.
- Server: `POST /api/proxy/ai` (`server/src/routes/proxy.ts:178-295`) takes `configId` or inline
  `{baseUrl, apiKey, model}`. `ai_configs` CRUD `routes/configs.ts:213-290`; table `db/schema.ts:74,146-147`; sync
  export masks keys (`routes/sync.ts:40-72`), import keeps them (:311-315); types `server/src/types/api.ts:60,121-151`.
  MCP makes no LLM calls (only embeddings in `mcp/provider.ts:302-343`, Phase 6). Migrations at v4.
  `server/tests/services/noDirectEgress.test.ts` forbids `fetch(` outside `proxyService.ts`.
- Store: `AIConfig` type `src/types/index.ts:241-259`; `configurationSlice.ts:23-36`; `initialState.ts:31-32`;
  persisted `persistence/options.ts:39-40` (v17 at :22), `persistence/shards.ts:47-48`; `selectors.ts:113`; sync in
  `autoSync.ts:253,385-399,447,573-609,684-687` and `backendAdapter.ts:551-695`; backup in
  `DataManagementPanel.tsx:164,185,251,286,396-400,579-596`, `includeKeysInBackup` (`shards.ts:87`,
  `IncludeKeysToggle.tsx`).
- Settings: `AIConfigPanel.tsx` (tab `'ai'`, `SettingsPanel.tsx:32,347,397-398`), `constants/aiCapabilities.ts`,
  `useAIConfigActions.ts`.
- Locales (all 10): `app.json` `aIConfigPanel` (104 keys), `includeKeysToggle` (2), AI parts of
  `dataManagementPanel`; `settings.json` `useAIConfigActions` (2).
- Tests tied to AIConfig: `aiService*.test.ts`, `aiPromptFixtures.test.ts` (+ `ai-prompts.snapshot.json`),
  `aiAnalysisOptimizer.test.ts`, `AIConfigPanel.test.tsx`, and about 25 tests building `aiConfigs` fixtures.
- Egress: `[pending-phase-3]` in `docs/hardening/egress-allowlist.txt:43-52`; some hosts are still referenced by
  embedding code (`embeddingApiTypes.ts`, `crossEncoderReranker.ts`, `vectorSearchService.ts`, `mcp/provider.ts`).
- Embeddings: separate `embedding_configs`. HyDE, query analysis and rerank use AIService with the chat config; they
  move automatically if AIService keeps its method signatures. Phase 6 code is not touched.

## Stream S: server (`server/**`, `server/package*.json`)

New `server/src/ai/`:
1. `claudeConfig.ts`: `ANTHROPIC_API_KEY` or `_FILE` (same pattern as `services/githubToken.ts`),
   `CLAUDE_MODEL_BULK` (default `claude-haiku-5-5`), `CLAUDE_MODEL_CHAT` (default `claude-sonnet-5-5`),
   `AI_SPEND_CONFIRM_USD` (default 2.00). `keySuffix()` returns the last 4 characters only.
2. `client.ts`: `@anthropic-ai/sdk` with `fetch: guardedFetch` (new export in `proxyService.ts`: allowlist check,
   then fetch, so `noDirectEgress` holds) and a fixed baseURL. SDK `maxRetries` handles 429/529 and retry-after.
   `setAnthropicClientForTests` injects a fake.
3. `startup.ts`: `startServer` (`index.ts:159`) awaits `validateModels()` (`models.retrieve` for each ID) before
   `listen`; missing key or model logs one clear line and exits 1. `createApp` stays sync.
4. `prompts.ts`: analysis prompts ported from `aiService.ts:1510-1530` with language variants. Prefix = shared
   instructions + category list from `categories`.
5. `schema.ts`: zod `{summary, tags[], platforms[]}`; JSON schema via `z.toJSONSchema`.
6. `analyze.ts`: structured output via `output_config.format` if current docs confirm both models support it,
   otherwise forced tool use. Pick one, no runtime fallback. Invalid output: one retry, then the item fails.
7. `cache.ts`: `cache_control` on the prefix only when `countTokens(prefix)` >= model minimum (kept in the pricing
   file); otherwise record `{cache:"skipped", prefixTokens, minTokens}` on the job.
8. `pricing.json`: per-model input/output/cache-write/cache-read rates, batch discount, `checkedAt`. Copy from
   Anthropic's pricing page on the day; never guess.
9. `estimate.ts`: prefix counted once + per-repo heuristic (metadata + README at the truncation cap) + fixed output
   budget, labelled an upper bound.
10. `jobs.ts`, `batchPoller.ts`: <=20 repos direct (concurrency 4); >20 via `messages.batches.create`
    (custom_id `repo-<id>`). Batch id in SQLite, poll every 60 s, results via `batches.results()`. On boot every
    `submitted` job resumes polling, never resubmits. Server fetches READMEs with `proxyRequest` + `getGithubToken`
    and writes results to `repositories`.
11. `creditState.ts`: a 400 containing "credit balance is too low" sets `ai.state=credit_low` in `settings`, pauses
    jobs, relay returns 503 `AI_CREDIT_LOW`. Daily 1-token probe; success clears the state and resumes jobs.

Routes (`server/src/routes/ai.ts`, cookie auth, zod `.strict()`; contract in `server/src/ai/contract.ts`):
- `GET /api/ai/status` -> `{connected, keySuffix, models:{bulk,chat}, state:'ok'|'credit_low', since?, nextCheckAt?, cache?}`
- `POST /api/ai/messages` `{purpose:'chat'|'tools'|'search'|'translate'|'release-summary', system, messages,
  tools?, maxTokens, temperature?, stream?}`. Purpose picks the model; `model`/`baseUrl` in the body -> 400;
  maxTokens capped per purpose. Reply `{text, toolCalls?, usage, stopReason}`. With `stream:true`:
  `text/event-stream` from `messages.stream()`, frames `delta {text}`, then `done {usage, stopReason}` or
  `error {code}`; `flushHeaders`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`; client disconnect aborts.
- `POST /api/ai/analysis/estimate` `{repoIds | repos, language}` -> `{estimateId, repos, inputTokens, outputTokens,
  usd, batch, needsConfirm, cache}`. Non-starred discovery repos pass `repos:[...]`; results returned, not written.
- `POST /api/ai/analysis/jobs` `{estimateId, confirmed?}`; `needsConfirm` without `confirmed` -> 409 (server-side guard).
- `GET /api/ai/analysis/jobs/:id`, `POST /api/ai/analysis/jobs/:id/cancel`.

Also: migration v5 (`ai_jobs`, `ai_job_items`, `ai.customAnalysisPrompt` setting; `ai_configs` rows left untouched); remove
`/api/proxy/ai`, `/api/configs/ai*`, `ai_configs` in sync export/import and types. `repositories.ts` upsert: AI
fields overwrite only when `excluded.analyzed_at > repositories.analyzed_at`, so autoSync can't wipe server results.

## Stream C: client (`src/**`, root package files, `egress-allowlist.txt`, `STRIPPED.md`)

- `AIService`: keep the public methods, constructor becomes `new AIService(language)`, transport is
  `/api/ai/messages` (reuse `consumeSseStream`, fetch + ReadableStream). Delete apiType branches, provider
  extractors, `testConnection`, `supportsChatToolCalls`, `analyzeRepository` (the custom prompt moves to the server).
- Analysis: delete `aiAnalysisOptimizer.ts`, `aiAnalysisHelper.ts`; new `claudeJobs.ts` (estimate -> confirm dialog
  when `needsConfirm` -> job -> poll -> `updateRepository`). Callers: `useRepositoryAnalysisJob`, discovery, card.
- Gate call sites on `useClaudeStatus().connected` instead of `activeAIConfig`.
- Delete `AIConfigPanel(.test)`, `aiCapabilities.ts`, `useAIConfigActions.ts`, `AIConfig` type/fields/setters,
  `backendAdapter` `proxyAI*`/`syncAIConfigs`/`fetchAIConfigs`, AI parts of `autoSync`, `aiConfigs` in
  DataManagementPanel. Keep the include-keys toggle.
- Persist v18: add `aiConfigs`, `activeAIConfig` to `REMOVED_PERSISTED_KEYS`; drop from the shard set.
- `settings/ClaudePanel.tsx` on tab `'ai'`: "Claude connected, key ending in xxxx", both models, cache-skipped note.
  App-level `CreditLowBanner` from `/api/ai/status`.
- Locales: delete the keys above; add about 12 (`claudePanel.*`, `creditBanner.*`, `spendConfirm.*`) with real
  translations in all 10 locales. No orange in any color.
- Remove `[pending-phase-3]`; move hosts still found by embedding code to `[pending-phase-6]`. Add Phase 3 removals
  to `STRIPPED.md` (S's lines come from its report).

## Tests (no real API calls)

Server (fake SDK client): key from env and `_FILE`; missing key exits; missing model refuses start; status shows at
most 4 key characters; purpose picks the model; `model`/`baseUrl` -> 400; maxTokens cap; SSE frame order and abort;
zod failure -> one retry -> fail; 20 direct vs 21 batch; restart resumes (`retrieve`, not `create`); cache skipped
below minimum; 409 without confirm; credit-low pause, daily recheck (fake timers), resume; retry-after; v5 migration;
export has no AI keys; v5 leaves `ai_configs` rows intact; custom prompt reaches the prefix; `guardedFetch` rejects off-list hosts; `noDirectEgress` green. Prompt snapshot moves to
`server/tests/ai/prompts.snapshot.json`.
Client (mocked fetch): transport and SSE parsing, ClaudePanel, banner, v18 hydration, backup has no `aiConfigs`,
ported fixtures.

## Order and verification

S first, then C on top of S (until C lands the old client gets 404s). C may be a 2-layer stack: transport and jobs,
then UI, locales and deletions. One `reviewer` pass per layer; `reviewer-deep` once on the final head (keys and auth).
Gates before the report: `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run check:i18n`,
`npm run check:egress`, server tests. `rg -i "aiConfig|proxy/ai|apiKey" src server/src` shows only intentional hits.
Rollback: revert C, then S; v5 only adds tables, so an older build still runs on the same data.db.
