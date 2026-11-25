"""Only the Oasis Chrome Bridge extension may open the bridge socket: not another extension, not a
page on localhost (a dev server), not a native caller. Whoever holds the socket receives what the
agent types into the browser and answers with the page text it acts on."""

import base64
import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from services.dev_agent.chrome_bridge import BRIDGE_EXTENSION_ID, chrome_bridge, origin_allowed
from services.dev_agent.main import app

client = TestClient(app)
BRIDGE = f"chrome-extension://{BRIDGE_EXTENSION_ID}"
OTHER = "chrome-extension://" + "b" * 32
MANIFEST = Path(__file__).resolve().parents[1] / "extensions/oasis-chrome-bridge/manifest.json"


def refused(origin: str | None) -> bool:
    headers = {"Origin": origin} if origin else {}
    try:
        # A refused handshake closes before accepting: entering raises.
        with client.websocket_connect("/ws/chrome-bridge", headers=headers):
            return False
    except WebSocketDisconnect:
        return True


@pytest.fixture(autouse=True)
def no_extra_ids(monkeypatch):
    monkeypatch.delenv("OASIS_CHROME_BRIDGE_EXTENSION_IDS", raising=False)
    yield
    chrome_bridge.disconnect()


def test_the_id_matches_the_manifest_key() -> None:
    """Chrome derives an unpacked extension's id from its manifest key: sha256, first 32 hex, 0-f -> a-p."""
    key = json.loads(MANIFEST.read_text())["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    assert "".join(chr(ord("a") + int(c, 16)) for c in digest) == BRIDGE_EXTENSION_ID


def test_the_bundled_extension_connects() -> None:
    with client.websocket_connect("/ws/chrome-bridge", headers={"Origin": BRIDGE}):
        assert chrome_bridge.connected
    assert origin_allowed(BRIDGE + "/")


def test_another_extension_a_local_page_or_no_origin_is_refused() -> None:
    assert refused(OTHER)
    assert refused("http://localhost:5173")
    assert refused("http://127.0.0.1:3000")
    assert refused(None)
    assert not chrome_bridge.connected


def test_another_build_connects_once_its_id_is_listed(monkeypatch) -> None:
    assert not origin_allowed(OTHER)
    monkeypatch.setenv("OASIS_CHROME_BRIDGE_EXTENSION_IDS", f" {'c' * 32}, chrome-extension://{'b' * 32}/ ")
    assert origin_allowed(OTHER)
    assert origin_allowed("chrome-extension://" + "c" * 32)
    assert origin_allowed(BRIDGE)
    assert not refused(OTHER)
