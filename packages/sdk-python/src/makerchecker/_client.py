"""A thin, typed HTTP client for the MakerChecker API.

Mirrors ``@makerchecker/sdk`` (TypeScript). It adds no server logic: it talks to
a running MakerChecker server over HTTP, so a Python agent (CrewAI,
LangChain-Python, LlamaIndex, AutoGen, or a plain function) can open a proxy
session and run governed tool calls through it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

# Sentinel so ``record(output=None)`` is distinguishable from "no output given"
# (None is a legitimate tool output, mirroring the TS SDK's `output?: unknown`).
_UNSET: Any = object()


class ApiError(Exception):
    """Raised when the MakerChecker API returns a non-2xx response."""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"API request failed with status {status}")
        self.status = status
        self.body = body


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a proxy authorization check.

    ``allowed`` is the discriminator: when True, ``check_id`` is set; when
    False, ``code`` and ``reason`` explain the deny.
    """

    allowed: bool
    check_id: str | None = None
    code: str | None = None
    reason: str | None = None

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> CheckResult:
        return cls(
            allowed=bool(data.get("allowed")),
            check_id=data.get("checkId"),
            code=data.get("code"),
            reason=data.get("reason"),
        )


class _Proxy:
    """The proxy-session surface: open a session, then check -> record per call."""

    def __init__(self, client: Client) -> None:
        self._client = client

    def open_session(self, label: str, external_ref: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"label": label}
        if external_ref is not None:
            body["externalRef"] = external_ref
        return self._client._request("POST", "/api/proxy/sessions", body)

    def check(
        self,
        session_id: str,
        agent_name: str,
        skill_ref: str,
        input: dict[str, Any] | None = None,
    ) -> CheckResult:
        body: dict[str, Any] = {"agentName": agent_name, "skillRef": skill_ref}
        if input is not None:
            body["input"] = input
        data = self._client._request("POST", f"/api/proxy/sessions/{session_id}/check", body)
        return CheckResult._from_dict(data)

    def record(
        self,
        session_id: str,
        check_id: str,
        output: Any = _UNSET,
        error: Any = _UNSET,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"checkId": check_id}
        if output is not _UNSET:
            body["output"] = output
        if error is not _UNSET:
            body["error"] = error
        return self._client._request("POST", f"/api/proxy/sessions/{session_id}/record", body)

    def close_session(self, session_id: str) -> dict[str, Any]:
        return self._client._request("POST", f"/api/proxy/sessions/{session_id}/close")

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._client._request("GET", f"/api/proxy/sessions/{session_id}")


class Client:
    """A MakerChecker API client.

    Pass ``http`` to inject a configured ``httpx.Client`` (used in tests with a
    mock transport); otherwise one is created for ``base_url`` with the Bearer
    API key. Usable as a context manager.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        http: httpx.Client | None = None,
    ) -> None:
        if http is not None:
            self._http = http
            self._owns_http = False
        else:
            headers: dict[str, str] = {}
            if api_key is not None:
                headers["authorization"] = f"Bearer {api_key}"
            self._http = httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=30.0)
            self._owns_http = True
        self.proxy = _Proxy(self)

    def _request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        resp = self._http.request(method, path, json=body if body is not None else None)
        if resp.status_code >= 400:
            raise ApiError(resp.status_code, resp.text)
        result: dict[str, Any] = resp.json()
        return result

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/healthz")

    def trigger_flow(self, name: str, input: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._request(
            "POST", f"/api/flows/{quote(name)}/runs", input if input is not None else {}
        )

    def verify_audit(self) -> dict[str, Any]:
        return self._request("GET", "/api/audit/verify")

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def create_client(base_url: str, api_key: str | None = None) -> Client:
    """Convenience constructor mirroring the TypeScript SDK's ``createClient``."""
    return Client(base_url, api_key)
