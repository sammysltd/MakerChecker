from __future__ import annotations

from typing import Any

import pytest

from makerchecker import CheckResult, GovernanceDeniedError, governed_tool


class FakeProxy:
    def __init__(self, result: CheckResult) -> None:
        self._result = result
        self.checks: list[tuple[Any, ...]] = []
        self.records: list[dict[str, Any]] = []

    def check(self, session_id, agent_name, skill_ref, input=None):  # type: ignore[no-untyped-def]
        self.checks.append((session_id, agent_name, skill_ref, input))
        return self._result

    def record(self, session_id, check_id, output=..., error=...):  # type: ignore[no-untyped-def]
        self.records.append(
            {"session_id": session_id, "check_id": check_id, "output": output, "error": error}
        )
        return {"ok": True}


class FakeClient:
    def __init__(self, result: CheckResult) -> None:
        self.proxy = FakeProxy(result)


def test_allow_runs_and_records() -> None:
    c = FakeClient(CheckResult(allowed=True, check_id="ck-1"))

    def fn(i: dict[str, Any]) -> dict[str, Any]:
        return {"doubled": i["n"] * 2}

    wrapped = governed_tool(c, "ps-1", "bot", "double@1", fn)  # type: ignore[arg-type]
    assert wrapped({"n": 21}) == {"doubled": 42}
    assert c.proxy.checks == [("ps-1", "bot", "double@1", {"n": 21})]
    assert c.proxy.records[0]["check_id"] == "ck-1"
    assert c.proxy.records[0]["output"] == {"doubled": 42}


def test_deny_raises_and_never_runs() -> None:
    c = FakeClient(CheckResult(allowed=False, code="skill_not_granted", reason="no grant"))
    ran: list[Any] = []

    def fn(i: dict[str, Any]) -> str:
        ran.append(i)
        return "must not run"

    wrapped = governed_tool(c, "ps-1", "bot", "x@1", fn)  # type: ignore[arg-type]
    with pytest.raises(GovernanceDeniedError) as exc:
        wrapped({"n": 1})
    assert exc.value.code == "skill_not_granted"
    assert exc.value.reason == "no grant"
    assert ran == []
    assert c.proxy.records == []  # nothing recorded on a deny


def test_tool_error_is_recorded_and_reraised() -> None:
    c = FakeClient(CheckResult(allowed=True, check_id="ck-9"))

    def fn(i: dict[str, Any]) -> str:
        raise ValueError("boom")

    wrapped = governed_tool(c, "ps-1", "bot", "f@1", fn)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="boom"):
        wrapped({"n": 1})
    rec = c.proxy.records[0]
    assert rec["check_id"] == "ck-9"
    assert rec["error"] == {"message": "boom"}
