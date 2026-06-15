"""Pytest configuration for the greeter smoke problem.

Registers the SCBench-standard evaluation options (--entrypoint, --checkpoint,
--static-assets) and exposes them as fixtures. The PytestRunner passes these in
when grading a submission.
"""

import json
import shlex
from pathlib import Path

import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--entrypoint",
        action="store",
        required=True,
        help="Full command to run the submission (e.g. 'uv run greeter.py').",
    )
    parser.addoption(
        "--checkpoint",
        action="store",
        required=True,
        help="Current checkpoint being evaluated (e.g. 'checkpoint_1').",
    )
    parser.addoption(
        "--static-assets",
        action="store",
        default="{}",
        help="JSON dict of static asset paths.",
    )


@pytest.fixture(scope="session")
def entrypoint_argv(request):
    return shlex.split(request.config.getoption("--entrypoint"))


@pytest.fixture(scope="session")
def checkpoint_name(request):
    return request.config.getoption("--checkpoint")


@pytest.fixture(scope="session")
def static_assets(request):
    return json.loads(request.config.getoption("--static-assets"))


@pytest.fixture(scope="session")
def test_data_dir():
    return Path(__file__).parent
