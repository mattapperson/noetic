#!/usr/bin/env python
"""Launch SlopCodeBench's CLI with the Noetic agent registered.

SlopCodeBench discovers agents by import side effect — there is no plugin entry
point. Rather than patch the vendored clone, we import our adapter here (which
calls ``register_agent("noetic", ...)``) and then hand off to the unmodified
``slop-code`` Typer app. All CLI arguments pass straight through, so this is a
drop-in for ``slop-code``:

    uv run python launch.py run --agent <noetic.yaml> --problem calculator ...
    uv run python launch.py eval <run-dir>

Run from inside the vendored clone (``uv run`` resolves ``slop_code``).
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure this directory is importable so ``adapter`` resolves regardless of cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapter  # noqa: E402,F401  (import for register_agent side effect)

from slop_code.entrypoints.cli import app  # noqa: E402

if __name__ == "__main__":
    app()
