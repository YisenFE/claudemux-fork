#!/usr/bin/env bats
#
# Regression tests for hooks/on-session-start-recall.sh — the dispatcher
# SessionStart "recent-work recall" hook. The CI bats lane runs the plugin's
# test/cli/ on both Linux and macOS.
#
# A fake `tm` on PATH stands in for the real CLI so each test controls the
# history output (and its exit code) deterministically; the real `jq` stays
# reachable through the inherited PATH.

setup() {
  load "$BATS_TEST_DIRNAME/../test_helper.bash"
  HOOK="$PLUGIN_ROOT/hooks/on-session-start-recall.sh"
  WORK="$(mktemp -d)"
  BIN="$WORK/bin"
  mkdir -p "$BIN"
}

teardown() {
  rm -rf "$WORK"
}

# Write a fake `tm` that prints the given lines (one per argument) and exits 0.
write_fake_tm() {
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf "%%s\\n"'
    local line
    for line in "$@"; do printf ' %q' "$line"; done
    printf '\n'
  } > "$BIN/tm"
  chmod +x "$BIN/tm"
}

# Write a fake `tm` that prints nothing to stdout and exits with $1.
write_failing_tm() {
  printf '#!/usr/bin/env bash\necho "tm boom" >&2\nexit %s\n' "$1" > "$BIN/tm"
  chmod +x "$BIN/tm"
}

# Run the hook as a dispatcher session (both gates satisfied) unless overridden.
run_recall() {
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$WORK/dispatcher" \
    PATH="$BIN:$PATH" bash "$HOOK"
}

@test "recall: no-op when TM_DISPATCHER_DIR is unset (not a dispatcher session)" {
  write_fake_tm "id1 codex idle repoA t1 should not appear"
  run env -u TM_DISPATCHER_DIR -u CLAUDEMUX_TEAMMATE_NAME PATH="$BIN:$PATH" bash "$HOOK"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: no-op inside a teammate (CLAUDEMUX_TEAMMATE_NAME set) even with TM_DISPATCHER_DIR" {
  write_fake_tm "id1 codex idle repoA t1 should not appear"
  run env TM_DISPATCHER_DIR="$WORK/dispatcher" CLAUDEMUX_TEAMMATE_NAME=alice \
    PATH="$BIN:$PATH" bash "$HOOK"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: dispatcher session emits SessionStart additionalContext JSON" {
  write_fake_tm \
    "id1 codex idle repoA t1 did thing one" \
    'id2 claude busy repoB t2 中文 intent "two"' \
    "id3 claude idle repoA t3 third"
  run_recall
  [ "$status" -eq 0 ]
  # Valid JSON, exact camelCase shape.
  echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null
  # additionalContext carries the history rows, including unicode + quotes.
  ctx="$(echo "$output" | jq -r '.hookSpecificOutput.additionalContext')"
  echo "$ctx" | grep -q "id1 codex idle repoA"
  echo "$ctx" | grep -q '中文 intent "two"'
  echo "$ctx" | grep -q "id3 claude idle repoA"
}

@test "recall: oversized history is truncated under the budget, newest kept, pointer appended" {
  local lines=()
  for i in $(seq 1 400); do
    lines+=("id$i claude idle repoX t$i a reasonably long intent line number $i to blow the budget out")
  done
  write_fake_tm "${lines[@]}"
  run_recall
  [ "$status" -eq 0 ]
  ctx="$(echo "$output" | jq -r '.hookSpecificOutput.additionalContext')"
  [ "${#ctx}" -lt 10000 ]
  # newest-first input → the first row survives, the truncation pointer is last.
  echo "$ctx" | grep -q "id1 claude idle repoX"
  echo "$ctx" | tail -1 | grep -q "truncated to the most recent"
  # the last kept history row is a complete row, not cut mid-string.
  echo "$ctx" | grep -v "truncated" | tail -1 | grep -qE '^id[0-9]+ claude idle repoX'
}

@test "recall: tm history failure degrades to a silent no-op (no stdout, no stderr)" {
  write_failing_tm 1
  run_recall
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: empty history produces no context" {
  write_fake_tm ""
  run_recall
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: no-op when tm is not on PATH" {
  # A minimal PATH that can find `bash` (to run the hook) but not `tm`.
  mkdir -p "$WORK/minbin"
  ln -s "$(command -v bash)" "$WORK/minbin/bash"
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$WORK/dispatcher" \
    PATH="$WORK/minbin" bash "$HOOK"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
