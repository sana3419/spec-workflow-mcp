#!/bin/bash
# Search-and-add installer: nothing is pre-installed, you look things up and add them until done.
#
# Sources searched (all live, nothing vendored):
#   curated   templates/catalog.json — entries we verified (licence + install command)
#   plugins   the Claude Code marketplaces on this machine — their skills/agents are COPIED into
#             .claude/ directly (no `claude plugin install`), so the project owns plain files
#   npm       registry.npmjs.org — MCP servers published as packages
#
# Licence rule: an item is only offered when its licence can be read from the source. "unknown" is
# shown but refused, because this repo is GPL-3.0 and an unverifiable licence cannot be recommended.

SEARCH_CACHE="${TMPDIR:-/tmp}/spec-workflow-search.$$"
trap 'rm -f "$SEARCH_CACHE".* 2>/dev/null' EXIT

# --- individual sources -------------------------------------------------------------------------
# Each prints TSV: kind \t id \t name \t licence \t description \t install \t server \t command \t args-json \t url \t env-json
# Empty fields are written as "-" — tab is whitespace to `read`, which silently collapses runs of it
# and would shift every column after the first empty one.
_dash() { [ "$1" = "-" ] && printf '' || printf '%s' "$1"; }

_search_catalog() {
  local q="$1" catalog="$2"
  [ -f "$catalog" ] || return 0
  jq -r --arg q "$q" '
    (.mcp[]? | . + {_k:"mcp"}), (.skills[]? | . + {_k:"skill"})
    | select((.name + " " + .description + " " + (.tags // [] | join(" "))) | ascii_downcase | contains($q | ascii_downcase))
    | [._k, .id, .name, (.license // "unknown"), .description,
       (if (.install // "") == "" then "-" else .install end),
       (if (.server // "") == "" then "-" else .server end),
       (if (.command // "") == "" then "-" else .command end),
       ((.args // []) | tostring),
       (if (.url // "") == "" then "-" else .url end),
       ((.env // {}) | tostring)]
    | @tsv' "$catalog" 2>/dev/null
}

_search_plugins() {
  local q="$1" mp
  for mp in "$HOME"/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json; do
    [ -f "$mp" ] || continue
    local root; root="$(dirname "$(dirname "$mp")")"
    # Only local-source entries can be copied; remote ones (git-subdir) are not on disk here.
    jq -r --arg q "$q" --arg root "$root" '
      .plugins[]?
      | select((.source | type) == "string")
      | select(((.name // "") + " " + (.description // "")) | ascii_downcase | contains($q | ascii_downcase))
      | ["copy", ($root + "/" + (.source | sub("^\\./"; ""))), .name,
         (.license // "see plugin LICENSE"), ((.description // "")[0:110]), "-", "-", "-", "[]", "-", "{}"]
      | @tsv' "$mp" 2>/dev/null
  done
}

# Copy a plugin's skills/ and agents/ into the project's .claude/ — plain files, no plugin runtime.
_copy_plugin_components() {
  local src="$1" project="$2" name="$3" copied=""
  [ -d "$src" ] || { echo "    ! $name: source not found ($src)" >&2; return 1; }
  local d
  for d in skills agents commands; do
    [ -d "$src/$d" ] || continue
    mkdir -p "$project/.claude/$d"
    cp -r "$src/$d/." "$project/.claude/$d/" 2>/dev/null && copied="$copied $d"
  done
  # keep the upstream licence next to what we copied
  local lic
  for lic in LICENSE LICENSE.md LICENCE COPYING; do
    if [ -f "$src/$lic" ]; then
      mkdir -p "$project/.claude/licenses"
      cp "$src/$lic" "$project/.claude/licenses/$name.$lic" 2>/dev/null
      break
    fi
  done
  [ -n "$copied" ] && echo "    copied:$copied" >&2 || echo "    ! $name has no skills/agents to copy" >&2
  return 0
}

_search_npm() {
  local q="$1" json
  json="$(curl -s --max-time 20 "https://registry.npmjs.org/-/v1/search?text=$(printf '%s' "$q mcp" | jq -sRr @uri)&size=12")" || return 0
  local pkg desc lic
  while IFS=$'\t' read -r pkg desc; do
    [ -z "$pkg" ] && continue
    # The search index has no licence; ask the package document (one small request per hit).
    lic="$(curl -s --max-time 10 "https://registry.npmjs.org/$(printf '%s' "$pkg" | jq -sRr @uri)" | jq -r '.license // (.versions[.["dist-tags"].latest].license) // "unknown"' 2>/dev/null)"
    [ -z "$lic" ] && lic="unknown"
    printf 'mcp\t%s\t%s\t%s\t%s\t-\t%s\tnpx\t["-y","%s"]\t-\t{}\n' "$pkg" "$pkg" "$lic" "${desc:0:110}" "$(printf '%s' "$pkg" | tr '/@' '--' | sed 's/^-*//')" "$pkg"
  done < <(printf '%s' "$json" | jq -r '.objects[]?.package | select(.name | test("mcp"; "i")) | [.name, (.description // "")] | @tsv' 2>/dev/null)
}

# --- interactive loop ---------------------------------------------------------------------------
# search_and_add <catalog.json> <project-dir>  → prints chosen "kind|id|name|licence|install|server|command|args"
search_and_add() {
  local catalog="$1" project="$2"
  local chosen="$SEARCH_CACHE.chosen"; : > "$chosen"

  # Non-interactive (CI, `bash init.sh </dev/null`): add nothing. Tests set FORCE_INTERACTIVE to
  # drive the same loop from a pipe.
  if [ ! -t 0 ] && [ "${SPEC_WORKFLOW_FORCE_INTERACTIVE:-}" != "1" ]; then return 0; fi

  {
    echo ""
    echo "  ── add MCP servers / skills ───────────────────────────────"
    echo "  Nothing is installed unless you add it here. You can add as many as you like:"
    echo "    • several keywords at once:  playwright postgres docs security"
    echo "    • pick several results:      1 3 5   or a range 2-6   or 'all' for every licensed hit"
    echo "    • keep searching; the basket carries over between searches"
    echo "  'list' = browse the curated catalog · 'show' = basket · 'done' = install · 'skip' = nothing"
  } >&2

  while :; do
    local count; count="$(wc -l < "$chosen" | tr -d ' ')"
    printf '\n  search [%s in basket]> ' "$count" >&2
    local q; read -r q || q="done"
    case "$q" in
      done) break ;;
      "") continue ;;
      skip) : > "$chosen"; break ;;
      show)
        if [ -s "$chosen" ]; then
          echo "  basket:" >&2
          awk -F'|' '{printf "    - %s (%s, %s)\n", $3, $1, $4}' "$chosen" >&2
        else echo "  basket is empty" >&2; fi
        continue ;;
      drop*)
        local what="${q#drop}"; what="$(printf '%s' "$what" | tr -d '[:space:]')"
        if [ -n "$what" ] && [ -s "$chosen" ]; then
          grep -vi "|$what|" "$chosen" > "$chosen.tmp" 2>/dev/null && mv "$chosen.tmp" "$chosen"
          echo "  dropped anything matching '$what'" >&2
        fi
        continue ;;
      list) q="" ;;
    esac

    # Every whitespace-separated word is its own query; results are merged and de-duplicated, so
    # "playwright postgres docs" fills one list instead of forcing three rounds.
    local hits="$SEARCH_CACHE.hits" raw="$SEARCH_CACHE.raw"; : > "$raw"
    if [ -z "$q" ]; then
      { _search_catalog "" "$catalog"; } >> "$raw" 2>/dev/null
    else
      local term
      for term in $q; do
        { _search_catalog "$term" "$catalog"; _search_plugins "$term"; } >> "$raw" 2>/dev/null
      done
      echo "  searching npm ($q)…" >&2
      for term in $q; do _search_npm "$term" >> "$raw" 2>/dev/null; done
    fi
    awk -F'\t' '!seen[$1 "|" $2]++' "$raw" > "$hits"

    local n; n="$(wc -l < "$hits" | tr -d ' ')"
    if [ "$n" -eq 0 ]; then echo "  no results for '$q'" >&2; continue; fi

    local i=1
    while IFS=$'\t' read -r kind id name lic desc install server command args url envj; do
      local mark="  "; [ "$lic" = "unknown" ] && mark=" ⚠"
      printf '%s%2d) %-34s %-8s %s\n' "$mark" "$i" "${name:0:34}" "[$kind]" "${desc:0:66}" >&2
      printf '        licence: %s\n' "$lic" >&2
      i=$((i + 1))
    done < "$hits"
    echo "  ⚠ = licence could not be verified; those cannot be added." >&2
    printf '  add (numbers / 2-6 / all), Enter to search again: ' >&2
    local picks; read -r picks || picks=""
    [ -z "$picks" ] && continue

    # Expand ranges and 'all' into a plain list of indices.
    local wanted=""
    for p in $picks; do
      case "$p" in
        all|a|A) wanted="$(seq 1 "$n" | tr '\n' ' ')" ; break ;;
        *-*)
          local lo="${p%%-*}" hi="${p##*-}"
          case "$lo$hi" in ''|*[!0-9]*) continue ;; esac
          [ "$lo" -le "$hi" ] && wanted="$wanted $(seq "$lo" "$hi" | tr '\n' ' ')" ;;
        ''|*[!0-9]*) continue ;;
        *) wanted="$wanted $p" ;;
      esac
    done

    local added=0 skipped=0
    for p in $wanted; do
      local line; line="$(sed -n "${p}p" "$hits")"
      [ -z "$line" ] && continue
      IFS=$'\t' read -r kind id name lic desc install server command args url envj <<< "$line"
      if [ "$lic" = "unknown" ]; then skipped=$((skipped + 1)); continue; fi
      if grep -q "^$kind|$id|" "$chosen" 2>/dev/null; then continue; fi
      printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$kind" "$id" "$name" "$lic" \
        "$(_dash "$install")" "$(_dash "$server")" "$(_dash "$command")" "$args" "$(_dash "$url")" "${envj:-{\}}" >> "$chosen"
      echo "  ✓ $name" >&2
      added=$((added + 1))
    done
    echo "  added $added$([ "$skipped" -gt 0 ] && echo ", skipped $skipped with unverified licence")" >&2
  done

  cat "$chosen"
  return 0
}

# install_chosen <chosen-lines> <project-dir> — runs installs and registers MCP servers
install_chosen() {
  local project="$2"
  local kind id name lic install server command args
  while IFS='|' read -r kind id name lic install server command args url envj; do
    [ -z "$id" ] && continue
    if [ "$kind" = "copy" ]; then
      # `id` holds the on-disk plugin directory; its skills/agents land in .claude/ as plain files.
      echo "  + $name → .claude/"
      _copy_plugin_components "$id" "$project" "$name" || continue
    elif [ -n "$install" ]; then
      echo "  + $name…"
      if ! ( cd "$project" && eval "$install" ) >/dev/null 2>&1; then
        echo "    ! failed — run manually: $install" >&2
        continue
      fi
    fi
    if [ -n "$server" ]; then
      local MCP_JSON="$project/.mcp.json" TMP
      [ -f "$MCP_JSON" ] || echo '{"mcpServers":{}}' > "$MCP_JSON"
      if jq -e --arg n "$server" '.mcpServers[$n]' "$MCP_JSON" >/dev/null 2>&1; then
        echo "  = $server already in .mcp.json"
      else
        TMP="$(mktemp)"
        if [ -n "$url" ]; then          # hosted endpoint: no package, just the URL
          jq --arg n "$server" --arg u "$url" '.mcpServers[$n] = {"type": "http", "url": $u}' "$MCP_JSON" > "$TMP"
        else
          jq --arg n "$server" --arg c "$command" --argjson a "$args" --argjson e "${envj:-{\}}" \
            '.mcpServers[$n] = ({"command": $c, "args": $a} + (if ($e | length) > 0 then {"env": $e} else {} end))' "$MCP_JSON" > "$TMP"
        fi
        mv "$TMP" "$MCP_JSON" && echo "  + $server → .mcp.json"
      fi
      local keys; keys="$(printf '%s' "${envj:-{\}}" | jq -r 'to_entries[] | select(.value == "") | .key' 2>/dev/null | tr '\n' ' ')"
      [ -n "$keys" ] && echo "    ! fill in .mcp.json env for $server: $keys" >&2
    fi
    :
  done <<< "$1"
  return 0
}

# write_installed_notice <chosen-lines> <project-dir>
write_installed_notice() {
  local project="$2" out="$2/.spec-workflow/INSTALLED.md"
  mkdir -p "$project/.spec-workflow"
  {
    echo "# Installed components"
    echo ""
    echo "_Chosen during init on $(date -u +%FT%TZ). Everything third-party is fetched from its own"
    echo "source and stays under its own licence; this file is the attribution record._"
    echo ""
    echo "| Component | Kind | Licence | How it was installed |"
    echo "|---|---|---|---|"
    while IFS='|' read -r kind id name lic install server command args url envj; do
      [ -z "$id" ] && continue
      local how="${install:-registered in .mcp.json}"
      [ "$kind" = "copy" ] && how="copied into .claude/ from $id"
      printf '| %s | %s | %s | `%s` |\n' "$name" "$kind" "$lic" "$how"
    done <<< "$1"
  } > "$out"
  echo "  attribution written: .spec-workflow/INSTALLED.md"
  return 0
}
