#!/usr/bin/env bash
# test-setup.sh — conformance test for setup.sh.
#
# Runs setup.sh through 8 scenarios under a disposable /tmp/ root and
# asserts the key file / output state. Designed for hand-running and CI:
#
#   bash plugins/claudemux/scripts/test-setup.sh
#
# Exit 0 if all scenarios pass; non-zero on any failure. The script wipes
# its /tmp/claudemux-conformance/ working tree at the start of every run.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="$SCRIPT_DIR/setup.sh"
BASE=/tmp/claudemux-conformance
PASS=0
FAIL=0

red()   { printf '\033[31m%s\033[0m' "$1"; }
green() { printf '\033[32m%s\033[0m' "$1"; }

assert() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        PASS=$((PASS+1))
        printf '  %s %s\n' "$(green PASS)" "$desc"
    else
        FAIL=$((FAIL+1))
        printf '  %s %s\n' "$(red FAIL)" "$desc"
    fi
}

# helpers. mkscen takes a scenario slug, wipes any prior scenario tree,
# creates a fresh dir, and prints its path. The ${VAR:?} guards around
# the rm path prevent the script from expanding to `rm -rf /` if BASE or
# the scenario slug ever go unset (ShellCheck SC2115).
mkscen() {
    local slug="${1:?mkscen: scenario slug required}"
    rm -rf "${BASE:?}/${slug:?}" && mkdir -p "${BASE:?}/${slug:?}" && echo "${BASE:?}/${slug:?}"
}
runsetup() { (cd "$1" && bash "$SETUP" "${@:2}" 2>&1); }
file_exists() { [[ -f "$1" ]]; }
contains() { grep -qF "$2" "$1"; }
not_contains() { ! grep -qF "$2" "$1"; }
file_html_only() {
    # 0 iff every non-blank line in the file is inside an HTML comment.
    awk 'BEGIN{c=0;f=0} /<!--/{c=1} /-->/{c=0;next} !c && NF{f=1} END{exit f}' "$1"
}

rm -rf "${BASE:?}"
mkdir -p "${BASE:?}"

echo "== S1 — fresh install =="
DIR=$(mkscen s1)
OUT=$(runsetup "$DIR")
assert "CLAUDE.md exists" file_exists "$DIR/CLAUDE.md"
assert ".workspace/imports.md exists" file_exists "$DIR/.workspace/imports.md"
assert "profile/persona.md exists" file_exists "$DIR/.workspace/profile/persona.md"
assert "profile/user-profile.md exists" file_exists "$DIR/.workspace/profile/user-profile.md"
assert "profile/principles.md exists" file_exists "$DIR/.workspace/profile/principles.md"
assert "CLAUDE.md has marker block" contains "$DIR/CLAUDE.md" "<!-- claudemux-workspace-imports:start -->"
assert "imports.md has @profile/persona.md" contains "$DIR/.workspace/imports.md" "@profile/persona.md"
assert ".workspace/.git/ exists" file_exists "$DIR/.workspace/.git/HEAD"
assert "stdout: workspace imports: active" grep -q "workspace imports: active" <<<"$OUT"

echo "== S2 — profile stubs are HTML-comment only =="
assert "persona.md HTML-only" file_html_only "$DIR/.workspace/profile/persona.md"
assert "user-profile.md HTML-only" file_html_only "$DIR/.workspace/profile/user-profile.md"
assert "principles.md HTML-only" file_html_only "$DIR/.workspace/profile/principles.md"

echo "== S3 — legacy CLAUDE.md without --force =="
DIR=$(mkscen s3)
printf '# Legacy\n\nCustom body line.\n' > "$DIR/CLAUDE.md"
OUT=$(runsetup "$DIR")
assert "stdout: workspace imports: inactive" grep -q "workspace imports: inactive" <<<"$OUT"
assert "CLAUDE.md unchanged (no marker)" not_contains "$DIR/CLAUDE.md" "<!-- claudemux-workspace-imports:start -->"
assert "CLAUDE.md body preserved" contains "$DIR/CLAUDE.md" "Custom body line"
assert ".workspace/ still seeded" file_exists "$DIR/.workspace/imports.md"
assert "final report: NOT YET ACTIVE" grep -q "NOT YET ACTIVE" <<<"$OUT"

echo "== S4 — --force injects marker, preserves body =="
OUT=$(runsetup "$DIR" --force)
assert "stdout: injected marker" grep -q "injected @.workspace/imports.md marker block" <<<"$OUT"
assert "CLAUDE.md now has marker" contains "$DIR/CLAUDE.md" "<!-- claudemux-workspace-imports:start -->"
assert "CLAUDE.md body still present" contains "$DIR/CLAUDE.md" "Custom body line"
assert "stdout: imports: active after --force" grep -q "workspace imports: active" <<<"$OUT"

echo "== S5 — no-heading CLAUDE.md, marker appended =="
DIR=$(mkscen s5)
printf 'no heading anywhere\nsome flat text\n' > "$DIR/CLAUDE.md"
OUT=$(runsetup "$DIR" --force)
assert "marker injected" contains "$DIR/CLAUDE.md" "<!-- claudemux-workspace-imports:start -->"
LAST=$(tail -3 "$DIR/CLAUDE.md" | head -1)
assert "marker appended near end" [ "$LAST" = "<!-- claudemux-workspace-imports:start -->" ]

echo "== S6 — --force marker idempotence =="
OUT=$(runsetup "$DIR" --force)
assert "stdout: already has marker" grep -q "already has the workspace imports marker" <<<"$OUT"
MARKERS=$(grep -cF "<!-- claudemux-workspace-imports:start -->" "$DIR/CLAUDE.md")
assert "exactly one marker block" [ "$MARKERS" = "1" ]

echo "== S7 — user-edited imports.md is preserved =="
DIR=$(mkscen s7)
runsetup "$DIR" >/dev/null
printf '\n# my customizations\n@profile/extra.md\n' >> "$DIR/.workspace/imports.md"
runsetup "$DIR" >/dev/null
assert "custom heading preserved" contains "$DIR/.workspace/imports.md" "# my customizations"
assert "custom @profile/extra.md preserved" contains "$DIR/.workspace/imports.md" "@profile/extra.md"

echo "== S8 — .workspace as symlink =="
DIR=$(mkscen s8)
EXT="$BASE/s8-external"
mkdir -p "$EXT"
ln -s "$EXT" "$DIR/.workspace"
OUT=$(runsetup "$DIR")
assert "stdout: refusing symlink" grep -q "refusing to seed scaffold or git init" <<<"$OUT"
assert "stdout: skipped git init" grep -q "skipped .workspace/ git init (symlink)" <<<"$OUT"
assert "link target has no .git/" [ ! -e "$EXT/.git" ]
assert "link target has no imports.md" [ ! -e "$EXT/imports.md" ]
assert "final report: symlink branch" grep -q "is a symlink — setup did NOT seed" <<<"$OUT"

echo ""
echo "summary: $PASS passed / $FAIL failed"
[[ $FAIL -eq 0 ]]
