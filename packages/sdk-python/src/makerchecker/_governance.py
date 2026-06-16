"""``governed_tool`` — wrap, don't migrate.

Wraps any Python tool function so every call passes through MakerChecker first:
check -> (deny raises ``GovernanceDeniedError`` before the tool runs) -> run ->
record the output (or the error, which is re-raised). Framework-agnostic: use it
inside a CrewAI ``@tool``, a LangChain ``StructuredTool``, or a bare function.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from ._client import Client

T = TypeVar("T")


class GovernanceDeniedError(Exception):
    """Raised when MakerChecker denies a governed call (before the tool runs)."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(f"governance denied ({code}): {reason}")
        self.code = code
        self.reason = reason


def governed_tool(
    client: Client,
    session_id: str,
    agent_name: str,
    skill_ref: str,
    fn: Callable[[dict[str, Any]], T],
) -> Callable[[dict[str, Any]], T]:
    """Return a governed version of ``fn``.

    The wrapper takes the tool input (a dict) and:

      1. calls ``client.proxy.check`` — a deny raises :class:`GovernanceDeniedError`
         BEFORE ``fn`` runs (deny by default, fail closed);
      2. runs ``fn(input)``;
      3. records the output, or, if ``fn`` raises, records the error and re-raises.

    Example (CrewAI)::

        from crewai.tools import tool

        ingest_impl = governed_tool(client, session.id, "recon-preparer",
                                    "csv-ingest@1", lambda i: read_csv(i["path"]))

        @tool("csv_ingest")
        def csv_ingest(path: str) -> str:
            return ingest_impl({"path": path})
    """

    def wrapped(input: dict[str, Any]) -> T:
        check = client.proxy.check(session_id, agent_name, skill_ref, input=input)
        if not check.allowed:
            raise GovernanceDeniedError(check.code or "denied", check.reason or "denied")
        # The server guarantees a check_id on an allowed result.
        check_id = check.check_id
        assert check_id is not None
        try:
            output = fn(input)
            client.proxy.record(session_id, check_id, output=output)
            return output
        except Exception as err:
            client.proxy.record(session_id, check_id, error={"message": str(err)})
            raise

    return wrapped
