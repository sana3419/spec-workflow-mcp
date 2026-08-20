#!/bin/bash
# SessionStart: is this project set up? Answered from a recorded parameter, not by probing.
#
# ~/.spec-workflow/projects.json holds one entry per project ("initialized" / "pending" / "ignored").
# The steady state is a single jq lookup — no directory scanning, no repeated prompts. Only the FIRST
# time a directory is seen do we detect anything, and the outcome is written back so it never repeats.
# The notice never initialises anything: writing files and picking components is the user's call.
set -u
PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$PROJECT" 2>/dev/null || exit 0
PROJECT="$(pwd -P)"
STATE="$HOME/.spec-workflow/projects.json"

status=""
if [ -f "$STATE" ] && command -v jq >/dev/null 2>&1; then
  status="$(jq -r --arg p "$PROJECT" '.[$p].status // empty' "$STATE" 2>/dev/null)"
fi

case "$status" in
  initialized|ignored) exit 0 ;;                      # recorded: nothing to do, nothing to check
  pending) ;;                                          # recorded as not set up → remind again below
  *)
    # First sight of this directory: detect once, then record the answer.
    new="pending"
    [ -d .spec-workflow ] && new="initialized"
    [ -f .spec-workflow-ignore ] && new="ignored"
    if [ "$new" = "pending" ]; then
      is_project=0
      for m in .git package.json pyproject.toml go.mod Cargo.toml pom.xml build.gradle Gemfile composer.json; do
        [ -e "$m" ] && { is_project=1; break; }
      done
      [ "$is_project" = 0 ] && new="ignored"           # not a project — never ask again
    fi
    mkdir -p "$HOME/.spec-workflow" 2>/dev/null
    if command -v jq >/dev/null 2>&1; then
      [ -f "$STATE" ] || echo '{}' > "$STATE"
      TMP="$(mktemp)" && jq --arg p "$PROJECT" --arg s "$new" --arg at "$(date -u +%FT%TZ)" \
        '.[$p] = {status: $s, at: $at}' "$STATE" > "$TMP" 2>/dev/null && mv "$TMP" "$STATE" && chmod 600 "$STATE"
    fi
    status="$new"
    ;;
esac

[ "$status" = "pending" ] || exit 0

cat <<'MSG'
spec-workflow: this project is not set up yet (recorded as "pending").

  /spec-workflow:init      set it up — writes .spec-workflow/, CLAUDE.md and the loop runner, then
                           opens a search-and-add picker for MCP servers and skills (nothing is
                           installed unless you pick it). init records the state, so this stops.
  Not this repo?           spec-workflow-mcp project mark ignored     (or: touch .spec-workflow-ignore)
MSG
