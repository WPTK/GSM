#!/usr/bin/env bash
# Pull in upstream changes after you confirm, re-run the checks, then rebuild and restart.
# Safe to run from any directory. Merges only (never rebases or force-pushes).
# Needs Node 22+ and npm on this host (it runs the merged tree's npm scripts and tests here), plus Docker.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash your changes first." >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "hardened" ]; then
  echo "You are on '$branch', not 'hardened'. Check out hardened first." >&2
  exit 1
fi

prev_sha="$(git rev-parse HEAD)"
merging=0
on_fail() {
  echo >&2
  echo "Update failed. Nothing was pushed. To go back to where you were:" >&2
  if [ "$merging" -eq 1 ] && git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    echo "  git merge --abort" >&2
  fi
  echo "  git reset --hard $prev_sha   # only if the merge already completed" >&2
}
trap on_fail ERR

# Leave without the 'Update failed' hint: nothing has changed yet.
abort_clean() {
  trap - ERR
  echo "$1 Aborted. Nothing changed."
  exit 1
}

# The original project, fetch-only. Add it if missing, and make sure nothing can be pushed to it.
UPSTREAM_URL=https://github.com/AmintaCCCP/GithubStarsManager.git
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
git remote set-url --push upstream DISABLED

git fetch upstream
count="$(git rev-list --count HEAD..upstream/main)"
if [ "$count" -eq 0 ]; then
  echo "Already up to date with upstream/main. Nothing to merge."
  read -r -p "Rebuild and restart anyway? Type yes: " again || { echo; abort_clean "No input."; }
  [ "$again" = "yes" ] && exec deploy/up.sh
  exit 0
fi

echo "$count new upstream commit(s):"
git --no-pager log --oneline HEAD..upstream/main
echo
git --no-pager diff --stat HEAD...upstream/main | tail -n 25
echo

# The files this fork's hardening depends on. A change here needs reading, not skimming.
CRITICAL=(server/src/middleware server/src/preflight.ts server/src/secrets.ts server/src/config.ts
          server/src/routes/session.ts deploy Dockerfile.fullstack)
critical_stat="$(git --no-pager diff --stat HEAD...upstream/main -- "${CRITICAL[@]}")"
if [ -n "$critical_stat" ]; then
  echo "WARNING: upstream changes files the hardening depends on:"
  echo "$critical_stat"
  echo "Read the full diff before you say yes:"
  echo "  git diff HEAD...upstream/main -- ${CRITICAL[*]}"
  echo
fi

read -r -p "Merge upstream/main into hardened? Type yes to continue: " answer || { echo; abort_clean "No input."; }
if [ "$answer" != "yes" ]; then
  abort_clean "Not confirmed."
fi

merging=1
git merge --no-edit upstream/main
merging=0

echo "Merged. Running checks ..."
npm ci --no-audit --no-fund
(cd server && npm ci --no-audit --no-fund)
npm run check:egress
npm run test:run
(cd server && npm test)

echo "Checks passed. Rebuilding and restarting ..."
trap - ERR
if ! deploy/up.sh; then
  echo >&2
  echo "The checks passed but the container did not come up healthy. To go back:" >&2
  echo "  git reset --hard $prev_sha && deploy/up.sh" >&2
  exit 1
fi
