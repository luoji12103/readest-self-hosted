#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
workflow="$ROOT_DIR/.github/workflows/sync-upstream.yml"
helper="$ROOT_DIR/scripts/prepare-upstream-candidate.sh"

fail() {
  echo "$*" >&2
  exit 1
}

for marker in \
  'ref: main' \
  'fetch-depth: 0' \
  'run: bash scripts/prepare-upstream-candidate.sh https://github.com/readest/readest.git' \
  "if: steps.candidate.outputs.status == 'ready'" \
  'bash scripts/test-prepare-selfhost-release.sh' \
  'bash scripts/test-selfhost-release-workflow.sh' \
  'bash scripts/test-selfhost-android-arm64-workflow.sh' \
  'node --test scripts/test-selfhost-legacy-updater.mjs' \
  'luarocks --lua-version=5.1 install busted' \
  'pnpm --filter @readest/readest-app test:lua' \
  'pnpm format:check' \
  'pnpm lint' \
  'pnpm --filter @readest/readest-app test --run' \
  'pnpm fmt:check' \
  'pnpm clippy:check' \
  'pnpm --filter @readest/readest-app build-web'; do
  rg -Fq "$marker" "$workflow" || fail "Missing sync workflow check: $marker"
done

fixture="$(mktemp -d)"
trap 'printf "Removing test fixture %s\n" "$fixture"; rm -r -- "${fixture:?}"' EXIT

# Use Git's real fetch and merge against local fixture repositories. Fail on any
# attempted publication, even if the workflow step would swallow its exit code.
TEST_REAL_GIT="$(command -v git)"
export TEST_REAL_GIT TEST_FORBIDDEN_LOG="$fixture/forbidden"
mkdir "$fixture/bin"
cat > "$fixture/bin/git" <<'WRAPPER'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    push|tag|rebase)
      printf 'git %s\n' "$arg" >> "$TEST_FORBIDDEN_LOG"
      exit 1 ;;
  esac
done
exec "$TEST_REAL_GIT" "$@"
WRAPPER
cat > "$fixture/bin/gh" <<'WRAPPER'
#!/usr/bin/env bash
printf '%s\n' "${0##*/}" >> "$TEST_FORBIDDEN_LOG"
exit 1
WRAPPER
chmod +x "$fixture/bin/git" "$fixture/bin/gh"
ln -s gh "$fixture/bin/curl"

summary_step="$(sed -n '/^      - name: Summarize upstream candidate$/,$p' "$workflow")"
rg -Fxq '        if: always()' <<< "$summary_step" || fail 'Candidate summary must run on failure'
sed -n '/^        run: |$/,$p' <<< "$summary_step" | sed '1d; s/^          //' > "$fixture/summary.sh"

commit_file() {
  local repo="$1" path="$2" contents="$3"
  printf '%s\n' "$contents" > "$repo/$path"
  git -C "$repo" add -- "$path"
  git -C "$repo" -c user.name='Test' -c user.email='test@example.com' -c commit.gpgSign=false \
    -c core.hooksPath=/dev/null commit --quiet -m "$contents"
}

upstream="$fixture/upstream"
fork="$fixture/fork"
git init --quiet --initial-branch=main "$upstream"
commit_file "$upstream" shared.txt common
git -C "$upstream" tag v1.2.9
git clone --quiet "$upstream" "$fork"
git -C "$fork" switch --quiet -c selfhost-main
commit_file "$fork" retired.txt retired
git -C "$fork" switch --quiet main
commit_file "$fork" selfhost.txt customization
fork_base="$(git -C "$fork" rev-parse HEAD)"
git -C "$fork" tag v999.0.0
git -C "$fork" tag selfhost-v1.2.10
commit_file "$upstream" shared.txt upstream-stable
upstream_commit="$(git -C "$upstream" rev-parse HEAD)"
git -C "$upstream" -c user.name=Test -c user.email=test@example.com \
  tag -a v1.2.10 -m stable
commit_file "$upstream" rolling.txt upstream-rolling
git -C "$upstream" tag v9.0.0-rc.1
git -C "$upstream" tag v09.0.0

run_candidate() {
  local label="$1" origin="$2" expected_result="$3" existing_branch="${4:-}"
  local runner="$fixture/$label" before_runner before_origin before_upstream result=0
  git clone --quiet "$origin" "$runner"
  git -C "$runner" fetch --quiet "$fork" refs/heads/selfhost-main
  git -C "$runner" switch --quiet --detach FETCH_HEAD
  if [[ -n "$existing_branch" ]]; then
    git -C "$runner" branch sync-upstream-candidate "$existing_branch"
  fi
  before_runner="$(git -C "$runner" show-ref --heads --tags | awk '$2 != "refs/heads/sync-upstream-candidate"')"
  before_origin="$(git -C "$origin" show-ref)"
  before_upstream="$(git -C "$upstream" show-ref)"
  (
    cd "$runner"
    PATH="$fixture/bin:$PATH" GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 \
      GITHUB_OUTPUT="$fixture/$label.out" bash "$helper" "$upstream"
  ) > "$fixture/$label.log" 2>&1 || result=$?
  if [[ "$result" != "$expected_result" ]]; then
    cat "$fixture/$label.log" >&2
    fail "$label: expected exit $expected_result, got $result"
  fi
  [[ "$before_runner" == "$(git -C "$runner" show-ref --heads --tags | awk '$2 != "refs/heads/sync-upstream-candidate"')" ]] ||
    fail "$label: existing local branch or tag changed"
  [[ "$before_origin" == "$(git -C "$origin" show-ref)" ]] || fail "$label: fork refs changed"
  [[ "$before_upstream" == "$(git -C "$upstream" show-ref)" ]] || fail "$label: upstream refs changed"
  [[ ! -s "$TEST_FORBIDDEN_LOG" ]] || fail "$label: prohibited command attempted: $(cat "$TEST_FORBIDDEN_LOG")"
}

output_value() {
  sed -n "s/^$2=//p" "$fixture/$1.out"
}

assert_output() {
  [[ "$(output_value "$1" "$2")" == "$3" ]] || fail "$1: expected $2=$3"
}

assert_summary() {
  local label="$1" status="$2" expected="$3"
  GITHUB_STEP_SUMMARY="$fixture/$label-$status.summary" \
    CANDIDATE_STATUS="$(output_value "$label" status)" \
    CANDIDATE_COMMIT="$(output_value "$label" commit)" \
    CANDIDATE_TREE="$(output_value "$label" tree)" \
    FORK_BASE="$(output_value "$label" fork_base)" \
    UPSTREAM_TAG="$(output_value "$label" upstream_tag)" \
    UPSTREAM_COMMIT="$(output_value "$label" upstream_commit)" \
    JOB_STATUS="$status" PATH="$fixture/bin:$PATH" \
    bash "$fixture/summary.sh"
  rg -Fq "$expected" "$fixture/$label-$status.summary" || fail "$label: missing summary for $status"
  [[ ! -s "$TEST_FORBIDDEN_LOG" ]] || fail "$label: prohibited command attempted in summary"
}

run_candidate ready "$fork" 0
assert_output ready status ready
assert_output ready fork_base "$fork_base"
assert_output ready upstream_tag v1.2.10
assert_output ready upstream_commit "$upstream_commit"
candidate="$(git -C "$fixture/ready" rev-parse HEAD)"
[[ "$(git -C "$fixture/ready" branch --show-current)" == sync-upstream-candidate ]] || fail 'Candidate was not made on the temporary branch'
assert_output ready commit "$candidate"
assert_output ready tree "$(git -C "$fixture/ready" rev-parse 'HEAD^{tree}')"
[[ "$(git -C "$fixture/ready" show -s --format=%P "$candidate")" == "$fork_base $upstream_commit" ]] || fail 'Candidate must merge the two expected parents'
[[ "$(git -C "$fixture/ready" ls-tree --name-only HEAD)" == $'selfhost.txt\nshared.txt' ]] || fail 'Candidate included retired or rolling files, or lost fork files'
assert_summary ready success '**Passed:**'
assert_summary ready failure '**Validation failed:**'
assert_summary ready cancelled '**Cancelled:**'
rg -Fq "$candidate" "$fixture/ready-success.summary" || fail 'Summary omitted the candidate SHA'

contained_origin="$fixture/fork-contained"
git clone --quiet "$fork" "$contained_origin"
git -C "$contained_origin" fetch --quiet --no-tags "$fixture/ready" HEAD
git -C "$contained_origin" merge --quiet --ff-only FETCH_HEAD
run_candidate contained "$contained_origin" 0
assert_output contained status already-contained
assert_output contained commit ''
if git -C "$fixture/contained" show-ref --verify --quiet refs/heads/sync-upstream-candidate; then
  fail 'Already contained created a candidate branch'
fi
assert_summary contained success '**Already contained:**'

conflict_origin="$fixture/fork-conflict"
git clone --quiet "$fork" "$conflict_origin"
commit_file "$conflict_origin" shared.txt fork-conflict
run_candidate conflict "$conflict_origin" 1
assert_output conflict status conflict
assert_output conflict commit ''
[[ -z "$(git -C "$fixture/conflict" status --porcelain)" ]] || fail 'Merge conflict was not cleaned up'
rg -Fxq shared.txt "$fixture/conflict.log" || fail 'Conflict log omitted the conflicting file'
assert_summary conflict failure '**Merge conflict:**'

run_candidate existing-branch "$fork" 128 v1.2.9
assert_output existing-branch commit ''
[[ "$(git -C "$fixture/existing-branch" rev-parse sync-upstream-candidate)" == "$(git -C "$fork" rev-parse v1.2.9)" ]] ||
  fail 'Existing local branch was replaced'
assert_summary existing-branch failure '**Preparation failed:**'

git -C "$upstream" switch --quiet -c unrelated v1.2.9
commit_file "$upstream" off-main.txt off-main
git -C "$upstream" tag v10.0.0
git -C "$upstream" switch --quiet main
run_candidate unreachable "$fork" 1
assert_output unreachable upstream_tag v10.0.0
assert_output unreachable commit ''
rg -Fq 'v10.0.0 is not reachable from upstream/main' "$fixture/unreachable.log" || fail 'Unreachable tag was not reported'
assert_summary unreachable failure '**Preparation failed:**'

echo 'Stable sync workflow contract tests passed.'
