#!/usr/bin/env bash
set -euo pipefail

upstream_url="${1:?Supply the upstream Git URL}"
output="${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
selector="$(dirname "${BASH_SOURCE[0]}")/select-latest-stable-tag.sh"

git fetch --no-tags --no-recurse-submodules origin '+refs/heads/main:refs/remotes/origin/main'
fork_base="$(git rev-parse 'refs/remotes/origin/main^{commit}')"
printf 'fork_base=%s\n' "$fork_base" >> "$output"

# Keep fetched tags outside refs/tags so fork tags cannot affect selection.
git fetch --no-tags --no-recurse-submodules --prune -- "$upstream_url" \
  '+refs/heads/main:refs/remotes/upstream/main' \
  '+refs/tags/v*:refs/sync-upstream/tags/v*'
upstream_tag="$(
  git for-each-ref --format='%(refname:strip=3)' refs/sync-upstream/tags/ |
    bash "$selector"
)"
upstream_commit="$(git rev-parse "refs/sync-upstream/tags/${upstream_tag}^{commit}")"
printf 'upstream_tag=%s\nupstream_commit=%s\n' "$upstream_tag" "$upstream_commit" >> "$output"

if ! git merge-base --is-ancestor "$upstream_commit" refs/remotes/upstream/main; then
  echo "::error::${upstream_tag} is not reachable from upstream/main"
  exit 1
fi

if git merge-base --is-ancestor "$upstream_commit" "$fork_base"; then
  echo 'status=already-contained' >> "$output"
  exit 0
fi

git switch --create sync-upstream-candidate "$fork_base"
if ! git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  merge --no-ff --no-edit -m "Merge upstream ${upstream_tag}" "$upstream_commit"; then
  if [[ -n "$(git ls-files --unmerged)" ]]; then
    printf 'status=conflict\n' >> "$output"
    git diff --name-only --diff-filter=U
    echo "::error::Merge conflict between origin/main and ${upstream_tag}"
  fi
  if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
    git merge --abort
  fi
  exit 1
fi

candidate_commit="$(git rev-parse HEAD)"
candidate_tree="$(git rev-parse 'HEAD^{tree}')"
printf 'commit=%s\ntree=%s\nstatus=ready\n' "$candidate_commit" "$candidate_tree" >> "$output"
