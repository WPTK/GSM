# Stripped in the hardened fork

In short: the browser now talks only to this app's own server. The server holds every key and token, and it reaches
the outside world only through one allowlist (`OUTBOUND_ALLOWLIST`, checked on every redirect). Features that phoned
home, scraped third-party sites, or sent data to hosts a user typed in are gone: the update check, X, Telegram, the
trending and external feeds, Gists, Forks, GitHub Lists, WebDAV, aria2 downloads, the outbound proxy setting and the
plugin system. Nothing in the original app sent data to its maker except the update check, and that is removed.
`npm run check:egress` builds both halves and fails if any host outside `docs/hardening/egress-allowlist.txt` appears.

Upstream is credited: this is a fork of AmintaCCCP/GithubStarsManager under its MIT license.

Format below: item -> files -> reason.

## Stream A

- X (xtweet) relay -> `server/src/routes/xtweet.ts` -> browser-side X integration is removed; the relay fetched arbitrary third-party hosts.
- Telegram relay -> `server/src/routes/telegram.ts` -> same: arbitrary third-party fetches, no remaining caller.
- Auth restore -> `server/src/routes/authRestore.ts`, `server/tests/routes/authRestore.test.ts` -> replaced by the session cookie (`POST /api/auth/session`).
- GitHub raw proxy -> `POST /api/proxy/github-raw` in `server/src/routes/proxy.ts` -> replaced by `GET /api/img` with a host and path allowlist.
- WebDAV proxy and config -> `/api/proxy/webdav`, WebDAV routes in `server/src/routes/configs.ts`, `server/tests/routes/webdavProxyRoute.test.ts` -> user-supplied hosts cannot pass an egress allowlist.
- Outbound proxy settings and SOCKS -> `/api/settings/proxy*`, `ProxyConfig` in `server/src/services/proxyService.ts`, dependency `socks-proxy-agent` -> egress goes direct and is allowlisted.
- RPC download -> `/api/settings/rpc-download*`, `/api/download/rpc`, `server/tests/routes/rpcDownloadSettings.test.ts` -> arbitrary-host download relay.
- WebDAV, proxy, RPC and GitHub token in sync export/import -> `server/src/routes/sync.ts` -> secrets and removed features no longer travel in backups.
- Stored GitHub token and `?decrypt=true` -> `server/src/routes/configs.ts` -> the token comes from `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE`; settings never return or accept it.
- CORS middleware -> `server/src/index.ts`, dependencies `cors`, `@types/cors` -> the app is same-origin only.
- HTML parser and legacy bundle -> dependencies `parse5` (server), `@vitejs/plugin-legacy` (root) -> unused after the above, and the legacy build doubled the shipped code.
- Release and preview workflows -> `.github/workflows/docker-publish.yml`, `docker-publish-frontend.yml`, `docker-publish-fullstack.yml`, `build-desktop.yml`, `ui-preview.yml` -> the fork publishes nothing; CI builds the image without pushing. The `.github/ui-preview/` helper directory is left in place, unused.

## Stream A: known limitations

- Logout does not revoke a session. The cookie is a stateless signed token, so `DELETE /api/auth/session` only clears it in that browser. To revoke every session, rotate `API_SECRET` (the cookie key is derived from it).
- The CSRF check compares `Origin` with `Host`. A front proxy must preserve the original `Host` header, or cookie-authenticated writes get 403 `CSRF_ORIGIN_MISMATCH`.
- `TRUST_PROXY` (default off) is passed to Express `trust proxy`. Accepts `true`, `false`, a hop count, or values such as `loopback` or a CIDR list. Set it when a reverse proxy sits in front, so https detection (the `Secure` cookie flag) and client IPs come from `X-Forwarded-*`. Phase 4 (deployment) must decide the value.
- Outbound requests need https on the default port, and the host must be on the allowlist. A local AI endpoint on http or a non-443 port (for example Ollama on 11434) is not reachable until it sits behind an https front on 443.
- The legacy `proxy_config` and `rpc_download_config` settings rows are deleted by migration v4 and never served or exported.

## Stream C

Format: item -> files -> reason. Reason for every row unless stated: owner decision, Phase 2 (reduce egress and attack surface).

- Update check -> `src/services/updateService.ts`, `src/components/UpdateChecker*`, `UpdateNotificationBanner`, banner mount in `App.tsx`, "check update" text in `GeneralPanel.tsx`/`MenuManagementPanel.tsx` -> phones home to a third-party release feed.
- X/Twitter -> `xTweet*` services, components, utils, X auth restore effect in `App.tsx`, X functions in `electronProxy.ts`, `x-auth.enc` clearing in `DataManagementPanel.tsx`, author x.com button in `GeneralPanel.tsx` -> scraping with user cookies.
- Telegram -> `telegram*` services and components, `electronProxy.ts` Telegram functions -> scraping public pages.
- mshibanami trending, trending snapshots, TrendingHistoryPanel, snapshot capture hooks -> Discover `trending` channel and subscription trending; default channel is now `hot-release`. The `topic` channel with no topic selected now returns an empty result (it used to call the trending scraper).
- External discovery feeds and scrape support -> `externalDiscoveryFeed`, `scrapeSupport`, `ExternalDiscoveryFeedsModal`, `external:` channel handling in `DiscoverySidebar`/`DiscoveryChannelMenu`/`DiscoveryView` -> arbitrary third-party feed fetches.
- Gists -> `src/features/gists`, Gist components, `gistSlice.ts`, `gists.json` in all 10 locales, `gists` entry in `I18N_NAMESPACES` (`scripts/check-i18n.cjs`, `src/i18n/index.ts`), `analyzeGist`/`searchGistsWithReranking` in `aiService.ts` (prompt snapshot regenerated), gist methods in `githubApi.ts`.
- Forks view -> `src/features/forks`, Fork components, `syncFork`/`triggerWorkflowRun` in `githubApi.ts` -> write access to the user's repos; read list not separable.
- GitHub Lists -> `githubListsApi.ts`, Lists factory in `githubApiFactory.ts`, `ListsPushIndicator`, Lists push in `CategoryEditModal.tsx`, `SearchBar.tsx`, `useSearchActions.ts` (star sync now stars only: `syncStars()`).
- Star-sync settings panel and sync mode -> `StarSyncPanel`, `useStarSyncActions`, `SyncModeChoiceModal`, `starSync` settings tab (beyond the plan's tab list, because it only configured Lists). Star sync itself is kept.
- WebDAV -> `webdavService.ts`, `BackupPanel`, `WebDAVPanel`, `useBackupActions`, webdav parts of `autoSync.ts`, `backendAdapter.ts` (proxyWebDAV, sync/fetchWebDAVConfigs; minimal cut, stream B owns the file), `useBackendSettingsActions.ts`, `DataManagementPanel.tsx`, `webdav` log module, locale strings.
- OAuth helper in `githubApi.ts` -> unused.
- VectorSearchSettings UI -> component, `vectorSearch` settings tab. `useVectorSearchActions(.test)` is orphaned and left in place; services stay (Phase 6).
- Settings tabs cut -> `webdav`, `backup`, `network`, `vectorSearch`, `plugins`, `starSync` in `SettingsPanel.tsx`; `settings/index.ts` no longer exports WebDAVPanel, BackupPanel, StarSyncPanel, VectorSearchSettings, NetworkPanel, PluginSettingsPanel. `PluginPageHost` mount removed from `App.tsx`. Stream B deletes the NetworkPanel and plugin files.
- Store and types -> feature fields and actions removed from `types/index.ts`, `store/types.ts`, `initialState.ts`, `schema.ts`, slices, `selectors.ts`, `helpers/accountWorkspace.ts`. Hydration: `REMOVED_PERSISTED_KEYS` in `normalizers/persistedState.ts` drops stale keys; removed discovery channels are rebuilt from the six defaults, a stale selected channel falls back to the first enabled one, subscription channels are filtered to known ids, a removed `currentView` falls back to `repositories`, removed theme preset ids fall back to the default.
- Persistence shard set -> `gists`, `forks`, `trendingSnapshots` shards removed. `parseMeta` needs an exact shard-set match, so an existing meta is rejected on first load and data comes back through the legacy/orphan-shard salvage path (logs an error once). Store version stays 16.
- Left for stream B (store fields and actions kept so B's files compile) -> `proxyConfig`, `rpcDownloadConfig`, `routeMode`, `backendApiSecret`, `pluginCustomIcons` and their setters. B removes them after rebasing onto C.
- Themes -> presets `autoblog` and `claude` removed (`tweakcn-presets.json`, `themePresets.ts`, regenerated `themePresets.generated.ts`, 9 presets remain). Accent swatches `#ea580c` -> `#0d9488` (teal), `#ca8a04` -> `#4f46e5` (indigo) in `themeTokens.ts`; locale keys `themeSettingsCard.color-orange`/`color-yellow` renamed `color-teal`/`color-indigo`.
- Locales -> 420 removed-feature keys pruned in all 10 locales (found by diffing string-literal key references against `hardened`; dynamic template keys were not touched). `includeKeysToggle` text no longer mentions WebDAV, proxy or remote download (key renamed `includes-keys-for-ai-configs`). `header.menu-gists`, `backendPanel.webdav-configurations`, `discovery telegram` removed. 5 new keys added with real translations: `markdown.load-images`, `markdown.images-blocked`, `login.api-secret`, `backendPanel.github-connected`, `backendPanel.github-not-configured`.
- Tests and fixtures -> tests for removed features deleted or trimmed; `ai-prompts.snapshot.json` regenerated; two new hydration tests in `useAppStore.modularization.test.ts`.
- Leftover grep (`xTweet|telegram|Gist|syncFork|webdav|mshibanami|updateService|externalDiscovery|githubLists`, case-sensitive, `src`) -> remaining hits are intentional: `REMOVED_PERSISTED_KEYS` and its hydration test (stale-key filter), and GitHub token-permission descriptions mentioning "gists" in `login.json` (a GitHub scope name, not the feature). `scripts/codemods/i18n-migrate.mjs` still maps a `gists` namespace (one-shot migration tool, not run in CI).

## Stream B

The browser stores no GitHub token or API secret and calls only its own origin. It authenticates with the HttpOnly `gsm_session` cookie (login `POST /api/auth/session`, status `GET /api/auth/status`, logout `DELETE /api/auth/session`).

Removed:

- Whole plugin system (client, registry, page host, card actions, settings tab) and the aria2 / RPC download client.
- Browser-side GitHub tokens and every direct `api.github.com` path; the OAuth, token-paste and token-permission UI; `routeMode` and `backendUrl` (the backend is always `/api`).
- Store fields `githubToken` (persisted), `backendApiSecret`, `proxyConfig`, `rpcDownloadConfig`, `routeMode`, `pluginCustomIcons` and their setters, shard entries, backup export/import and the `authStorage` localStorage/sessionStorage mirror. Persist version 17 drops them from old snapshots; hydration and logout erase the two legacy storage keys.
- The Network settings panel and the direct-egress fallbacks in translate and code search.

Added:

- `src/utils/imageProxy.ts`: GitHub-hosted images load from `/api/img`. Other hosts are blocked per README until the reader presses "Load images".
- Translate goes through `/api/translate/:engine` and code search through `/api/codesearch`; GitHub goes through `/api/proxy/github`.
- Login by API secret only (`loginWithApiSecret`); the secret is sent once and never kept. `githubToken` in the store is only ever the placeholder `server`, set when `/api/auth/status` reports a session.
- Tests: no secret persisted, `githubToken` only ever `server`, v17 migration, legacy storage purge.
- One sign-out path (`logoutSession()`): every logout button calls `DELETE /api/auth/session` and clears local state. If the
  cookie is missing or expired, the app signs out and shows "session expired" instead of staying on a broken screen.
- Microsoft translate batches are split by UTF-8 size to stay under the server's 64 KiB relay limit (a test keeps the two
  limits equal).
- `github.com/.../blob/...` image links are rewritten to `/raw/` so they load through `/api/img`.

Known limitation carried to Phase 3, now closed there: AI provider keys in browser storage (see Phase 3 below). The
"include keys" backup toggle still exists by owner decision; see the Phase 3 note on what it covers.

## Phase 3 (Claude on the server)

Claude is the only AI provider. The Anthropic key and both model IDs live on the server (`ANTHROPIC_API_KEY`, `CLAUDE_MODEL_BULK`, `CLAUDE_MODEL_CHAT`); the browser sends a `purpose` and never a key, base URL or model. Format: item -> files -> reason.

Client:

- Provider transport and provider presets -> `AIService` in `src/services/aiService.ts` now posts to `/api/ai/messages` only (OpenAI, Gemini, Claude-direct, reasoning-effort and base-URL code paths deleted) -> one provider, one server-held key.
- Bulk analysis engine -> `src/services/aiAnalysisOptimizer.ts(.test)`, `src/services/aiAnalysisHelper.ts` -> replaced by `src/services/claudeJobs.ts` (estimate, confirm, job, poll, cancel on the server). Pause/resume is gone: the server has no pause.
- AI config UI and logic -> `AIConfigPanel(.test)`, `src/constants/aiCapabilities.ts`, `useAIConfigActions.ts`, the `AIConfig` type and its store fields and setters, the AI parts of `autoSync.ts`, `proxyAI*`/`syncAIConfigs`/`fetchAIConfigs` in `backendAdapter.ts` -> nothing to configure in the browser.
- Native tool-call capability probe and the "endpoint rejects tools" fallback -> `isAIToolCallUnsupportedError`, `supportsChatToolCalls`, the "supports tool calls" flag -> Claude always supports tool use.
- Added -> `settings/ClaudePanel.tsx` (status, key suffix, both models, cache-skipped note, editable custom analysis prompt via `PUT /api/ai/settings`), `CreditLowBanner` (app-level), `useClaudeStatus`, `useClaudeSpendConfirm`, `claudeClient.ts`, `claudeJobs.ts`, `claudeContract.ts`. Every AI call site is gated on `useClaudeStatus().connected`.
- Persist version 18 -> `aiConfigs` and `activeAIConfig` are in `REMOVED_PERSISTED_KEYS` and dropped by the v17 to v18 migration, so no provider key stays in browser state. Browser-only `aiConfigs` are dropped; the server-side `ai_configs` rows stay untouched (the old autoSync used to push them there).
- Backup export -> the in-browser export no longer writes `aiConfigs` (nothing to write). Importing an old backup that contains `aiConfigs` ignores it entirely: the preview no longer lists it and the old "some secrets are masked" warning is gone. The "include keys" toggle (`IncludeKeysToggle`) is kept as is by owner decision; with no keys in the browser it now only records the flag in the file. A test checks the export holds no `aiConfigs` or `apiKey` even with the toggle on.
- Locales -> about 12 new `claudePanel.*`, `creditBanner.*`, `spendConfirm.*` keys with real translations in all 10 locales; the removed AI-config keys are deleted. No orange in any new color.
- Egress allowlist -> `[pending-phase-3]` removed; `api.deepseek.com`, `api.xiaomimimo.com`, `token-plan-cn.xiaomimimo.com`, `integrate.api.nvidia.com` dropped; `api.openai.com`, `api.cohere.com`, `generativelanguage.googleapis.com`, `api.siliconflow.cn` moved to `[pending-phase-6]` because `server/src/mcp/provider.ts` (embeddings) still names them; `platform.claude.com` added under link-outs (source URL recorded in `pricing.json`, never fetched).

Server:

- removed POST /api/proxy/ai (+ helpers) and /api/configs/ai* routes.
- NOT removed per owner: the `ai_configs` table, the `activeAIConfig` setting, and sync masking/import of `ai_configs`; the server just stops reading and serving them. Old saved AI configs are never deleted.
- v5 adds `ai_jobs`, `ai_job_items` and `ai.customAnalysisPrompt` (copied read-only from the active config).
- `ai.state` is excluded from /api/settings and sync.
- repositories upsert overwrites AI fields only when the incoming `analyzed_at` is newer.
- startup refuses a `CLAUDE_MODEL_BULK` with no `pricing.json` entry.
- estimates are kept in memory for 30 minutes (client: `AI_ESTIMATE_NOT_FOUND` => re-estimate).

Backup export masking (for the owner): `POST /api/sync/export` always masks `ai_configs` keys (`***` plus the last 4 characters, ciphertext deleted) whatever the toggle says, so the toggle text was reworded to "Includes the backend server's keys" (all 10 locales). The last four characters of each AI config key still leave the server in an export.

## Phase 4 (deployment)

Format: item -> files -> reason. Reason for every row unless stated: owner decision, Phase 4 (one hardened container on CERES).

- Upstream compose files -> `docker-compose.yml`, `docker-compose.fullstack.yml` -> pulled `ghcr.io/amintacccp` images and published ports on all interfaces; replaced by `deploy/compose.yaml`, which builds from local source and binds `127.0.0.1` only.
- Split frontend image and its nginx config -> `Dockerfile`, `nginx.conf.template`, root `.dockerignore` -> only the two-container upstream deployment used them; the kept build uses `Dockerfile.fullstack` and `Dockerfile.fullstack.dockerignore`. `server/Dockerfile` (standalone backend image) is in the server tree and is left for the server worker.
- No registry images pulled or published -> `DOCKER.md` rewritten, `DOCKER_zh.md` reduced to a pointer, Docker sections of `README.md` and `README_zh.md` replaced with a "Hardened fork" section -> every reference to `ghcr.io/amintacccp` removed; `scripts/fullstack-compose-env.test.cjs` now fails if one comes back. Historical text in `versions/version-info.xml` (release notes) is left as is.
- Base images -> `Dockerfile.fullstack` -> `node:22-alpine` pinned by index digest (fetched 2026-11-09) on all three stages; `HEALTHCHECK` added (node probe of `GET /api/health`).
- `ENCRYPTION_KEY` fallback file -> server `data/.encryption-key` is no longer generated (server worker owns the code) -> secrets come only from the environment or `*_FILE`; `deploy/.env.example` tells a migrating install to copy the old file value into `ENCRYPTION_KEY`.
- Fail-closed startup -> server worker owns the code -> `API_SECRET`, `ENCRYPTION_KEY`, `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are required; compose also refuses to start without them (`${VAR:?}`, no defaults).
- Startup needs internet -> the server calls the Anthropic Models API at startup -> owner accepted; the healthcheck start period is 30 s for this.
- Memory limit -> `deploy/compose.yaml` -> `mem_limit: 1g` is a starting guess; measure with `docker stats` after the first start and adjust.
- `TRUST_PROXY` decided -> `uniquelocal` default in `deploy/compose.yaml` (closes the "Phase 4 must decide" note in Stream A) -> needed for the `Secure` cookie behind `tailscale serve` through Docker's bridge; safe only because the port is published on loopback.
