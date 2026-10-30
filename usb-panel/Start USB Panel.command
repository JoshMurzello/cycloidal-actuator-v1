#!/bin/zsh
set -e
TASK_PANEL_DIR="${0:A:h}"
cd "$TASK_PANEL_DIR"
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py --open
fi
print "Python 3 is required to launch this local panel."
read -r "?Press Enter to close."
