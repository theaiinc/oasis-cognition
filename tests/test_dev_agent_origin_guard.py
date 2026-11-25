"""The dev-agent refuses web pages from other sites: without this, any website the user has open
could POST to the dev-agent and write files or run commands on their machine."""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from services.dev_agent.main import app
from services.dev_agent.origin_guard import cors_origin_regex, origin_allowed

client = TestClient(app)
EXT = "chrome-extension://" + "a" * 32


def test_a_page_from_another_site_cannot_write_files() -> None:
    res = client.post("/internal/dev-agent/cu-file/write", json={"path": "x", "content": "y"}, headers={"Origin": "https://evil.example"})
    assert res.status_code == 403
    # Without the preflight too: a text/plain "simple" request is refused the same way.
    res = client.post("/internal/dev-agent/cu-file/write", content='{"path":"x"}', headers={"Origin": "https://evil.example", "Content-Type": "text/plain"})
    assert res.status_code == 403


def test_preflight_from_another_site_gets_no_cors_grant() -> None:
    res = client.options("/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}


def test_the_local_ui_and_server_callers_still_work() -> None:
    assert client.get("/health", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200
    res = client.get("/health", headers={"Origin": "http://localhost:3000"})
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "http://localhost:3000"
    # The gateway, curl and native apps send no Origin.
    assert client.get("/health").status_code == 200


def test_extra_origins_are_opt_in(monkeypatch) -> None:
    lan = "http://192.168.1.20:3000"
    assert not origin_allowed(lan)
    monkeypatch.setenv("DEV_AGENT_ALLOWED_ORIGINS", f" {lan}/ , http://box.local:3000")
    assert origin_allowed(lan)
    assert origin_allowed("http://box.local:3000")
    import re
    assert re.match(cors_origin_regex(), lan)
    assert not re.match(cors_origin_regex(), "http://192.168.1.20:3000.evil.example")


def test_extensions_reach_only_the_bridge_socket_and_health() -> None:
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/chrome-bridge", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_json()
    assert origin_allowed(EXT, "/ws/chrome-bridge", websocket=True)
    assert not origin_allowed(EXT, "/ws/cu-overlay", websocket=True)
    assert not origin_allowed(EXT, "/internal/dev-agent/cu-file/write", method="POST")
    assert client.get("/health", headers={"Origin": EXT}).status_code == 200
    assert not origin_allowed(EXT, "/health", method="POST")
    assert not origin_allowed("null")
    assert not origin_allowed("http://localhost.evil.example")
