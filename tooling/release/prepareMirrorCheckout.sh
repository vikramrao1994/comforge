#!/usr/bin/env bash
# Prepares the release candidate's mirror checkout without a credential and without the REST
# API (COMFORGE-PORTABILITY-001.cli). The previous probe, an anonymous GET on
# api.github.com/repos/<mirror>, shares the per-IP limit of 60 unauthenticated requests an hour
# with every other job on the runner's address and failed with HTTP 403 (run 45814971405). Git's
# smart-HTTP protocol reads a public repository without that API, so the probe is `git ls-remote`.
#
#   prepareMirrorCheckout.sh <repository-url> <destination>
#
# Exists (empty or not): cloned. Missing: an empty local repository on main, so the dry run can
# plan a first release. Anything else (network, server error): fails; nothing is guessed.
# Every outcome is reported as one GitHub Actions annotation naming its class (review L1); text
# from git is sanitized (credentials in URLs and token shapes masked) before it is printed.
set -euo pipefail
url="${1:?repository url}"
dest="${2:?destination}"
export GIT_TERMINAL_PROMPT=0
sanitize() { sed -E 's#://[^/@[:space:]]+@#://***@#g; s#(gh[pousr]_|github_pat_)[A-Za-z0-9_]+#***#g' | head -c 300; }
shown=$(sanitize <<<"$url")
if out=$(git ls-remote "$url" HEAD 2>&1); then
  if [[ -z "$out" ]]; then
    echo "::notice::mirror $shown is empty; cloning it as is"
  fi
  git clone -q "$url" "$dest"
  exit 0
fi
detail=$(sanitize <<<"$out")
if grep -qiE 'repository not found|does not appear to be a git repository|not found$' <<<"$out"; then
  echo "::notice::mirror $shown does not exist; planning a first release into an empty repository"
  git init -q -b main "$dest"
  exit 0
elif grep -qiE 'error: 429|rate limit' <<<"$out"; then
  echo "::error::mirror $shown: rate limited by the server; rerun later ($detail)"
elif grep -qiE 'error: 40[13]|authentication failed|could not read username|permission denied' <<<"$out"; then
  echo "::error::mirror $shown: access refused (401/403: authentication, permissions or a rate limit the server reports as 403) ($detail)"
elif grep -qiE 'could not resolve|failed to connect|connection refused|timed out|network is unreachable' <<<"$out"; then
  echo "::error::mirror $shown: unreachable ($detail)"
else
  echo "::error::Cannot read $shown: $detail"
fi
exit 1
