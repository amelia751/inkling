from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from studio_api import blobstore
from studio_api.streaming import CHUNKED_OVER, blob_response


def client(tmp_path):
    store = blobstore.LocalBlobStore(tmp_path)
    store.put("small", b"x" * 1000)
    store.put("big", b"y" * (CHUNKED_OVER + 5))
    app = FastAPI()

    @app.api_route("/b/{key}", methods=["GET", "HEAD"])
    def get(key: str, request: Request):
        return blob_response(store, key, "application/octet-stream", request)

    return TestClient(app)


def test_small_blobs_declare_their_length(tmp_path):
    r = client(tmp_path).get("/b/small")
    assert r.status_code == 200 and r.headers["content-length"] == "1000"


def test_big_blobs_go_out_chunked(tmp_path):
    c = client(tmp_path)
    r = c.get("/b/big")
    assert r.status_code == 200
    assert "content-length" not in r.headers
    assert len(r.content) == CHUNKED_OVER + 5
    tail = c.get("/b/big", headers={"Range": "bytes=0-"})
    assert tail.status_code == 206 and "content-length" not in tail.headers and len(tail.content) == CHUNKED_OVER + 5
    under = c.get("/b/big", headers={"Range": "bytes=10-"})
    assert under.status_code == 206 and under.headers["content-length"] == str(CHUNKED_OVER - 5)
    piece = c.get("/b/big", headers={"Range": "bytes=0-99"})
    assert piece.status_code == 206 and piece.headers["content-length"] == "100"
    head = c.head("/b/big")
    assert head.headers["content-length"] == str(CHUNKED_OVER + 5)
