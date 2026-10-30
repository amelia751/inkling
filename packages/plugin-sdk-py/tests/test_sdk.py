import json
import subprocess
import sys
import textwrap

from studio_plugin_sdk.masks import bbox, decode_rle, encode_rle, image_size, png_gray
from studio_plugin_sdk.registry import Registry


def test_rle_roundtrip_and_bbox():
    h, w = 3, 4
    bits = [0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
    m = encode_rle(bits, h, w)
    assert sum(m["counts"]) == h * w and m["size"] == [h, w]
    assert list(decode_rle(m)) == bits
    assert bbox(bits, h, w) == [1.0, 0.0, 4.0, 3.0]
    assert image_size(png_gray(bits, h, w)) == (w, h)


def test_registry_rejects_duplicates():
    r = Registry()
    r.register("a", lambda c, i: {})
    try:
        r.register("a", lambda c, i: {})
    except ValueError:
        return
    raise AssertionError("duplicate tool accepted")


def test_runner_protocol(tmp_path):
    (tmp_path / "fake_plugin.py").write_text(textwrap.dedent('''
        def register(tools):
            @tools.tool("echo")
            def echo(ctx, req):
                print("noise that must not break the protocol")
                ctx.jobs.progress(0.5, "half")
                return {"echo": req["x"], "provider": ctx.provider["id"]}
    '''))
    job = {"entrypoint": "fake_plugin:register", "tool": "echo", "input": {"x": 7}, "kernelUrl": "http://127.0.0.1:9", "sessionToken": "t", "provider": {"id": "p"}, "workspaceId": "w", "jobId": "j"}
    p = subprocess.run([sys.executable, "-m", "studio_plugin_sdk.runner"], input=json.dumps(job), capture_output=True, text=True, cwd=tmp_path, env={"PYTHONPATH": f"{tmp_path}:{sys.path[0]}", "PATH": ""})
    lines = [json.loads(l) for l in p.stdout.splitlines()]
    assert lines[0] == {"type": "progress", "progress": 0.5, "message": "half"}
    assert lines[-1]["type"] == "result" and lines[-1]["result"] == {"echo": 7, "provider": "p"}
    assert "noise" in p.stderr
