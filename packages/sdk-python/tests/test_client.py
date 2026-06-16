from __future__ import annotations

import json

import httpx
import pytest

from makerchecker import ApiError, Client


def make_client(handler: object) -> Client:
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    http = httpx.Client(transport=transport, base_url="http://test")
    return Client("http://test", http=http)


def test_open_session_check_record_close() -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/api/proxy/sessions":
            return httpx.Response(200, json={"session": {"id": "ps-1", "status": "open"}})
        if path.endswith("/check"):
            return httpx.Response(200, json={"allowed": True, "checkId": "ck-1"})
        if path.endswith("/record"):
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/close"):
            return httpx.Response(200, json={"session": {"id": "ps-1", "status": "closed"}})
        return httpx.Response(404, text="not found")

    c = make_client(handler)
    assert c.proxy.open_session("run")["session"]["id"] == "ps-1"
    check = c.proxy.check("ps-1", "bot", "double@1", input={"n": 21})
    assert check.allowed and check.check_id == "ck-1"
    assert c.proxy.record("ps-1", "ck-1", output={"doubled": 42})["ok"] is True
    c.proxy.close_session("ps-1")

    check_req = next(s for s in seen if s[1].endswith("/check"))
    assert check_req[2] == {"agentName": "bot", "skillRef": "double@1", "input": {"n": 21}}


def test_check_deny_shape() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"allowed": False, "code": "skill_not_granted", "reason": "no grant"}
        )

    res = make_client(handler).proxy.check("ps-1", "bot", "x@1")
    assert res.allowed is False
    assert res.code == "skill_not_granted"
    assert res.reason == "no grant"


def test_trigger_and_verify() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/runs"):
            return httpx.Response(201, json={"runId": "r-1"})
        if request.url.path == "/api/audit/verify":
            return httpx.Response(200, json={"ok": True, "count": 5, "headHash": "abc"})
        return httpx.Response(404, text="no")

    c = make_client(handler)
    assert c.trigger_flow("daily-cash", {"x": 1})["runId"] == "r-1"
    assert c.verify_audit()["ok"] is True


def test_api_error_on_non_2xx() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="missing API key (authorization: Bearer mk_...)")

    with pytest.raises(ApiError) as exc:
        make_client(handler).proxy.check("ps-1", "bot", "x@1")
    assert exc.value.status == 401
    assert "missing API key" in exc.value.body


def test_builds_bearer_auth_header() -> None:
    c = Client("http://x/", "mk_test")
    try:
        assert c._http.headers.get("authorization") == "Bearer mk_test"
    finally:
        c.close()
