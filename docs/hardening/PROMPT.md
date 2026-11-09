# Hardened self-hosted fork of GithubStarsManager

Read this whole file before doing anything. Work one phase at a time and stop at every gate.

## How to work with me

* I'm Bill (GitHub `WPTK`). I'm not a programmer. You write the code. I approve each phase.
* Explain decisions in plain language. The first time you use a technical term I may not know, explain it in a few words.
* End every phase with a report in this order:
   1. First line: `Phase N of 7 done: <one-line result>`
   2. What changed, as short bullets with file paths in backticks
   3. How I can check it myself: exact commands and the output I should see
   4. What the next phase does, with a time estimate
* After the report, stop and wait for me to say `go`.
* Before each report, run `npm run lint`, `npm run typecheck`, `npm run test:run`, and `npm run check:i18n`, and fix anything you broke.
* Commit after each logical change with a Conventional Commit message. Never force-push. Never push to `upstream` or open pull requests there.
* Ask before you create or delete a repository, touch files outside this repo, run anything destructive, or spend API money beyond a dry run.
* Never print, commit, or log a secret (API keys, tokens, passwords). Keep `.env` in `.gitignore` and use placeholders in docs.
* If the same fix fails three times, stop, name the assumption you think is wrong, and ask me one question.
* No orange in any color you add or change. If a theme preset or the default accent uses an orange hue, replace it.

## Goal

Turn `AmintaCCCP/GithubStarsManager` into a private, single-container Docker deployment for my homelab that:

1. Uses Claude through my Anthropic API key, called only from the server.
2. Calls no host outside an explicit allowlist, with a check that proves it.
3. Keeps working with no browser tab open: scheduled star sync, AI tagging, release checks, and backups.
4. Adds only the new features I approve in Phase 7.

## My environment (I'll correct anything wrong here)

* Repo: my fork `WPTK/GithubStarsManager`, cloned on the Docker host. `origin` is my fork and `upstream` is `AmintaCCCP/GithubStarsManager`. Work on a branch named `hardened`.
  *(Correction recorded in Phase 1: the fork is actually named `WPTK/GSM`.)*
* Docker host: CERES, Ubuntu 24.04 with Docker Engine, Linux user `bk`.
* Access: over Tailscale only. Don't expose the app through port forwarding or my Cloudflare Tunnel.
* Logs: a dozzle-agent on CERES already sends container stdout to Dozzle on GILEAD. Log to stdout with secrets redacted.
* RSS reader: Kipple, my own app, which subscribes to Atom and RSS feeds by URL.
* Upstream snapshot I reviewed: commit `c2332ed` from 2026-11-08, `package.json` version 0.9.0, MIT license.

## Hard rules

1. Claude access goes through the Claude API with my Anthropic API key (`ANTHROPIC_API_KEY`), called from the server. Don't involve the `claude` CLI or a Claude subscription login.
2. The browser talks only to the app's own origin. Calls to GitHub, Anthropic, and anything else go through the backend.
3. The Anthropic key and the GitHub token live only on the server. Read them from environment variables (with a `_FILE` variant for Docker secrets). Never send them to the browser or store them in localStorage.
4. Fail closed. The container refuses to start if `API_SECRET`, `ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, or `GITHUB_TOKEN` is missing.
5. Build images from my fork's source. Never pull `ghcr.io/amintacccp/*` images.
6. Keep upstream merges manageable. Remove whole routes, services, and components rather than editing many shared files, and record every removal in `docs/hardening/STRIPPED.md`.
7. Keep the MIT license file and credit the upstream project in the README.

## What my quick scan found

I did a read-only scan of `c2332ed`. In Phase 1, confirm or correct each item with file and line evidence, and add anything I missed. Don't take my word for any of it.

1. An update check phones home on every page load with no opt-in. `src/App.tsx` calls `useAutoUpdateCheck()` (`src/hooks/useAutoUpdateCheck.ts`), which uses `src/services/updateService.ts` to fetch `https://raw.githubusercontent.com/<upstream>/main/versions/version-info.xml`. UI pieces: `src/components/UpdateChecker.tsx`, `src/components/UpdateNotificationBanner.tsx`. Remove all of it.
2. X (Twitter) scraping with the user's session cookies. `server/src/routes/xtweet.ts` forwards the X `auth_token` and `ct0` cookies along with a hardcoded X web-client bearer token. Client side: `src/services/xTweetService.ts`, `src/components/XTweetSettingsModal.tsx`. Remove it entirely.
3. Telegram channel scraping in `server/src/routes/telegram.ts`, `src/services/telegramService.ts`, and `src/components/TelegramSettingsModal.tsx`. Remove it.
4. A third-party trending feed. `src/services/githubApi.ts` fetches `mshibanami.github.io/GitHubTrendingRSS`. Remove that source and keep only Discover features that call GitHub's own API through the backend.
5. Vector search needs a Cloudflare Worker, Cloudflare Vectorize, and an outside embedding API (`cloudflare-worker/`, `src/services/vectorSearchService.ts`). Replace it with a local index in Phase 6.
6. AI provider presets for OpenAI, Gemini, DeepSeek, Xiaomi MiMo (including `token-plan-cn.xiaomimimo.com`), and generic OpenAI-compatible endpoints, in `src/components/settings/AIConfigPanel.tsx`, `src/services/aiService.ts`, and `server/src/routes/proxy.ts`. Keep Anthropic only.
7. Auth fails open. `server/src/middleware/auth.ts` turns auth off and only logs a warning when `API_SECRET` is unset. `docker-compose.yml` defaults `API_SECRET` to empty, and `docker-compose.fullstack.yml` defaults `ENCRYPTION_KEY` to empty. Hard rule 4 fixes this.
8. Both compose files pull upstream images from GHCR. Hard rule 5 fixes this.
9. No server-side jobs. `src/services/autoSync.ts` polls between browser and backend every 5 seconds while a tab is open, and I found no scheduler in `server/src`. Star sync, AI analysis, and release checks seem to run only while the UI is open. Phase 5 fixes this.
10. Repo cards link out to deepwiki.com and zread.ai (`src/components/RepositoryCard.tsx`). These are plain links with no background calls. Remove the buttons (low priority).
11. Rendered READMEs and release notes probably load images from any host, including visitor-counter badges that log each view. Check the current Content-Security-Policy, then block non-GitHub image hosts by default and add a "Load images" button per README.
12. Not found: analytics or telemetry SDKs (PostHog, Sentry, Google Analytics, Umami, Plausible, Baidu Tongji). Fonts come bundled through `@fontsource`. Prove this with the bundle scan in Phase 1.
13. Desktop-only code (`electron/`, plus the plugin marketplace in `electron/plugins/` and `registry/`) never runs in Docker. Leave it in the tree to reduce merge conflicts, but keep it out of the image and out of CI.

## Phase 1. Audit and decision (no source edits)

You may install dependencies, run builds, and write files under `docs/hardening/` only. Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when installing, as the Dockerfile does.

1. Move this file to `docs/hardening/PROMPT.md`. Fetch `upstream`, create branch `hardened` from `upstream/main`, and record the commit SHA in `docs/hardening/AUDIT.md`.
2. Verify the 13 items above.
3. Look for anything else that sends data off the machine: `fetch(`, `axios`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, tracking pixels, service workers, external `<script>` or `<link>` tags, remote `import()`, `postinstall` scripts in every `package.json`, GitHub Actions that publish anything, hardcoded tokens, large base64 blobs, and minified or obfuscated code committed as source. Confirm the diagnostic-log features never upload anything.
4. Build the frontend and the server. List every URL host found in `dist/` and `server/dist/`, with the file that references it.
5. Write a table with these columns: feature, outside hosts it calls, GitHub token scope it needs, your recommendation (keep, remove, or replace). Flag every feature that needs write access to my GitHub account (for example Gist editing, fork sync, or triggering Actions) and say whether I should keep it.
6. Decide fork or rebuild. My default is fork. Recommend a from-scratch rebuild only if you find one of these:
   * code that sends my data to a host I never configured, beyond the items above
   * minified or obfuscated code committed as source
   * removing the items above breaks star sync, AI tagging, or release tracking so badly that rewriting them costs less than repairing them

   If you recommend a rebuild, describe the smallest app that covers what I'm keeping and estimate both paths.
7. Add a time estimate for each remaining phase to `AUDIT.md`. Then report and stop.

## Phase 2. Strip tracking and outside calls

1. Remove what I approved after Phase 1: routes, services, components, settings screens, i18n keys in every locale, and tests and fixtures that exist only for removed features.
2. Send every server-side outbound request through one function that checks the host against `OUTBOUND_ALLOWLIST`. Default: `api.github.com,github.com,raw.githubusercontent.com,avatars.githubusercontent.com,api.anthropic.com`. Block and log anything else. Extend `server/src/services/proxyService.ts` rather than adding a second layer.
3. Serve avatars through a cached backend route so the browser never contacts GitHub directly.
4. Tighten the Content-Security-Policy in the existing helmet setup: `connect-src 'self'`, and `img-src 'self' data: blob:` plus GitHub image hosts. Avoid `'unsafe-inline'`. I only use current browsers, so drop `@vitejs/plugin-legacy` if it's what forces inline scripts.
5. Add `npm run check:egress`. It builds, scans both `dist/` folders for URL hosts, and fails if a host isn't in `docs/hardening/egress-allowlist.txt`. Plain link-outs that the browser never fetches go in a separate, commented section of that file.
6. In my fork's GitHub Actions, disable the workflows that publish images or releases. Keep one CI workflow: lint, typecheck, tests, `check:egress`, and a Docker build.
7. Update `docs/hardening/STRIPPED.md` and include the `check:egress` output in your report.

## Phase 3. Claude through my API key

1. Build a server-side Anthropic client (use the official `@anthropic-ai/sdk` unless you have a reason not to). Remove the browser-side AI calls and the key and endpoint fields in Settings. Settings shows only a status line such as "Claude connected, key ending in 7f3a" and the models in use.
2. Read the models from environment variables: `CLAUDE_MODEL_BULK` defaults to `claude-haiku-5-5` (summaries, tags, categories) and `CLAUDE_MODEL_CHAT` defaults to `claude-sonnet-5-5` (repository Q&A). At startup, check both IDs against the Models API and refuse to start with a clear message if either is missing.
3. Bulk runs of more than 20 repos go through the Message Batches API, which Anthropic bills at half the normal rate. Store batch IDs in SQLite so a restart resumes polling instead of resubmitting.
4. Cache the shared instructions and my category list with prompt caching. If that prefix is shorter than the minimum cacheable length for the model, skip caching and tell me.
5. Get structured JSON back (the API's JSON-schema output if the model supports it, otherwise a tool with an input schema), validate it with `zod` (already a dependency), and retry once on invalid output.
6. Spend guard: before any bulk run, show estimated tokens and dollar cost, with prices kept in one config file along with the date you checked them. Require a confirmation click in the UI when the estimate is over $2.00 (configurable).
7. Treat "credit balance is too low" as its own state. Pause the queue, show a banner, check once a day, and resume when calls succeed again. Back off on 429 and 529 responses and respect `retry-after`.
8. In your report, include a dry-run cost estimate for my real star count and one real analysis of three repos.

## Phase 4. Docker deployment

Start from `Dockerfile.fullstack`. It runs one Node process as user `node` that serves the SPA, the API, and the MCP endpoint, with data in `/app/data`.

1. Pin base images by digest. Add a `HEALTHCHECK` that calls `GET /api/health`.
2. Write `deploy/compose.yaml` that builds from local source and sets:
   * `read_only: true`, with a tmpfs for `/tmp`
   * `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`
   * `init: true` and `restart: unless-stopped`
   * a memory limit (start at 1 GB and adjust after measuring)
   * json-file log rotation at 10 MB and 3 files
   * a named volume for data and a bind mount for backups
3. Required variables use `${VAR:?message}`. Write `.env.example` with a one-line comment per variable and how to generate secrets (`openssl rand -hex 32`).
4. Publish the port to Tailscale only, either by binding to CERES's Tailscale IP or by binding to `127.0.0.1` and using `tailscale serve`. Pick one and explain why.
5. Document the minimum GitHub token scopes for the features I kept. Use a fine-grained token if it covers them, and explain if it doesn't.
6. Write `deploy/up.sh` (build, start, wait until healthy) and `deploy/update.sh` (fetch upstream, summarize what changed, merge into `hardened` only after I confirm, rerun `check:egress` and the tests, rebuild, restart).
7. In your report, give me the exact commands to bring it up on CERES.

## Phase 5. Headless jobs on the server

The app has to do its work with no browser open.

1. Add one job runner to the backend. Schedules come from environment variables, runs never overlap, and state survives restarts. Defaults:
   * star sync, plus GitHub Lists sync if kept: every 6 hours
   * Claude analysis of new or changed repos, as one batch: after each sync
   * release check for subscribed repos: every 2 hours
   * SQLite backup through the online backup API to the backups mount, keeping 14 days: nightly. Write `deploy/RESTORE.md`.
2. Reuse the existing client-side sync and analysis code as a shared module where you can. If that isn't practical, explain why before writing a second copy.
3. Add `GET /api/jobs` and a Settings panel that shows the last run, next run, and result of each job.
4. Report after one full cycle has run with the browser closed.

## Phase 6. Local semantic search

1. Store embeddings in the existing SQLite database. Brute-force cosine similarity is fine at my scale (a few thousand repos at most). Add `sqlite-vec` only if you measure a real gain.
2. Run embeddings locally. Default: a small ONNX model through transformers.js, with the model files copied into the image at build time so nothing downloads at runtime. Switch the runtime base to `node:22-bookworm-slim` if the ONNX runtime needs glibc. Fallback: an Ollama container on my LAN. Tell me which you chose, which model, and the final image size.
3. Delete `cloudflare-worker/` and the Vectorize code. "Find similar repositories" and the MCP search tool must work against the local index.
4. Re-embed only repos whose text changed.

## Phase 7. New features (propose first, build only what I approve)

These come from comparable tools (StarDash, Starlens) and upstream issue #34, in order of my interest. For each, give an effort estimate and any new outside host it needs, then wait for my yes or no on each one.

1. Alerts for new releases in subscribed repos and for starred repos that get archived or deleted, sent to ntfy or any Apprise URL, with a per-repo mute.
2. An Atom feed of releases across my subscribed repos for Kipple, at a URL protected by its own read-only token that I can rotate. Also an OPML export of each starred repo's `https://github.com/<owner>/<repo>/releases.atom` feed.
3. A weekly digest of new stars, notable releases, and newly archived repos, delivered as one Atom entry and one notification.
4. Per-repo status (using, evaluating, retired) and private notes, both filterable. Today the app only has `custom_description`.
5. An unstar review queue: archived repos and repos with no commits in 24 months, with an unstar button that asks for confirmation because it writes to my GitHub account.
6. A Markdown "awesome list" export grouped by category.
7. Connect Claude Code to the app's existing read-only MCP endpoint. Give me the exact `claude mcp add --transport http ... --header "Authorization: Bearer <token>" --scope user` command using my Tailscale hostname, after checking `claude mcp add --help` for the current syntax.

## Done means

* [ ] `deploy/up.sh` on CERES gives a healthy container reachable only over Tailscale.
* [ ] After 24 hours with no browser open, stars have synced, new stars have summaries and tags, releases are current, and a backup file exists.
* [ ] `npm run check:egress` passes. After a full sync, one AI batch, and one release check, the runtime outbound log lists only allowlisted hosts.
* [ ] The browser's Network tab shows requests only to the app's own origin, except README images I chose to load.
* [ ] The container refuses to start when any required secret is missing.
* [ ] `gitleaks detect` passes (the repo already has `.gitleaks.toml`).
* [ ] `docs/hardening/AUDIT.md`, `docs/hardening/STRIPPED.md`, `deploy/RESTORE.md`, and a README section for my fork (what changed, how to run, update, back up, restore, and rotate secrets) are written for a non-programmer.
* [ ] `deploy/update.sh` has run once against upstream.

Start with Phase 1 only.
