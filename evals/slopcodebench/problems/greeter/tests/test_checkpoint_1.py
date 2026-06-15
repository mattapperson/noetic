"""Checkpoint 1 tests for the greeter smoke problem.

Unmarked tests are CORE (must pass for the checkpoint to be solved).
"""

import subprocess


def _run(entrypoint_argv, stdin):
    return subprocess.run(
        entrypoint_argv,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_greets_simple_name(entrypoint_argv):
    """Core: greets the provided name on a clean exit."""
    result = _run(entrypoint_argv, "World\n")
    assert result.returncode == 0, f"Expected exit 0, got {result.returncode}. stderr: {result.stderr}"
    assert result.stdout.strip() == "Hello, World!", f"Unexpected stdout: {result.stdout!r}"


def test_strips_surrounding_whitespace(entrypoint_argv):
    """Core: surrounding whitespace on the input is stripped."""
    result = _run(entrypoint_argv, "  Ada  \n")
    assert result.returncode == 0, f"Expected exit 0, got {result.returncode}. stderr: {result.stderr}"
    assert result.stdout.strip() == "Hello, Ada!", f"Unexpected stdout: {result.stdout!r}"
