"""todo14 Milestone 2 (D8): per-person preferences, stored server-side."""

from __future__ import annotations

from .conftest import ws

ALICE = {"X-Dev-Principal": "user:alice"}
BOB = {"X-Dev-Principal": "user:bob"}


def test_prefs_round_trip_per_person(client):
    assert client.get("/api/v1/me/prefs", headers=ALICE).json() == {"prefs": {}}
    r = client.put("/api/v1/me/prefs/firstRunHintsDismissed", json={"value": True}, headers=ALICE)
    assert r.status_code == 200 and r.json() == {"key": "firstRunHintsDismissed", "value": True}
    assert client.put("/api/v1/me/prefs/home.layout", json={"value": {"cols": 2, "pinned": ["a"]}}, headers=ALICE).status_code == 200
    # Overwrite, then read back; Bob's prefs are his own.
    assert client.put("/api/v1/me/prefs/firstRunHintsDismissed", json={"value": False}, headers=ALICE).json()["value"] is False
    assert client.get("/api/v1/me/prefs", headers=ALICE).json() == {"prefs": {"firstRunHintsDismissed": False, "home.layout": {"cols": 2, "pinned": ["a"]}}}
    assert client.get("/api/v1/me/prefs", headers=BOB).json() == {"prefs": {}}


def test_prefs_validate_keys_and_sizes(client):
    for key in ("has space", "x" * 65, "slash%2Fkey", "ünï"):
        assert client.put(f"/api/v1/me/prefs/{key}", json={"value": 1}).status_code in (404, 422), key
    assert client.put("/api/v1/me/prefs/ok", json={}).status_code == 422
    assert client.put("/api/v1/me/prefs/big", json={"value": "x" * 17000}).status_code == 413
    for i in range(100):
        assert client.put(f"/api/v1/me/prefs/k{i}", json={"value": i}).status_code == 200
    assert client.put("/api/v1/me/prefs/one-too-many", json={"value": 1}).status_code == 409
    assert client.put("/api/v1/me/prefs/k5", json={"value": "changed"}).status_code == 200  # updates still fit


def test_agents_have_no_prefs(client):
    p = client.post("/api/v1/projects", json={"title": "P"}).json()
    token = client.post("/api/v1/sessions", json={"agent": "assistant", "scopes": ["*"]}, headers=ws(p["id"])).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/me/prefs", headers=h).status_code == 403
    assert client.put("/api/v1/me/prefs/firstRunHintsDismissed", json={"value": True}, headers=h).status_code == 403
