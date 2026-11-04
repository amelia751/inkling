"""Try before keep (todo25 D7): Dice against reference masks, per image and the mean."""

import pytest
from studio_plugin_sdk.masks import png_gray

from studio_plugin_segmentation.evaluate import Fixture, dice, evaluate_provider, load_fixtures
from studio_plugin_segmentation.providers.base import ProviderError, RawInstance


def sq(x0, y0, x1, y1, w=8, h=8) -> bytes:
    return bytes(1 if x0 <= x < x1 and y0 <= y < y1 else 0 for y in range(h) for x in range(w))


def test_dice():
    a = sq(0, 0, 4, 4)
    assert dice(a, a) == 1.0
    assert dice(a, sq(4, 4, 8, 8)) == 0.0
    assert dice(sq(0, 0, 4, 2), a) == pytest.approx(2 * 8 / (8 + 16))
    assert dice(bytes(64), bytes(64)) == 1.0  # both empty agree
    assert dice(bytes([0, 255]), bytes([0, 1])) == 1.0  # any nonzero is foreground
    with pytest.raises(ValueError):
        dice(a, a[:-1])


class Scripted:
    id, model, features = "scripted", "s-1", {"boxes": True}

    def __init__(self, answers):
        self.answers, self.seen = answers, []

    def segment(self, ctx, image, width, height, request):
        self.seen.append(request)
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return [RawInstance(m) for m in a]


def image(w=8, h=8) -> bytes:
    return png_gray(bytes(w * h), h, w)


def test_evaluate_provider_scores_each_image_and_the_mean():
    fixtures = [Fixture("a", image(), sq(0, 0, 4, 4), {"label": "lungs"}), Fixture("b", image(), sq(0, 0, 4, 4)), Fixture("c", image(), sq(2, 2, 6, 6))]
    # a: two halves whose union is exact; b: half of it; c: provider error.
    p = Scripted([[sq(0, 0, 2, 4), sq(2, 0, 4, 4)], [sq(0, 0, 4, 2)], ProviderError("down")])
    r = evaluate_provider(None, p, fixtures, bar=0.5, fixtures_name="synthetic")
    assert [x["dice"] for x in r["perImage"]] == [1.0, round(2 / 3, 4), 0.0]
    assert r["perImage"][2]["error"] == "down"
    assert r["quality"]["metric"] == "dice" and r["quality"]["images"] == 3 and r["quality"]["fixtures"] == "synthetic"
    assert r["quality"]["mean"] == pytest.approx((1 + 2 / 3) / 3, abs=1e-3)
    assert r["passed"] is True and p.seen[0] == {"asset_id": "a", "label": "lungs"}
    assert evaluate_provider(None, Scripted([[sq(4, 4, 8, 8)]]), fixtures[:1])["passed"] is False


def test_load_fixtures(tmp_path):
    (tmp_path / "x.png").write_bytes(image())
    (tmp_path / "x_mask.png").write_bytes(png_gray(sq(1, 1, 3, 3), 8, 8))
    (tmp_path / "x.json").write_text('{"label": "lungs"}')
    (fx,) = load_fixtures(tmp_path)
    assert fx.id == "x" and fx.reference == sq(1, 1, 3, 3) and fx.request == {"label": "lungs"}
