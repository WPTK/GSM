# Phase 1 audit: GithubStarsManager for a private homelab

**Audited commit:** `c2332ed4` (upstream `AmintaCCCP/GithubStarsManager`, `main`, 2026-11-08, "Merge pull request #577", version 0.9.0, MIT).
**Branch:** `hardened`, created from `upstream/main` at that commit.
**Fork:** `WPTK/GSM`. Your prompt says `WPTK/GithubStarsManager`, but GitHub has no repository by that name; `WPTK/GSM` is the fork of upstream.
**Where the work happens:** the clone is on GILEAD at `C:\Users\billp\projects\GSM`. CERES only needs a clone in Phase 4, to build and run the container.

Line numbers refer to `c2332ed4`. Nothing under `src/`, `server/` or the other source folders was changed in this phase.

---

## 1. Plain-language summary

- **Nothing hidden.** I found no code that quietly sends your data somewhere you didn't set up, no analytics or tracking SDK (a library whose job is to report usage), and no obfuscated (deliberately scrambled) code. The app is a normal open-source project, so the recommendation is to **keep the fork**.
- **Your scan was right on 11 of 13 items.** It was partly wrong on two details and missed some things. The misses are below; three of them matter:
  1. **README translation goes to Microsoft or Google.** Clicking "translate" on a README sends its text to `edge.microsoft.com` (the default) or `clients5.google.com`, with no account.
  2. **Code search goes to grep.app**, a third-party search site, straight from the browser.
  3. **The GitHub token lives in the browser today**, in plain text in localStorage (the browser's long-term storage for a website). The server also has a route that hands the decrypted token back to any caller. With no `API_SECRET` set, anyone on the network can read your token. That breaks Hard rule 3, and Phases 2 and 3 have to fix it.
- **The app is built around the browser.** Star sync, AI analysis and release checks are all code that runs in the open browser tab; the server mostly stores data and passes requests through (a "proxy"). Phases 3 and 5 move that work to the server. That is the biggest job in the plan, but it is still smaller than a rewrite.

---

## 2. Your 13 items, checked

| # | Your claim | Verdict | Evidence and corrections |
|---|---|---|---|
| 1 | Update check phones home on every page load | **Confirmed** | `src/App.tsx:221` calls `useAutoUpdateCheck()`. `src/hooks/useAutoUpdateCheck.ts:34` runs it 3 s after load. `src/services/updateService.ts:13` fetches `https://raw.githubusercontent.com/AmintaCCCP/GithubStarsManager/main/versions/version-info.xml` (owner from `src/constants/project.ts:1`). There's no setting to turn it off. Your version number isn't sent (it is compared locally, `:49`), but GitHub sees your IP and browser. It also feeds `UpdateChecker.tsx` (mounted at `settings/GeneralPanel.tsx:52`), `UpdateNotificationBanner.tsx` (`App.tsx:352`), `features/settings/hooks/useUpdateActions.ts`, store fields `updateNotification` (`store/initialState.ts:88`, `slices/preferenceSlice.ts:23,73`) and i18n keys `updateChecker`/`updateNotificationBanner`. |
| 2 | X scraping with session cookies | **Confirmed, and wider than described** | `server/src/routes/xtweet.ts:25` hardcodes X's public web-client bearer token. `:87` sends `auth_token` and `ct0` as cookies. Also missed: (a) a route with no login, `GET /api/xtweet/profile/:handle` (`:31`), that scrapes `x.com/<handle>`; (b) the X channel is **on by default** with a seeded follow (`src/utils/xTweetFollows.ts:10`) and fetches whenever the Discover tab opens; (c) Electron copies at `electron/main.js:494,684-720` also call `api.x.com/1.1/guest/activate.json`. Cookies are kept in memory only (never in localStorage or the database, `store/persistence/options.ts:170`). |
| 3 | Telegram channel scraping | **Confirmed** | `server/src/routes/telegram.ts:31` fetches `https://t.me/s/<channel>`. On by default with a seeded follow (`src/utils/telegramFollows.ts:10`). No credentials involved. |
| 4 | Third-party trending feed | **Confirmed** | `src/services/githubApi.ts:1989-1991` (Discover "Trending", the default tab) and `:1786` (Subscriptions "Trending") fetch `mshibanami.github.io/GitHubTrendingRSS` **straight from the browser**, even when a backend exists. The CSP (Content-Security-Policy, the browser's list of sites a page may contact) allows it on purpose (`server/src/index.ts:40`). The other Discover channels (hot releases, most popular, topics, search, weekly) use GitHub's own API. |
| 5 | Vector search through Cloudflare and outside embeddings | **Confirmed, off by default** | Off unless configured (`store/schema.ts`: `enabled: false`). When on, the browser sends repo text, including up to 6,000 characters of README (`src/services/vectorSearchService.ts:341-390`), to an embedding provider: OpenAI, Gemini, Cohere, SiliconFlow, Ollama or a custom one (presets at `settings/VectorSearchSettings.tsx:287-293`). An "embedding" is a list of numbers that captures a text's meaning so similar texts can be found. The vectors go to your Cloudflare Worker (`cloudflare-worker/`). The Gemini key is put in the URL (`:122`). A reranker in `crossEncoderReranker.ts:93` also calls SiliconFlow. Copies exist in `server/src/mcp/provider.ts:229-337` and `electron/mcpLocalServer.js`. There's no `scripts/deploy-vector*` script, only a test; the deploy scripts are in `cloudflare-worker/`. |
| 6 | AI presets for many providers | **Confirmed, and Anthropic is already there** | Presets at `src/components/settings/AIConfigPanel.tsx:45-58`: OpenAI, Anthropic (`apiType 'claude'`, `:52`), Gemini, DeepSeek, Xiaomi MiMo and `token-plan-cn.xiaomimimo.com` (`:46`), and an empty "OpenAI-compatible" slot. `integrate.api.nvidia.com` (`:71`) is only example text in that slot's input box, not a preset, and it's never contacted unless you type it in. AI calls go through the server proxy (`POST /api/proxy/ai`, `server/src/routes/proxy.ts:280`) when a backend exists, and straight from the browser otherwise. The key is stored **in plain text in the browser** (IndexedDB, `options.ts:53`) and encrypted on the server. `GET /api/configs/ai?decrypt=true` hands it back to the browser (`backendAdapter.ts:777`). Off by default (no providers configured). |
| 7 | Auth fails open | **Mostly confirmed; one correction, one serious addition** | `server/src/middleware/auth.ts:15`: no `API_SECRET` means a warning and then `next()` (let everyone in). `docker-compose.yml:23-24` defaults both secrets to empty. **Correction:** `docker-compose.fullstack.yml:7` already *requires* `API_SECRET` (`${API_SECRET:?…}`); only `ENCRYPTION_KEY` defaults to empty (`:8`). **Addition:** `server/src/routes/authRestore.ts:26-47` (`POST /api/sync/auth`) returns your **decrypted GitHub token**, so with auth off anyone who can reach the port gets it. With `ENCRYPTION_KEY` unset, the server generates one and saves it in `data/.encryption-key`, next to the database it protects (`server/src/config.ts:53-75`). The browser keeps `API_SECRET` in sessionStorage, a plaintext localStorage copy and IndexedDB (`src/store/persistence/authStorage.ts:4-5,32`). The MCP endpoint has its own token and is off by default (`server/src/mcp/http.ts:15-22`, `mcp/settings.ts:33`). |
| 8 | Compose files pull GHCR images | **Confirmed** | `docker-compose.yml:5,17` and `docker-compose.fullstack.yml:3`. Publishing to GHCR happens in `.github/workflows/docker-publish*.yml`. Base images are Docker Hub `node:22-alpine` and `nginx:alpine`, which aren't pinned by digest yet (Phase 4). |
| 9 | No server-side jobs | **Confirmed** | `src/services/autoSync.ts:32` (`POLL_INTERVAL = 5000`) and `:792` (`setInterval`). `server/src` has no `setInterval`, no cron library and no scheduler. Where the work runs today, all in the browser: star sync in `features/repositories/hooks/useSearchActions.ts:463`; AI analysis in `services/aiAnalysisHelper.ts:58` calling `aiService.ts:1502`; release check in `features/releases/hooks/useReleaseTimelineActions.ts:33,63`. |
| 10 | DeepWiki and Zread link-outs | **Confirmed, with a small correction** | Plain `<a>` links, no background calls (`src/components/RepositoryCard.tsx:401,450`). Only one shows at a time: Zread for Chinese, DeepWiki otherwise (`:1216`). `SubscriptionRepoCard.tsx:98` also opens Zread. Also a `window.open` to `x.com/GoodMan_Lee` (the author's profile) at `settings/GeneralPanel.tsx:162`. |
| 11 | README images load from any host | **Confirmed** | Markdown goes through `react-markdown` + `rehype-raw` + `rehype-sanitize` (`MarkdownRenderer.tsx:1022-1023`), so the HTML is cleaned of scripts. Images aren't filtered, though: `resolveImageSrc` (`:306-312`) passes any `https` URL straight through. CSP `img-src 'self' data: https:` (`server/src/index.ts:134`) allows every HTTPS host, so visitor-counter badges and tracking pixels load. The nginx (split) deployment sends **no CSP at all** (`nginx.conf.template:153-155`). `@vitejs/plugin-legacy` does add inline scripts, but the server allows them by hash, not with `'unsafe-inline'` (`server/src/index.ts:69-103`). Dropping the plugin is still worthwhile: it doubles the bundle and accounts for 89% of build time. |
| 12 | No analytics SDKs; fonts bundled | **Confirmed** | No PostHog, Sentry, Google Analytics/gtag, Umami, Plausible, Baidu, Mixpanel, Amplitude or Segment in either `package.json`, `index.html`, `src/` or `server/src/`. Fonts come from `@fontsource/*`; there are no `fonts.googleapis.com` or `gstatic` references. The bundle scan in section 4 agrees. |
| 13 | Desktop code never runs in Docker | **Confirmed** | `electron/` is excluded by `.dockerignore` and `Dockerfile.fullstack.dockerignore`. `registry/` enters the build stage via `COPY . .` but never reaches the final image. CI still runs Electron tests (`ci.yml:175` runs `test:node`) and the plugin-registry check (`ci.yml:100`), and `build-desktop.yml` builds the desktop app. The desktop plugin marketplace fetches `raw.githubusercontent.com/AmintaCCCP/GithubStarsManager/main/registry` (`electron/plugins/pluginRegistryFeed.js:13`). |

---

## 3. Things your scan missed

| Finding | Where | Runs by default? | Recommendation |
|---|---|---|---|
| **README translation** to Microsoft (default) or Google, no account, full README text | `src/services/translateService.ts:21,23`; default engine `store/initialState.ts:86`; also batch import `useBatchStarImport.ts:192` | Only when you click translate (auto-translate is off by default) | **Remove.** Phase 3 can offer "translate with Claude" through the server if you want it. |
| **grep.app code search**, an unofficial API, called from the browser | `src/services/grepAppService.ts:11`; used by Code Search and semantic search (`semanticRepoSearchService.ts:473`) | When you use Code Search | **Remove.** |
| **GitHub token stored in the browser** in plain text, and handed back by the server | `store/persistence/authStorage.ts:5,32`; `server/src/routes/authRestore.ts:26-47` | Always | **Replace:** the token comes only from the server's `GITHUB_TOKEN`; delete the auth-restore route and every browser copy (Phases 2 and 3). |
| **AI keys returned to the browser** | `GET /api/configs/ai?decrypt=true` (`backendAdapter.ts:777`) | When AI is configured | **Remove** together with the browser-side AI settings (Phase 3). |
| **"Browser direct" mode**: the browser calls `api.github.com` with your token | `src/services/githubApi.ts:585-592`, `src/services/routeMode.ts:26` | When no backend is set, or the user picks "browser" mode | **Remove.** Everything goes through the backend (Hard rule 2). |
| **WebDAV backup** to a URL you choose; with "include keys" on, the file holds AI keys, the WebDAV password and the backend secret in plain text | `services/webdavService.ts:159`, `features/settings/hooks/useBackupActions.ts` | Only if configured | **Remove.** Phase 5's server-side SQLite backup replaces it. |
| **aria2 download** to a JSON-RPC URL you set (aria2 is a download manager) | `services/rpcDownloadService.ts`, `server/src/routes/proxy.ts:996` | Only if configured | **Remove** (not in your goals). Tell me if you use it. |
| **Outbound SOCKS/HTTP proxy setting** on the server | `server/src/routes/proxy.ts` proxy settings, `socks-proxy-agent` | Only if configured | **Remove.** It would sit outside the egress allowlist. |
| **Web plugin system**: plugins can make GET requests carrying your GitHub token, but only to `api.github.com` and only on a fixed list of read-only paths (`src/plugins/networkTargets.ts:13`, checked at `usePluginNetwork.ts:87` before the fetch at `:104`) | the `plugins-*.js` chunk ships in the web build | Only with plugins installed; the marketplace itself is desktop-only | **Remove from the web build.** Not a leak, but it's extra code holding your token in the browser |
| **External discovery feeds**: custom RSS/JSON URLs in Discover | `src/services/externalDiscoveryFeed.ts:16` | Only if added | **Remove** (it replaces item 4's feed with any feed). |
| **Gist reads** from `gist.githubusercontent.com` | `githubApi.ts:918-950` (`getGistFileRaw`; through the backend when one is set, otherwise direct) | When the Gists view is used | Goes with the Gist feature (see section 5). |
| **Desktop plugin registry** phones upstream | `electron/plugins/pluginRegistryFeed.js:13` | Desktop only | Leave in the tree (item 13); it never reaches Docker. |
| **OAuth login helper**, unused | `githubApi.ts:2453` (no caller, no client ID) | Never | **Remove** with the browser token code. |
| **Upstream `ui-preview.yml`** uses `pull_request_target` on PR code | `.github/workflows/ui-preview.yml` | Only on upstream's PRs | **Disable** in the fork (Phase 2). |

### Other checks from step 3

- **`fetch`, axios, XMLHttpRequest, WebSocket, EventSource, sendBeacon, service workers, external `<script>`/`<link>`, remote `import()`:** none beyond the items above. `index.html` loads only `/src/main.tsx` and `/icon.png`. No PWA or service worker.
- **Install scripts:** none of the five `package.json` files in the repo has a `preinstall`, `install`, `postinstall` or `prepare` script. Among dependencies, npm 12 blocked four install scripts until approved: `core-js` (prints a funding message), `electron-winstaller` (desktop only), `esbuild` (checks its own binary) and `better-sqlite3` (compiles the database driver; the Docker build needs this one).
- **GitHub Actions that publish:** `docker-publish.yml`, `docker-publish-frontend.yml` and `docker-publish-fullstack.yml` push images to GHCR. `build-desktop.yml` attaches desktop builds to a draft release on tags. `ui-preview.yml` pushes screenshots to a branch and comments on PRs. `ci.yml`, `codeql.yml` and `gitleaks.yml` publish nothing. No npm publish, GitHub Pages or Cloudflare deploy.
- **Hardcoded tokens:** only X's public web bearer token (`xtweet.ts:25`, `electron/main.js:705`), which is part of item 2. No GitHub, AWS, Google or other keys. `.gitleaks.toml` allows only exact fake values inside six test files.
- **Large base64 blobs:** none over 1 KB.
- **Minified code committed as source:** one file, `examples/plugins/repo-insights/ui/chart.umd.js`, a copy of the Chart.js 4.4.4 library (MIT header, no `eval` or network calls) for an example desktop plugin. It isn't in the web build or the image. It's a known library, not obfuscated code, so it doesn't trigger a rebuild. Nothing else (no `.min.*` files, no `eval`, no `new Function`).
- **Diagnostic logs never upload.** The desktop logger writes local files (`electron/diagLogger.js:232,238`), "Export bundle" saves through a file dialog (`electron/main.js:1623`), the web export is a browser download (`settings/DiagnosticLogsPanel.tsx:471`), and the server log is an in-memory buffer read through `/api/logs` (`server/src/services/logger.ts:28-50`).

---

## 4. Hosts found in the built app

Built with `npm run build` (frontend, `dist/`, 28 MB including legacy copies) and `npm --prefix server run build` (`server/dist/`, 0.8 MB). The scan is a simple regex for `http(s)://` and `ws(s)://` hosts in every `.js`, `.css`, `.html` and `.json` file. A host appearing here doesn't mean it's contacted; the third column says whether it is.

### `dist/` (frontend, 35 hosts)

| Host | Referenced in (chunk) | Contacted? |
|---|---|---|
| api.github.com | `dist-*.js`, `RepositoryReleaseSheet-*.js` | Yes, browser-direct mode. **Remove** |
| raw.githubusercontent.com | `index-*.js` | Yes, update check. **Remove** |
| mshibanami.github.io | `dist-*.js` | Yes, trending feed. **Remove** |
| edge.microsoft.com, clients5.google.com | `index-*.js` | Yes, translation. **Remove** |
| grep.app | `DiscoveryView-*.js` | Yes, code search. **Remove** |
| x.com, t.me | `DiscoveryView-*.js`, `dist-*.js`, `plugins-*.js`, many locale chunks | Links and labels; scraping happens on the server. **Remove** |
| api.openai.com, api.anthropic.com, generativelanguage.googleapis.com, api.cohere.com, api.siliconflow.cn, token-plan-cn.xiaomimimo.com | `SettingsPanel-*.js` | Yes, when configured (AI and embedding presets). **Remove**; Claude moves to the server |
| integrate.api.nvidia.com | `SettingsPanel-*.js` | No: example text in an input box. **Remove** |
| api.deepseek.com, api.xiaomimimo.com | `app-*.js` (22 locale chunks) | Preset text. **Remove** |
| github-stars-vectorize.your-name.workers.dev | `SettingsPanel-*.js` | Placeholder. **Remove** with vector search |
| dav.jianguoyun.com | `SettingsPanel-*.js` | WebDAV placeholder. **Remove** |
| zread.ai | `DiscoveryView-*.js`, `index-*.js` | Link only. **Remove** |
| github.com | 58 chunks | Repo links and README relative-image rewrites (`github.com/<o>/<r>/raw/HEAD/…`). Images are loaded, so Phase 2 proxies them |
| www.w3.org, chevrotain.io, langium.org, www.eclipse.org, en.wikipedia.org, www.ibm.com, react.dev, rolldown.rs, tailwindcss.com | library chunks (mermaid, elk, React, CSS) | No: XML namespaces, license headers and error-message links |
| example.com, api.example.com, search.example.com, localhost, query-string.invalid | settings and discovery chunks | No: placeholders |

### `server/dist/` (backend, 13 hosts)

| Host | File | Contacted? |
|---|---|---|
| api.github.com | `index.js` (CSP), `routes/proxy.js` | Yes. **Keep** |
| raw.githubusercontent.com, gist.githubusercontent.com | `index.js` (CSP list) | Through the github-raw proxy. Keep raw; gist depends on section 5 |
| mshibanami.github.io, api.openai.com, generativelanguage.googleapis.com | `index.js` (CSP list) | Browser permission only. **Remove** |
| api.openai.com, generativelanguage.googleapis.com, api.cohere.com, api.siliconflow.cn, 127.0.0.1 (Ollama) | `mcp/provider.js` | Yes, MCP semantic search when configured. **Replace** in Phase 6 |
| x.com | `routes/xtweet.js` | Yes. **Remove** |
| t.me | `routes/telegram.js` | Yes. **Remove** |
| dav.example.com, localhost | `routes/proxy.js` | Placeholders |

The server's AI, WebDAV and aria2 proxies also forward to **any** host the user typed into Settings (checked against private IP ranges on each redirect). They don't show in the scan because the hosts come from settings. Phase 2's allowlist closes this.

---

## 5. Feature table

**Token scope** is what a GitHub personal access token must be allowed to do. A **classic** token uses broad scopes; a **fine-grained** token lists exact permissions and is the safer kind.

| Feature | Outside hosts it calls | GitHub token scope (classic / fine-grained) | Recommendation |
|---|---|---|---|
| Star sync (`GET /user/starred`) | api.github.com | `public_repo` (`repo` only for private stars) / **Starring: read**, Metadata: read | **Keep**; runs on the server in Phase 5 |
| Star / unstar buttons, bulk unstar, batch star import (`PUT/DELETE /user/starred/…`) | api.github.com | `public_repo` / **Starring: read and write** | ⚠ **WRITES to your account.** **Keep**, because Phase 7's unstar queue needs it. Bulk unstar asks for confirmation |
| GitHub Lists sync, read (GraphQL `viewer.lists`) | api.github.com/graphql | classic `user` (read/write profile) / fine-grained support unclear; the app's own help shows no fine-grained option | **Your call.** Keep only if you use GitHub Lists |
| GitHub Lists push, write (`createUserList`, `updateUserList`, `updateUserListsForItem`) | api.github.com/graphql | classic `user` | ⚠ **WRITES.** **Remove** unless you want categories mirrored to GitHub. It needs the broad `user` scope and probably rules out a fine-grained token |
| Gists: list, edit, create, delete, star | api.github.com, gist.githubusercontent.com | `gist` / Gists: read and write | ⚠ **WRITES.** **Remove**, it isn't in your goals |
| Fork sync (`POST /repos/…/merge-upstream`) | api.github.com | `repo` / Contents: **write** on all your repos | ⚠ **WRITES** commits to your forks. **Remove**: wide permission, outside the app's purpose |
| Trigger workflows (`POST …/actions/workflows/…/dispatches`) | api.github.com | `repo` (the app's help, `src/locales/en/login.json:56`; GitHub may also require `workflow`, to confirm in Phase 4) / Actions: **write** | ⚠ **WRITES.** **Remove** |
| Watched repos (`GET /user/subscriptions`) | api.github.com | `repo` or none / Watching: read | **Keep** if you use it (cheap, read-only) |
| Release tracking (`GET /repos/…/releases`) | api.github.com | none for public repos | **Keep**; server job in Phase 5 |
| README viewer, file tree, commits | api.github.com, github.com (images), any image host in READMEs | none for public repos | **Keep**; block non-GitHub images by default with a per-README "Load images" button |
| Repo chat / Q&A (also reads issues) | AI provider, api.github.com | none for public repos | **Keep, on Claude** (`CLAUDE_MODEL_CHAT`) |
| AI summaries, tags, categories | AI provider of choice | n/a | **Keep, on Claude** (server side, batches) |
| Discover: trending | mshibanami.github.io | n/a | **Remove** this source |
| Discover: hot releases, most popular, topics, search, weekly | api.github.com | none | **Keep**, through the backend |
| Discover: X and Telegram channels | x.com, api.x.com, t.me | n/a | **Remove** |
| Code search | grep.app | n/a | **Remove** |
| README translation | edge.microsoft.com, clients5.google.com | n/a | **Remove** (optional Claude replacement later) |
| Vector / semantic search, reranker | Cloudflare Worker, OpenAI, Gemini, Cohere, SiliconFlow, Ollama | n/a | **Replace** with the local index (Phase 6) |
| MCP endpoint, 10 read-only `gsm_*` tools | none (search uses embeddings, see above) | n/a | **Keep** |
| Update check | raw.githubusercontent.com | none | **Remove** |
| WebDAV backup / restore | your WebDAV server | n/a | **Remove**; replaced by Phase 5 server backup |
| JSON import / export | none | n/a | **Keep** |
| aria2 release download | your aria2 server | n/a | **Remove** (unless you use it) |
| Web plugins | api.github.com only (fixed read-only paths, with your token) | inherits your token | **Remove** from the web build |
| Themes | none (tweakcn.com is a comment) | n/a | **Keep**; replace any orange preset or accent in Phase 2 |
| DeepWiki / Zread / author-profile links | none (link-outs) | n/a | **Remove** (low priority) |
| Desktop app, plugin marketplace | upstream registry on raw.githubusercontent.com | n/a | Leave in the tree, out of image and CI |

**Token if you accept these recommendations:** a **fine-grained** token covers everything, with *Starring: read and write*, *Watching: read* and *Metadata: read* on public repositories. You need a **classic** token with the `user` scope only if you keep GitHub Lists. I'll confirm this against GitHub's documentation in Phase 4.

---

## 6. Fork or rebuild

**Recommendation: fork.** None of your three rebuild triggers is present:

1. **Unconfigured data leaks beyond your list:** none. The new findings (translation, grep.app, the token handling) are visible features or design choices, not hidden sends. Translation and grep.app only run on a click; the token problem is a weakness, not a leak.
2. **Minified or obfuscated source:** none. The one minified file is a vendored copy of Chart.js in a desktop example plugin, outside the web build.
3. **Removals breaking core features:** they don't. Star sync, AI analysis and release tracking are separate modules (`githubApi.ts`, `aiService.ts`, the releases hooks) that don't depend on the removed features.

**The honest caveat:** the app does its work in the browser and keeps secrets there. Hard rules 2 and 3 plus Phase 5 turn that around, so the server holds the token, calls Claude and runs the jobs. Phase 5's "reuse the client code" will be partial: the sync and analysis logic is tied to the browser's state store (zustand, the in-memory data the UI reads from). The likely result is a new server module that copies the request logic and skips the UI state, and I'll explain that before writing it. This adds work to the fork path but doesn't flip the decision.

| Path | What it is | Estimate (my working time) |
|---|---|---|
| **Fork (recommended)** | Phases 2–7 as written | about 24–34 hours across about 8–10 sessions, plus your reviews and a 24-hour soak |
| Rebuild | The smallest app covering what you're keeping: Express + SQLite server, a small React UI (star list with search and filter, categories and tags, AI summary, releases timeline, settings and jobs page), server jobs, Claude batches, local embeddings, MCP read tools, Atom/OPML | about 40–55 hours. You'd lose upstream's UI polish, 20+ locales and tests, and there'd be no upstream to merge from |

---

## 7. Test baseline before any change

The checks Phase 2 onward must keep green, run on the untouched `c2332ed4`:

Run on GILEAD (Windows 11, Node 22.23, npm 12.2) on 2026-11-09.

| Check | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run check:i18n` | pass |
| `npm run build` (frontend) | pass, 2 min 19 s, of which 89% is `@vitejs/plugin-legacy` |
| `npm --prefix server run build` and `tsc --noEmit` | pass |
| server tests (`cd server && npx vitest run`) | **193 / 193 pass** |
| `npm run test:run`, vitest part | 2,373 / 2,383 pass; **10 fail** |
| `npm run test:run`, `node --test` part | 401 / 408 pass, 3 skipped; **4 fail** |

**None of the 14 failures is a real bug.** Upstream CI runs on Ubuntu and passed every job on this exact commit (CI run 42485710541). The failures come from running on Windows:

- **10 timeouts** (App routes, GlobalChatHistorySheet, ReleaseTimeline, RepositoryCard lazy README, RepositoryReleaseSheet). Slow first-load file reads push them past the 5 s test limit. Most pass when rerun alone or with a longer limit.
- **2 line-ending failures** (`electron/windowLifecycle.test.js`). The tests search `main.js` for `\n` line endings, but Git on Windows checked it out with `\r\n`.
- **1 Windows path failure** (`electron/diagLogger.test.js`): the test mixes `/tmp/...` with Windows backslash paths.
- **1 Windows permission failure** (`electron/plugins/pluginMarketplace.test.js`): `chmod 000` doesn't block folder creation on Windows.

**What this means for later phases:** the gate checks run on Linux, either in GitHub Actions CI or on CERES, which is Ubuntu. On GILEAD, a timeout only counts as a regression if it also fails on Linux. The three Electron test files are desktop-only and leave CI in Phase 2 (item 13), so they stop mattering.

---

## 8. Time estimates for the remaining phases

Estimates are my working time. Your review time and waiting periods are extra.

| Phase | What | Estimate | Notes |
|---|---|---|---|
| 2 | Strip tracking and outside calls, egress allowlist, CSP, avatar proxy, `check:egress`, CI cleanup | 6–8 h | Largest file count: X, Telegram, translation, grep.app, gists, forks, WebDAV, aria2, plugins, update check, browser-direct mode, plus i18n keys in every locale |
| 3 | Claude on the server: SDK client, model check, Batches API, prompt caching, JSON-schema output, spend guard, credit-low state; take the token and keys out of the browser | 5–7 h | The dry run is free; the three-repo test analysis costs a few cents |
| 4 | Docker: pinned images, healthcheck, hardened compose, `.env.example`, Tailscale binding, `up.sh` / `update.sh` | 2–3 h | Plus about 30 min of you on CERES, or me over `ssh ceres` if you approve |
| 5 | Server job runner (sync, analysis, releases, backup), `/api/jobs`, Settings panel, `RESTORE.md` | 5–7 h | Plus one full unattended cycle before the report (at least 6 h of waiting) |
| 6 | Local embeddings (transformers.js + ONNX model in the image), brute-force search, delete Cloudflare code | 3–5 h | Image size grows by roughly 100–250 MB |
| 7 | Proposals: about 30 min. Building: alerts 2–3 h, Atom/OPML 2 h, digest 1–2 h, status and notes 2 h, unstar queue 2 h, awesome-list export 1 h, Claude Code MCP command 15 min | 0.5 h plus whatever you approve | |

---

## 9. Decisions I need from you before Phase 2

1. **Fork**, as recommended? (yes/no)
2. **Remove** everything marked Remove in sections 3 and 5? In particular, confirm these features you might use: **Gists**, **fork sync / workflow triggers**, **aria2 download**, **WebDAV backup**, **README translation**.
3. **GitHub Lists:** keep read-only, keep read and write (needs a classic token with `user` scope), or remove?
4. **Star / unstar from the app:** keep? (I recommend yes; it's needed for Phase 7 item 5.)
5. **Watched repos:** keep?
