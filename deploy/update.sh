#!/usr/bin/env bash
# Pull in upstream changes after you confirm, re-run the checks, then rebuild and restart.
# Safe to run from any directory. Merges only (never rebases or force-pushes).
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
  if [ "$merging" -eq 1 ] && [ -f .git/MERGE_HEAD ]; then
    echo "  git merge --abort" >&2
  fi
  echo "  git reset --hard $prev_sha   # only if the merge already completed" >&2
}
trap on_fail ERR

git fetch upstream
count="$(git rev-list --count HEAD..upstream/main)"
if [ "$count" -eq 0 ]; then
  echo "Already up to date with upstream/main. Nothing to merge."
  read -r -p "Rebuild and restart anyway? Type yes: " again
  [ "$again" = "yes" ] && exec deploy/up.sh
  exit 0
fi

echo "$count new upstream commit(s):"
git log --oneline HEAD..upstream/main
echo
git diff --stat HEAD...upstream/main | tail -n 25
echo
read -r -p "Merge upstream/main into hardened? Type yes to continue: " answer
if [ "$answer" != "yes" ]; then
  echo "Aborted. Nothing changed."
  trap - ERR
  exit 1
fi

merging=1
git merge --no-edit upstream/main
merging=0

echo "Merged. Running checks ..."
npm ci --no-audit --no-fund
npm run check:egress
npm run test:run
(cd server && npm ci --no-audit --no-fund && npm test)

echo "Checks passed. Rebuilding and restarting ..."
trap - ERR
if ! deploy/up.sh; then
  echo >&2
  echo "The checks passed but the container did not come up healthy. To go back:" >&2
  echo "  git reset --hard $prev_sha && deploy/up.sh" >&2
  exit 1
fi
