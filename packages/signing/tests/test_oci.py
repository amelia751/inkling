"""OCI layout: deterministic packing, verification from the manifest down, layouts on disk."""

from __future__ import annotations

import io
import json
import tarfile

import pytest

from studio_signing import LocalSigner, PublicKeyVerifier, sha256_digest
from studio_signing import oci

MT = oci.MediaTypes.for_namespace("acme")
FILES = {"plugin.yaml": b"id: acme.x\nversion: 0.1.0\n", "ui/contributions.json": b'{"panels":[]}', "README.md": b"# x\n", "node_modules/skip.js": b"x"}


def packed():
    return oci.pack(FILES, plugin_id="acme.x", version="0.1.0", manifest={"id": "acme.x", "version": "0.1.0"}, mt=MT)


def test_pack_is_deterministic_and_excludes_caches():
    a, b = packed(), packed()
    assert a.manifest_digest == b.manifest_digest and a.blobs == b.blobs
    assert a.tree_digest == oci.tree_digest({k: v for k, v in FILES.items() if "node_modules" not in k})
    assert oci.tree_digest_of_hashes({k: sha256_digest(v)[7:] for k, v in FILES.items()}) == a.tree_digest
    doc, files, config = oci.unpack(a.blobs.__getitem__, a.manifest_digest, MT, expect_tree=a.tree_digest)
    assert "node_modules/skip.js" not in files and files["README.md"] == b"# x\n"
    assert config == {"id": "acme.x", "version": "0.1.0"} and doc["annotations"]["org.opencontainers.image.title"] == "acme.x"


def test_one_flipped_byte_anywhere_is_refused():
    p = packed()
    doc = json.loads(p.blobs[p.manifest_digest])
    layer = doc["layers"][0]["digest"]
    blobs = dict(p.blobs)
    tampered = bytearray(blobs[layer])
    tampered[600] ^= 1
    blobs[layer] = bytes(tampered)
    with pytest.raises(oci.ArtifactRefused, match="doesn't match its digest"):
        oci.unpack(blobs.__getitem__, p.manifest_digest, MT)
    with pytest.raises(oci.ArtifactRefused, match="missing"):
        oci.unpack({}.__getitem__, p.manifest_digest, MT)
    with pytest.raises(oci.ArtifactRefused, match="pinned"):
        oci.unpack(p.blobs.__getitem__, p.manifest_digest, MT, expect_tree=sha256_digest(b"other"))
    with pytest.raises(oci.ArtifactRefused, match="isn't a plugin artifact"):
        oci.unpack(p.blobs.__getitem__, p.manifest_digest, oci.MediaTypes.for_namespace("other"))


def test_unsafe_layers_are_refused():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo("../evil")
        tf.addfile(info, io.BytesIO(b""))
    with pytest.raises(oci.ArtifactRefused, match="unsafe path"):
        oci.untar_layer(buf.getvalue())
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo("link")
        info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
        tf.addfile(info)
    with pytest.raises(oci.ArtifactRefused, match="non-file"):
        oci.untar_layer(buf.getvalue())


def test_layout_roundtrip_with_referrers(tmp_path):
    p = packed()
    s = LocalSigner.generate()
    sig_layer = json.dumps({"keyId": s.key_id, "sig": s.sign(p.manifest_digest)}).encode()
    m, cfg, layer = oci.referrer(p.manifest_digest, len(p.blobs[p.manifest_digest]), artifact_type=MT.signature, layer_media_type=MT.signature, layer=sig_layer)
    blobs = {**p.blobs, **{sha256_digest(b): b for b in (m, cfg, layer)}}
    oci.write_layout(tmp_path, blobs, [oci.descriptor(oci.OCI_MANIFEST, p.blobs[p.manifest_digest], annotations={"org.opencontainers.image.ref.name": "0.1.0"}), oci.descriptor(oci.OCI_MANIFEST, m)])
    manifests, get = oci.read_layout(tmp_path)
    assert manifests[0]["digest"] == p.manifest_digest
    oci.unpack(get, p.manifest_digest, MT)
    ref = json.loads(get(manifests[1]["digest"]))
    assert ref["subject"]["digest"] == p.manifest_digest
    v = PublicKeyVerifier(s.key_id, s.public_key_pem())
    assert v.verify(p.manifest_digest, json.loads(get(ref["layers"][0]["digest"]))["sig"])
    with pytest.raises(oci.ArtifactRefused):
        oci.read_layout(tmp_path / "nope")


def test_provenance_statement_names_the_subject():
    st = oci.provenance_statement("acme.x@0.1.0", sha256_digest(b"m"), builder="api", build_type="t", external={"promptHash": "sha256:00"})
    assert st["subject"][0]["digest"]["sha256"] == sha256_digest(b"m")[7:] and st["predicateType"] == oci.SLSA_PROVENANCE_V1
