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

Known limitations, deferred to Phase 3 (AI):

- AI provider configs (`aiConfigs`) still hold their API keys in browser storage. That is outside this stream's scope and needs a server-held-key design.
- Backup export with "include keys" still carries AI and embedding keys.
- Locale keys left unused by the removals are not pruned here beyond what Stream C did.
