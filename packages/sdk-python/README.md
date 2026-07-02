# makerchecker (Python SDK)

A typed HTTP client for a running MakerChecker server, plus the `governed_tool` wrapper. It opens a proxy session and routes a Python agent's tool calls through the server's deny-by-default grants, segregation of duties, approval gates, and a hash-chained, Ed25519-signed audit. The API mirrors the TypeScript SDK at [../sdk](../sdk).

## Install

```bash
pip install "makerchecker @ git+https://github.com/sammysltd/makerchecker#subdirectory=packages/sdk-python"
```

Plain `pip install makerchecker` from PyPI works from the next tagged release. Python 3.10+. Runtime dependency: `httpx`.

## Use

```python
from makerchecker import create_client, governed_tool, GovernanceDeniedError

client = create_client("http://localhost:3000", api_key="mk_...")
session = client.proxy.open_session("crew-run")["session"]

ingest = governed_tool(
    client, session["id"], "recon-preparer", "csv-ingest@1",
    lambda i: read_csv(i["path"]),
)

try:
    result = ingest({"path": "statement.csv"})  # checks first; a deny throws before read_csv runs
except GovernanceDeniedError as err:
    print(err.code, err.reason)

client.proxy.close_session(session["id"])
```

`governed_tool` calls `client.proxy.check`, raises `GovernanceDeniedError(code, reason)` on a deny before `fn` runs, then runs `fn(input)`, records the output, and returns it. If `fn` raises, it records `{"message": str(err)}` and re-raises. `skill_ref` is a `name@version` string; a grant for one version does not authorize another.

## API

```python
create_client(base_url, api_key=None) -> Client
Client(base_url, api_key=None, *, http=None)   # context manager; close() releases an owned httpx.Client

client.health() -> dict                          # GET  /healthz
client.trigger_flow(name, input=None) -> dict    # POST /api/flows/{name}/runs
client.verify_audit() -> dict                    # GET  /api/audit/verify
client.close() -> None

client.proxy.open_session(label, external_ref=None) -> dict          # {"session": {"id", ...}}
client.proxy.check(session_id, agent_name, skill_ref, input=None) -> CheckResult
client.proxy.record(session_id, check_id, output=..., error=...) -> dict
client.proxy.close_session(session_id) -> dict
client.proxy.get_session(session_id) -> dict

governed_tool(client, session_id, agent_name, skill_ref, fn) -> Callable[[dict], T]
```

`check` returns `CheckResult(allowed, check_id, code, reason)`. A deny returns 200 with `allowed=False`, not an error. `record` uses sentinel defaults, so `output=None` records a literal `None` and differs from omitting `output`. Any response with status >= 400 raises `ApiError(status, body)`.

CrewAI and LangChain tools are callables: wrap the implementation with `governed_tool` and call it from the `@tool` body.

## License

Apache-2.0. See [LICENSE](./LICENSE). The MakerChecker server it talks to is AGPL-3.0.
