# Deploying the hardened fork (CERES)

One container, built from this checkout, reachable only from your tailnet. No image is pulled from a registry (only the pinned `node:22-alpine` base, by digest, at build time).

## How it is exposed, and why

The compose file publishes `127.0.0.1:${GSM_PORT:-8765}:3000`, and `tailscale serve` puts HTTPS in front of it:

```
tailnet device --https--> tailscale serve (:8443) --http--> 127.0.0.1:8765 --> container :3000
```

Why this and not binding to the Tailscale IP:

- Loopback-only means the app is not reachable from the LAN, even if Tailscale is down. This relies on Docker Engine 28 or newer, which stops other hosts reaching a port published on 127.0.0.1 (CERES runs 29.8.1); on an older engine, check with a scan from another machine.
- `tailscale serve` gives a real HTTPS certificate for the MagicDNS name. The session cookie is `Secure` and the CSP upgrades to https, so a plain-http bind to a Tailscale IP would not keep you logged in (browsers drop `Secure` cookies on a non-localhost http origin).
- Binding to a Tailscale IP can fail at boot if Docker starts before `tailscale0` is up.
- `tailscale serve` keeps the `Host` header, so the app's CSRF check (`Origin` must equal `Host`) passes.

Because the request reaches the app through Docker's bridge, the app sees the bridge gateway (172.x) as the client. `TRUST_PROXY` therefore defaults to `uniquelocal` (an Express subnet keyword) so `X-Forwarded-Proto` is honoured and the cookie gets `Secure`. That is safe when Docker Engine is 28 or newer (CERES runs 29.8.1), because loopback-published ports are not reachable from the LAN, so nothing outside this machine can send the app a forged `X-Forwarded-*` header. Any local process on the host, and any container on the `gsm` network, is trusted by that setting. The impact is limited to the login rate limiter (which keys on the client address) and the forwarded-proto check (the `Secure` cookie).

Side effect to know about: `tailscale serve --https` puts the machine name in public certificate-transparency logs (the name, not the content). To undo the whole exposure: `sudo tailscale serve --https=8443 off`.

## Bring-up on CERES

Host requirements: Docker with compose and buildx is all `up.sh` needs. `update.sh` also needs Node 22+ and npm on the host (it runs the merged tree's npm scripts and tests there).

CERES facts: Tailscale name `ceres.mara-rigel.ts.net`, HTTPS certificates enabled for the tailnet, Docker with compose and buildx, user `bk` in the `docker` group. Nothing here touches other containers or the Cloudflare tunnel.

```bash
ssh ceres
git clone -b hardened https://github.com/WPTK/GSM ~/gsm
cd ~/gsm
git remote add upstream https://github.com/AmintaCCCP/GithubStarsManager.git
git remote set-url --push upstream DISABLED     # fetch-only: nothing can be pushed to upstream
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env            # fill in the four required values; see .env.example
./deploy/up.sh                 # creates backups/, builds, starts, waits until healthy
sudo chown 1000:1000 backups   # once, if up.sh warned that the owner is not uid 1000
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8765
```

To run `tailscale serve` without sudo, run `sudo tailscale set --operator=bk` once.

Verify:

```bash
curl -s http://127.0.0.1:8765/api/health        # {"status":"ok",...}
docker stats --no-stream gsm                     # measure memory; the limit starts at 1 GB, adjust after this
tailscale serve status
```

Then open `https://ceres.mara-rigel.ts.net:8443/` from a tailnet device and log in with `API_SECRET`.

Notes:

- First start needs internet: the server calls the Anthropic Models API at startup and refuses to start if it cannot. `up.sh` waits up to 120 s and prints the last 30 log lines if the container does not become healthy.
- The container runs as `node` (uid 1000). `backups/` in the repository root (the compose default `../backups` is relative to `deploy/`, so it does not depend on where you run from) must be owned by uid 1000 (Phase 5 writes there). `up.sh` creates it if missing and warns if the owner is wrong; it never uses sudo. Set `GSM_BACKUP_DIR` in `deploy/.env` to use another path; prefer an absolute path, since a relative one is also resolved against `deploy/`.
- Data is in the Docker named volume `gsm-data`.

## Logs

`docker logs --tail 100 -f gsm`, or the Dozzle already running on CERES (it reads container stdout). Logs rotate at 10 MB x 3 files.

## Rotate secrets

Edit `deploy/.env`, then restart only this service:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d gsm
```

- `API_SECRET`: signs everyone out (cookies are derived from it).
- `ENCRYPTION_KEY`: values already stored encrypted become unreadable. Rotate only if you are prepared to re-enter them.
- `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`: take effect on restart.

Always name the service (`gsm`); never run a bare `up -d` or `down`.

## Update

`./deploy/update.sh` fetches `upstream`, shows the new commits and diffstat, and merges into `hardened` only after you type `yes`. It then re-runs `npm ci`, `npm run check:egress`, the root and server tests, and `up.sh`. On failure it prints how to `git merge --abort` or reset to the previous commit. It uses a fetch-only `upstream` remote pointing at the original project (added in the clone steps; `update.sh` adds it with pushing disabled if it is missing). Before you type `yes` it also prints the diffstat of the files the hardening depends on (`server/src/middleware`, `preflight.ts`, `secrets.ts`, `config.ts`, `routes/session.ts`, `deploy/`, `Dockerfile.fullstack`) and warns if any changed; read that diff in full first.

Note: `update.sh` runs the merged tree's npm scripts and tests on the host, so only merge upstream you have skimmed.

## Docker secrets (`*_FILE`)

Each required value also accepts a `<NAME>_FILE` variant (`API_SECRET_FILE`, `ENCRYPTION_KEY_FILE`, `ANTHROPIC_API_KEY_FILE`, `GITHUB_TOKEN_FILE`) naming a file inside the container. The rules:

- When `<NAME>_FILE` is set and non-empty, the file wins over `<NAME>`.
- If the file is unreadable or empty, the secret counts as missing and the server refuses to start. It does not fall back to `<NAME>`.
- This compose file requires every plain variable to be a non-empty value (`${VAR:?}`), and `up.sh` checks `deploy/.env` the same way (and wants `API_SECRET` and `ENCRYPTION_KEY` to be at least 16 characters). So keep a plain value for each in `deploy/.env`; with a file configured it is ignored. A short note such as `unused-see-secret-file` fails the length rule for those two, so use a 16+ character filler there.

Example override, `deploy/compose.secrets.yaml` (not tracked; keep the secret files outside the repository, readable by uid 1000):

```yaml
services:
  gsm:
    environment:
      ANTHROPIC_API_KEY_FILE: /run/secrets/anthropic_api_key
      GITHUB_TOKEN_FILE: /run/secrets/github_token
    secrets:
      - anthropic_api_key
      - github_token
secrets:
  anthropic_api_key:
    file: /home/bk/.gsm/anthropic_api_key
  github_token:
    file: /home/bk/.gsm/github_token
```

Start it with both files, naming the service:

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.secrets.yaml --env-file deploy/.env up -d gsm
```

`up.sh` and `update.sh` pass only `deploy/compose.yaml`, so use the command above to apply the override (a restart through `up.sh` would start the container without it).
## Minimum GitHub token scopes

The server calls GitHub for: `GET /user`, `GET /user/starred` (list), `GET /repos/{owner}/{repo}`, its README and releases, search, GraphQL, and `/rate_limit`. The only writes are the UI's star and unstar buttons (`PUT` and `DELETE /user/starred/{owner}/{repo}`).

Recommended: a **fine-grained personal access token** (GitHub, Settings, Developer settings, Fine-grained tokens).

| Setting | Value |
|---|---|
| Resource owner | your own account |
| Repository access | Public repositories (read-only) |
| Account permission: Starring | Read (set to Read and write only if you want the star/unstar buttons to work) |
| Repository permissions | none |
| Other account permissions | none |

Trade-off: a public-only fine-grained token cannot read your **private** starred repositories or the READMEs and releases of private repositories. If you need those, switch Repository access to "Only select repositories", add those repositories, and grant Metadata: Read and Contents: Read.

A classic token would need `public_repo` (or `repo` for private repositories). That is broader than needed, so it is not recommended.

Status: this table was derived from reading the code and GitHub's fine-grained token documentation. It has NOT been verified against a live token, and is marked "to confirm" against GitHub's current docs. The first star sync on CERES is the test; if a call returns 403, add the permission it names.
