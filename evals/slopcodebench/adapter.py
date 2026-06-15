"""SlopCodeBench agent adapter for the Noetic code agent.

This registers a ``noetic`` agent type with SlopCodeBench's agent registry. On
each checkpoint, ``NoeticAgent.run(task)`` shells out to the headless Noetic
solver (``noetic-solve.ts``, run with ``bun``), which drives the real
``createCodeAgent()`` harness against the session's workspace directory.

It targets the **local** execution environment (``configs/environments/
local-py.yaml``): there the workspace is a host temp dir, so the host's ``bun``
and the in-repo ``@noetic-tools/code-agent`` package operate on it directly —
no in-container agent runtime is needed. (Running under the Docker environment
would require ``bun`` + the built agent inside the image; that is out of scope.)

The module is imported by ``launch.py`` BEFORE the SlopCodeBench CLI runs, so
the registry entry exists when ``slop-code run`` resolves ``type: noetic``.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import typing as tp
from pathlib import Path

from slop_code.agent_runner.agent import Agent
from slop_code.agent_runner.agent import AgentConfigBase
from slop_code.agent_runner.credentials import ProviderCredential
from slop_code.agent_runner.models import AgentCostLimits
from slop_code.agent_runner.models import AgentError
from slop_code.agent_runner.registry import register_agent
from slop_code.common.llms import APIPricing
from slop_code.common.llms import ModelDefinition
from slop_code.common.llms import ThinkingPreset
from slop_code.common.llms import TokenUsage
from slop_code.execution import Session

# The headless solver lives next to this file.
SOLVER_PATH = Path(__file__).resolve().parent / "noetic-solve.ts"
RESULT_SENTINEL = "__NOETIC_RESULT__"


class NoeticConfig(AgentConfigBase):
    """Configuration for the Noetic code agent.

    The model itself is supplied by SlopCodeBench's ``--model`` flag (resolved
    to a ``ModelDefinition``); these fields only tune how the solver is invoked.
    """

    model_config = {"extra": "forbid"}

    type: tp.Literal["noetic"] = "noetic"
    # Command used to run the TypeScript solver. Override to e.g. an absolute
    # bun path if it is not on PATH.
    runtime: str = "bun"
    # Wall-clock cap (seconds) for a single checkpoint solve. None = no cap.
    solve_timeout: int | None = 1800


class NoeticAgent(Agent):
    """Drives the Noetic code agent against a SlopCodeBench workspace."""

    def __init__(
        self,
        problem_name: str,
        verbose: bool,
        cost_limits: AgentCostLimits,
        pricing: APIPricing | None,
        *,
        runtime: str,
        solve_timeout: int | None,
        model_slug: str,
        api_key: str,
    ) -> None:
        super().__init__(
            agent_name="noetic",
            problem_name=problem_name,
            cost_limits=cost_limits,
            pricing=pricing,
            verbose=verbose,
        )
        self._runtime = runtime
        self._solve_timeout = solve_timeout
        self._model_slug = model_slug
        self._api_key = api_key
        self._workspace: Path | None = None
        self._last_stdout = ""
        self._last_stderr = ""

    #region Construction

    @classmethod
    def _from_config(
        cls,
        config: AgentConfigBase,
        model: ModelDefinition,
        credential: ProviderCredential,
        problem_name: str,
        verbose: bool,
        image: str | None,
        thinking_preset: ThinkingPreset | None = None,
        thinking_max_tokens: int | None = None,
    ) -> Agent:
        if not isinstance(config, NoeticConfig):
            raise TypeError(f"Expected NoeticConfig, got {type(config).__name__}")
        _ = (image, thinking_preset, thinking_max_tokens)

        # The OpenRouter model slug Noetic should call (e.g. x-ai/grok-code-fast-1).
        # Prefer the model's openrouter provider slug; fall back to internal name.
        model_slug = model.get_model_slug("openrouter")
        if not credential.value:
            raise AgentError(
                "No OpenRouter credential resolved. Set OPENROUTER_API_KEY and run "
                "with --model openrouter/<name>."
            )

        return cls(
            problem_name=problem_name,
            verbose=verbose,
            cost_limits=config.cost_limits,
            pricing=model.pricing,
            runtime=config.runtime,
            solve_timeout=config.solve_timeout,
            model_slug=model_slug,
            api_key=credential.value,
        )

    #endregion

    #region Lifecycle

    def setup(self, session: Session) -> None:
        self._workspace = session.working_dir
        # Local environment exposes only eval_commands; there is nothing to run
        # for agent setup. Guard anyway so a future env with agent setup works.
        for command in getattr(session.spec.setup, "commands", []) or []:
            subprocess.run(command, shell=True, cwd=str(self._workspace), check=False)

    def run(self, task: str) -> None:
        if self._workspace is None:
            raise AgentError("Agent.setup(session) must run before run(task).")

        result = self._invoke_solver(task)
        self._record_usage(result)

    def _invoke_solver(self, task: str) -> dict[str, tp.Any]:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".task.txt", delete=False, encoding="utf-8"
        ) as handle:
            handle.write(task)
            task_file = handle.name

        cmd = [
            self._runtime,
            str(SOLVER_PATH),
            "--cwd",
            str(self._workspace),
            "--model",
            self._model_slug,
            "--task-file",
            task_file,
            "--max-steps",
            str(self.cost_limits.step_limit or 100),
        ]
        env = {**os.environ, "OPENROUTER_API_KEY": self._api_key}

        try:
            proc = subprocess.run(
                cmd,
                cwd=str(self._workspace),
                env=env,
                capture_output=True,
                text=True,
                timeout=self._solve_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AgentError(
                f"Noetic solver timed out after {self._solve_timeout}s"
            ) from exc
        finally:
            Path(task_file).unlink(missing_ok=True)

        self._last_stdout = proc.stdout
        self._last_stderr = proc.stderr

        if proc.returncode != 0:
            raise AgentError(
                f"Noetic solver exited {proc.returncode}: "
                f"{proc.stderr.strip()[-500:] or proc.stdout.strip()[-500:]}"
            )

        return self._parse_result(proc.stdout)

    @staticmethod
    def _parse_result(stdout: str) -> dict[str, tp.Any]:
        for line in reversed(stdout.splitlines()):
            if line.startswith(RESULT_SENTINEL):
                payload = line[len(RESULT_SENTINEL) :].strip()
                return json.loads(payload)
        raise AgentError(
            "Noetic solver produced no result line "
            f"(expected a line starting with '{RESULT_SENTINEL}')."
        )

    def _record_usage(self, result: dict[str, tp.Any]) -> None:
        tokens = TokenUsage(
            input=int(result.get("inputTokens", 0)),
            output=int(result.get("outputTokens", 0)),
        )
        # Prefer SlopCodeBench's pricing (consistent across agents); fall back to
        # the cost the solver reported from OpenRouter.
        cost = float(result.get("cost", 0.0))
        if self.pricing is not None:
            cost = self.pricing.get_cost(tokens)
        self.usage.step(cost=cost, tokens=tokens)

    def reset(self) -> None:
        # Each run() spawns a fresh createCodeAgent(), so there is no in-process
        # conversation state to clear. The workspace files persist across
        # checkpoints (that is the benchmark's iterative-refinement contract).
        self._last_stdout = ""
        self._last_stderr = ""

    def save_artifacts(self, path: Path) -> None:
        (path / "stdout.log").write_text(self._last_stdout, encoding="utf-8")
        if self._last_stderr:
            (path / "stderr.log").write_text(self._last_stderr, encoding="utf-8")

    def cleanup(self) -> None:
        self._workspace = None

    #endregion


# Register with SlopCodeBench's agent registry (config auto-registers via
# AgentConfigBase.__init_subclass__).
register_agent("noetic", NoeticAgent)
