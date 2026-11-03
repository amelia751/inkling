"""todo14 Milestone 2 (D8): per-person preferences, stored server-side."""

from __future__ import annotations

from .conftest import ws

ALICE = {"X-Dev-Principal": "user:alice"}
BOB = {"X-Dev-Principal": "user:bob"}


def test_prefs_round_trip_per_person(client):
    assert client.get("/api/v1/me/prefs", headers=ALICE).json() == {"prefs": {}}
    r = client.put("/api/v1/me/prefs/first-run-hints-dismissed", json={"value": True}, headers=ALICE)
    assert r.status_code == 200 and r.json() == {"key": "first-run-hints-dismissed", "value": True}
    assert client.put("/api/v1/me/prefs/home.layout", json={"value": {"cols": 2, "pinned": ["a"]}}, headers=ALICE).status_code == 200
    # Overwrite, then read back; Bob's prefs are his own.
    assert client.put("/api/v1/me/prefs/first-run-hints-dismissed", json={"value": False}, headers=ALICE).json()["value"] is False
    assert client.get("/api/v1/me/prefs", headers=ALICE).json() == {"prefs": {"first-run-hints-dismissed": False, "home.layout": {"cols": 2, "pinned": ["a"]}}}
    assert client.get("/api/v1/me/prefs", headers=BOB).json() == {"prefs": {}}


def test_prefs_validate_keys_and_sizes(client):
    """todo22 D8: keys match ^[a-z][a-z0-9:._-]{0,127}$, values are at most 64 KiB of JSON."""
    for key in ("has space", "x" * 129, "slash%2Fkey", "ünï", "Upper", "camelCase", "1digit", "-dash", "home layout"):
        assert client.put(f"/api/v1/me/prefs/{key}", json={"value": 1}).status_code in (404, 422), key
    for key in ("x" * 128, "layout:p-1:t_2:desktop", "shell.nav", "items-view:abc", "theme"):
        assert client.put(f"/api/v1/me/prefs/{key}", json={"value": 1}).status_code == 200, key
    assert client.put("/api/v1/me/prefs/ok", json={}).status_code == 422
    assert client.put("/api/v1/me/prefs/fits", json={"value": "x" * (64 * 1024 - 2)}).status_code == 200  # quotes count
    assert client.put("/api/v1/me/prefs/big", json={"value": "x" * (64 * 1024 - 1)}).status_code == 413
    assert client.put("/api/v1/me/prefs/wide", json={"value": "é" * (32 * 1024)}).status_code == 413  # bytes, not characters


def test_prefs_key_limit(client, monkeypatch):
    from studio_api.routes import prefs

    monkeypatch.setattr(prefs, "MAX_KEYS", 5)
    for i in range(5):
        assert client.put(f"/api/v1/me/prefs/k{i}", json={"value": i}).status_code == 200
    assert client.put("/api/v1/me/prefs/one-too-many", json={"value": 1}).status_code == 409
    assert client.put("/api/v1/me/prefs/k3", json={"value": "changed"}).status_code == 200  # updates still fit


def test_agents_have_no_prefs(client):
    p = client.post("/api/v1/projects", json={"title": "P"}).json()
    token = client.post("/api/v1/sessions", json={"agent": "assistant", "scopes": ["*"]}, headers=ws(p["id"])).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/me/prefs", headers=h).status_code == 403
    assert client.put("/api/v1/me/prefs/first-run-hints-dismissed", json={"value": True}, headers=h).status_code == 403


def test_ai_notice_seen_is_stored_on_first_send(client):
    """todo15 D2: the first send stores the acknowledgement of the AI notice server-side."""
    r = client.put("/api/v1/me/prefs/ai-notice-seen", json={"value": "2026-11-02T00:00:00Z"}, headers=ALICE)
    assert r.status_code == 200 and r.json() == {"key": "ai-notice-seen", "value": "2026-11-02T00:00:00Z"}
    assert client.get("/api/v1/me/prefs", headers=ALICE).json()["prefs"]["ai-notice-seen"] == "2026-11-02T00:00:00Z"


def test_agent_token_reads_ai_assist(client):
    """todo15 D2: the agent reads the org's `aiAssist` with the session's token before a run."""
    p = client.post("/api/v1/projects", json={"title": "P"}).json()
    token = client.post("/api/v1/sessions", json={"agent": "assistant", "scopes": ["*"]}, headers=ws(p["id"])).json()["token"]
    r = client.get("/api/v1/org", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["aiAssist"] is True
