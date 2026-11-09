# Stripped in the hardened fork

Format: item -> files -> reason.

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
