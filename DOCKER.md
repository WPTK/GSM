# Docker (hardened fork)

This fork runs as one container built from this checkout. It does not use or publish any registry image. The full guide, including the CERES bring-up commands, is [deploy/README.md](deploy/README.md); this page is the short version.

## What you get

- One Node/Express process serving the web app, `/api` and the MCP endpoint, as user `node` (uid 1000).
- A read-only root filesystem, no Linux capabilities, `no-new-privileges`, a 1 GB memory limit (adjust after measuring with `docker stats`), rotated logs.
- The port published on `127.0.0.1` only (default 8765). You reach it from your own devices with `tailscale serve`, which gives it HTTPS. Reasoning is in deploy/README.md.
- Data in the named volume `gsm-data`; backups go to a bind-mounted `backups` directory in the repository root (or `GSM_BACKUP_DIR`), which must be owned by uid 1000.

## Run it

```bash
cp deploy/.env.example deploy/.env      # fill in the four required values
./deploy/up.sh                         # creates backups/ and warns if it is not owned by uid 1000
sudo chown 1000:1000 backups           # once, if up.sh warned
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8765
```

## Required settings

| Variable | What it is |
|---|---|
| `API_SECRET` | Login secret for the UI and API (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | Encrypts stored secrets (`openssl rand -hex 32`; reuse the old `data/.encryption-key` value if migrating) |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `GITHUB_TOKEN` | Fine-grained token; scopes are in deploy/README.md |

The container refuses to start if any of these is missing. Each also accepts a `*_FILE` variant (the file wins if both are set; the plain variable must still be non-empty for this compose file, see "Docker secrets" in deploy/README.md). Optional settings (`GSM_PORT`, `GSM_BACKUP_DIR`, `CLAUDE_MODEL_BULK`, `CLAUDE_MODEL_CHAT`, `AI_SPEND_CONFIRM_USD`, `OUTBOUND_ALLOWLIST`, `TRUST_PROXY`, `CSP_UPGRADE_INSECURE_REQUESTS`) are listed in `deploy/.env.example`.

## GitHub token scopes

Fine-grained token, Resource owner = your account, Repository access = Public repositories (read-only), Account permission Starring = Read (Read and write only if you want the star/unstar buttons). No other permissions. A public-only token cannot see private starred repositories; add them under "Only select repositories" with Metadata and Contents: Read if you need that. Derived from the code and GitHub's docs, not yet verified against a live token. Details: deploy/README.md.

## Operate it

```bash
docker logs --tail 100 -f gsm
docker stats --no-stream gsm
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d gsm   # apply an .env change
./deploy/update.sh                                                       # merge upstream after you confirm (needs Node 22+ and npm on the host)
```

Always name the service; never run a bare `up -d` or `down`.

## Requirements

The server needs internet at startup (it checks the Anthropic Models API) and reaches only the hosts on its outbound allowlist.
