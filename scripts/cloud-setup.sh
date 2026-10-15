#!/usr/bin/env bash
set -euo pipefail
umask 077

# Some cloud products expose Secrets only during setup. Materialize only this
# task's dedicated upstream test credential outside the repository. Never echo it.
python3 - <<'PY'
import json
import os
from pathlib import Path

key = os.environ.get("UPSTREAM_API_KEY")
if key:
    folder = Path.home() / ".config" / "workers-chat"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / "upstream-test.json"
    payload = {
        "base_url": os.environ.get("UPSTREAM_BASE_URL", "https://gemini.yaemiko.lol/v1"),
        "api_key": key,
        "model": os.environ.get("TEST_OPENAI_MODEL", "Gemini3.8flash-low"),
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False)
    path.chmod(0o600)
    print("Dedicated upstream test configuration saved outside the repository; values withheld.")
else:
    print("No dedicated upstream key provided; mock tests can still run.")
PY

# There is no application package at handoff time. A later cloud iteration may
# add one; do not fail setup simply because implementation has not started.
if [[ -f package-lock.json ]]; then
  npm ci
fi
