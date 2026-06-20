#!/bin/bash
# Clean up old codex plugin configuration from global Claude settings
# Run this if upgrading from an older version that used the codex plugin

set -e

GLOBAL_SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$GLOBAL_SETTINGS" ]; then
  echo "No global settings.json found, nothing to clean up"
  exit 0
fi

if grep -q "enabledPlugins\|extraKnownMarketplaces\|codex@openai-codex" "$GLOBAL_SETTINGS" 2>/dev/null; then
  TMP=$(mktemp)
  jq 'del(.enabledPlugins, .extraKnownMarketplaces)' "$GLOBAL_SETTINGS" > "$TMP" 2>/dev/null && mv "$TMP" "$GLOBAL_SETTINGS"
  echo "Cleaned up old codex plugin configuration"
else
  echo "No old codex plugin configuration found"
fi
