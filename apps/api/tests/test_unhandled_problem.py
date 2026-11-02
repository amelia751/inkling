"""todo18 E P2: an unhandled error answers problem JSON with the request id, never the exception text."""

from fastapi.testclient import TestClient


def test_an_unhandled_error_is_problem_json_without_its_text(client):
    app = client.app

    @app.get("/api/v1/__boom")
    def boom():
        raise RuntimeError("patient Jane Doe, scan_0001.dcm")

    r = TestClient(app, raise_server_exceptions=False).get("/api/v1/__boom")
    assert r.status_code == 500
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == "internal" and body["retryable"] is True
    assert "Jane" not in r.text and "scan_0001" not in r.text
