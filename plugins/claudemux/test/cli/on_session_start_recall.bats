#!/usr/bin/env bats
#
# Regression tests for hooks/on-session-start-recall.sh — the dispatcher
# SessionStart "recent-work recall" hook. The CI bats lane runs the plugin's
# test/cli/ on both Linux and macOS.
#
# A fake `tm` on PATH stands in for the real CLI so each test controls the
# history output (and its exit code) deterministically; the real `jq` stays
# reachable through the inherited PATH. The hook reads the SessionStart `cwd`
# from JSON stdin, so each dispatcher-path test feeds a payload.

setup() {
  load "$BATS_TEST_DIRNAME/../test_helper.bash"
  HOOK="$PLUGIN_ROOT/hooks/on-session-start-recall.sh"
  WORK="$(mktemp -d)"
  BIN="$WORK/bin"
  DISP="$WORK/dispatcher"
  mkdir -p "$BIN" "$DISP"
  # `tm` resolution prefers ${CLAUDE_PLUGIN_ROOT}/bin/tm over PATH. Unset it so
  # the PATH-based fake-tm tests stay deterministic regardless of the runner's
  # environment; the plugin-root tests set it explicitly.
  unset CLAUDE_PLUGIN_ROOT
}

teardown() {
  rm -rf "$WORK"
}

# A SessionStart hook JSON payload with the given cwd.
payload() {
  printf '{"session_id":"s1","cwd":"%s","source":"compact","hook_event_name":"SessionStart"}' "$1"
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

# Write a fake `tm` at $1/bin/tm (a stand-in CLAUDE_PLUGIN_ROOT layout) that
# prints the remaining args, one per line, and exits 0.
write_root_tm() {
  local root="$1"; shift
  mkdir -p "$root/bin"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf "%%s\\n"'
    local line
    for line in "$@"; do printf ' %q' "$line"; done
    printf '\n'
  } > "$root/bin/tm"
  chmod +x "$root/bin/tm"
}

# Build a PATH directory carrying the hook's helper tools (so gate 3 and the jq
# guard still work) but deliberately NOT tm — the stale-PATH shape after a
# plugin reload drops the plugin's bin/ off PATH. Prints the directory.
tools_without_tm() {
  local d="$WORK/tools" t p
  mkdir -p "$d"
  for t in env bash cat sed head jq; do
    p="$(command -v "$t" 2>/dev/null)" && [ -n "$p" ] && ln -sf "$p" "$d/$t"
  done
  printf '%s' "$d"
}

# Run the hook as a dispatcher session: both env gates satisfied and the
# stdin cwd equal to TM_DISPATCHER_DIR.
run_recall() {
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$DISP" \
    PATH="$BIN:$PATH" bash "$HOOK" <<<"$(payload "$DISP")"
}

@test "recall: no-op when TM_DISPATCHER_DIR is unset (not a dispatcher session)" {
  write_fake_tm "id1 codex idle repoA t1 should not appear"
  run env -u TM_DISPATCHER_DIR -u CLAUDEMUX_TEAMMATE_NAME PATH="$BIN:$PATH" \
    bash "$HOOK" <<<"$(payload "$DISP")"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: no-op inside a teammate (CLAUDEMUX_TEAMMATE_NAME set) even when the cwd matches" {
  write_fake_tm "id1 codex idle repoA t1 should not appear"
  run env TM_DISPATCHER_DIR="$DISP" CLAUDEMUX_TEAMMATE_NAME=alice \
    PATH="$BIN:$PATH" bash "$HOOK" <<<"$(payload "$DISP")"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: no-op when the cwd resolves to a different path than TM_DISPATCHER_DIR (leaked env)" {
  mkdir -p "$WORK/elsewhere"
  write_fake_tm "id1 codex idle repoA t1 should not appear"
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$DISP" \
    PATH="$BIN:$PATH" bash "$HOOK" <<<"$(payload "$WORK/elsewhere")"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: injects when cwd and TM_DISPATCHER_DIR differ by a symlink but resolve to the same path" {
  # The deployment shape observed on a host where the home path is a symlink
  # (e.g. TM_DISPATCHER_DIR=/home/u/dev, SessionStart cwd=/data00/home/u/dev):
  # different strings, same realpath. The gate realpath-resolves BOTH sides, so
  # it must still inject — a literal string compare would wrongly reject it.
  mkdir -p "$WORK/real"
  ln -s "$WORK/real" "$WORK/link"
  write_fake_tm "id1 codex idle repoA t1 real dispatcher work"
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$WORK/link" \
    PATH="$BIN:$PATH" bash "$HOOK" <<<"$(payload "$WORK/real")"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null
  echo "$output" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "id1 codex idle repoA"
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

@test "recall: no-op when tm resolves via neither \${CLAUDE_PLUGIN_ROOT} nor PATH" {
  # CLAUDE_PLUGIN_ROOT is unset (setup) and PATH can find bash + the stdin-parse
  # tools (cat/sed/head) but not tm → both resolution paths miss → silent no-op.
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$DISP" \
    PATH="/usr/bin:/bin" bash "$HOOK" <<<"$(payload "$DISP")"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "recall: prefers \${CLAUDE_PLUGIN_ROOT}/bin/tm over a tm on PATH" {
  # The plugin-root path is the version-coherent resolution; it must win over a
  # tm reachable through PATH.
  local root="$WORK/plugin"
  write_root_tm "$root" "id9 codex idle repoR t9 from plugin-root tm"
  write_fake_tm "id1 codex idle repoA t1 from PATH tm"
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$DISP" \
    CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" bash "$HOOK" <<<"$(payload "$DISP")"
  [ "$status" -eq 0 ]
  ctx="$(echo "$output" | jq -r '.hookSpecificOutput.additionalContext')"
  echo "$ctx" | grep -q "from plugin-root tm"
  ! echo "$ctx" | grep -q "from PATH tm"
}

@test "recall: resolves tm via \${CLAUDE_PLUGIN_ROOT}/bin/tm when tm is off PATH" {
  # The drift this guards: after a plugin version change reloads plugins, tm can
  # drop off PATH. The absolute plugin-root path still resolves, so the hook
  # keeps injecting instead of silently degrading to a no-op.
  local root="$WORK/plugin"
  write_root_tm "$root" "id9 codex idle repoR t9 survived stale PATH"
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$DISP" \
    CLAUDE_PLUGIN_ROOT="$root" PATH="$(tools_without_tm)" \
    bash "$HOOK" <<<"$(payload "$DISP")"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null
  echo "$output" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "survived stale PATH"
}

@test "recall: falls back to PATH tm when \${CLAUDE_PLUGIN_ROOT}/bin/tm is not executable" {
  # CLAUDE_PLUGIN_ROOT is set but carries no usable bin/tm → the -x guard fails
  # and resolution falls back to PATH.
  local root="$WORK/empty-plugin"
  mkdir -p "$root/bin"
  write_fake_tm "id1 codex idle repoA t1 from PATH fallback"
  run env -u CLAUDEMUX_TEAMMATE_NAME TM_DISPATCHER_DIR="$DISP" \
    CLAUDE_PLUGIN_ROOT="$root" PATH="$BIN:$PATH" bash "$HOOK" <<<"$(payload "$DISP")"
  [ "$status" -eq 0 ]
  echo "$output" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "from PATH fallback"
}
