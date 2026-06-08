#!/bin/bash
# Fires when Claude Code finishes a task or needs user input.
# Plays a sound and shows a macOS notification.

osascript -e 'display notification "Claude Code is ready" with title "kazi-lab" sound name "Glass"' 2>/dev/null || true
