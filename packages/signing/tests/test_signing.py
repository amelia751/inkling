"""Signer contract: both implementations sign a digest, verify it, and refuse anything else."""

from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from studio_signing import (
    GcpKmsSigner,
    LocalSigner,
    Signer,
    SignerError,
    check_envelope,
    dsse_sign,
    dsse_verify,
    envelope,
    make_signer,
    sha256_digest,
)

D = sha256_digest(b"artifact manifest bytes")
KV = "projects/p/locations/europe-west4/keyRings/r/cryptoKeys/plugins/cryptoKeyVersions/1"


class FakeKms:
    """The two KeyManagementServiceClient calls the signer uses, backed by a local P-256 key."""

    def __init__(self, alg: str = "EC_SIGN_P256_SHA256"):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.alg = alg
        self.signed: list[bytes] = []

    def get_public_key(self, request):
        pem = self.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        return SimpleNamespace(pem=pem, algorithm=SimpleNamespace(name=self.alg), name=request["name"])

    def asymmetric_sign(self, request):
        raw = request["digest"]["sha256"]
        self.signed.append(raw)
        return SimpleNamespace(name=request["name"], signature=self.key.sign(raw, ec.ECDSA(utils.Prehashed(hashes.SHA256()))), verified_digest_crc32c=True, signature_crc32c=None)


@pytest.fixture(params=["local", "gcpkms"])
def signer(request, tmp_path) -> Signer:
    if request.param == "local":
        return make_signer("local", key_file=tmp_path / "k.pem")
    return make_signer("gcpkms", kms_key=KV, kms_client=FakeKms())


def test_sign_verify_roundtrip(signer):
    assert isinstance(signer, Signer)
    sig = signer.sign(D)
    assert signer.verify(D, sig)
    assert not signer.verify(sha256_digest(b"other"), sig)
    flipped = bytearray(base64.b64decode(sig))
    flipped[-1] ^= 1
    assert not signer.verify(D, base64.b64encode(bytes(flipped)).decode())
    assert not signer.verify(D, "not base64!")
    assert "PUBLIC KEY" in signer.public_key_pem()


def test_rejects_non_digests(signer):
    with pytest.raises(SignerError):
        signer.sign("md5:abc")
    assert not signer.verify("sha256:short", signer.sign(D))


def test_envelope_names_the_problem(signer, tmp_path):
    env = envelope(signer, D)
    assert env["keyId"] == signer.key_id and env["signer"] == signer.kind
    assert check_envelope(signer, D, env) is None
    assert check_envelope(signer, sha256_digest(b"x"), env) and "not" in check_envelope(signer, sha256_digest(b"x"), env)
    assert check_envelope(signer, D, None) == "not signed"
    other = LocalSigner.generate()
    assert "doesn't trust" in (check_envelope(other, D, env) or "")
    assert check_envelope(signer, D, {**env, "sig": base64.b64encode(b"\0" * 64).decode()}) == "signature doesn't verify"


def test_dsse_attestation(signer):
    env = dsse_sign(signer, "application/vnd.in-toto+json", b'{"_type":"https://in-toto.io/Statement/v1"}')
    payload, err = dsse_verify(signer, env)
    assert err is None and payload == {"_type": "https://in-toto.io/Statement/v1"}
    forged = {**env, "payload": base64.b64encode(b'{"_type":"evil"}').decode()}
    assert dsse_verify(signer, forged) == (None, "attestation signature doesn't verify")


def test_local_key_persists(tmp_path):
    a = LocalSigner.from_file(tmp_path / "k.pem")
    b = LocalSigner.from_file(tmp_path / "k.pem")
    assert a.key_id == b.key_id and b.verify(D, a.sign(D))
    assert oct((tmp_path / "k.pem").stat().st_mode)[-3:] == "600"
    with pytest.raises(SignerError):
        LocalSigner.from_file(tmp_path / "missing.pem", create=False)


def test_kms_signs_only_the_digest_and_checks_the_key():
    kms = FakeKms()
    s = GcpKmsSigner(f"gcpkms://{KV}", kms)
    s.sign(D)
    assert kms.signed == [bytes.fromhex(D[7:])]
    assert s.key_id == f"gcpkms://{KV}"
    with pytest.raises(SignerError):
        GcpKmsSigner("projects/p/locations/l/keyRings/r/cryptoKeys/k", kms)  # a key, not a key version
    with pytest.raises(SignerError):
        GcpKmsSigner(KV, FakeKms(alg="RSA_SIGN_PKCS1_2048_SHA256")).sign(D)


def test_make_signer_errors(tmp_path):
    with pytest.raises(SignerError):
        make_signer("hsm")
    with pytest.raises(SignerError):
        make_signer("gcpkms")
    with pytest.raises(SignerError):
        make_signer("local")
