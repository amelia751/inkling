"""todo13 §3.3: one table test per classification row (pure functions, no database), plus the
plan's D6 rule (what applies on its own) and the fast path's preset resolution."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio_api.kernel import drops_classify as dc
from studio_api.kernel import intents

REPO = Path(__file__).resolve().parents[3]
TABLE = json.loads((REPO / "registry" / "intents.json").read_text())


def preset(kind: str) -> str | None:
    return intents.preset_for_kind(kind, TABLE)


def img(i: int, **kw) -> dc.FileIn:
    return dc.FileIn(f"nod-img{i}", "image", "image", {"width": 64, "height": 64}, **kw)


def dcm(i: int, series: str | None = "s1", modality: str = "CT") -> dc.FileIn:
    facts: dict = {"dicom": {"modality": modality}}
    if series:
        facts["series"] = {"seriesUidHash": series, "sliceCount": 3}
    return dc.FileIn(f"nod-dcm{i}", "dicom", "dicom", facts)


XRAY = dc.CollectionIn("col-xray", "Chest X-rays", "image")
CT = dc.CollectionIn("col-ct", "CT series", "dicom-series", {"modality": "CT"})


def own_draft(*cols: dc.CollectionIn) -> dc.Context:
    return dc.Context(dataset=dc.DatasetIn("ds-1", draft=True, own=True, collections=list(cols)))


def published(*cols: dc.CollectionIn) -> dc.Context:
    return dc.Context(dataset=dc.DatasetIn("ds-1", draft=False, own=True, collections=list(cols)))


def actions(files, ctx) -> list[tuple[str, str]]:
    return [(g.kind, g.action) for g in dc.classify(files, ctx)]


# ---- One case per row of §3.3 ---------------------------------------------------------------

ROWS = [
    # (row, files, context, expected (kind, action) per group)
    ("same kind and shape as a collection → add to it", [img(1), img(2)], own_draft(XRAY), [("image", "add_to_collection")]),
    ("viewable, no match, current dataset a draft → new collection", [dcm(1), dcm(2)], own_draft(XRAY), [("dicom-series", "new_collection")]),
    ("viewable, no current dataset → new draft dataset", [img(1)], dc.Context(), [("image", "new_dataset")]),
    ("viewable, current dataset published → new draft dataset", [dcm(1)], published(XRAY), [("dicom-series", "new_dataset")]),
    ("DICOM grouped into series by modality first", [dcm(1, "s1"), dcm(2, "s2"), dcm(3, "s3", "MR")], own_draft(CT), [("dicom-series", "add_to_collection"), ("dicom-series", "new_collection")]),
    ("DICOM without a series is a 2D DICOM image", [dcm(1, None, "CR")], dc.Context(), [("dicom", "new_dataset")]),
    ("table keyed by file names, with a viewable collection → asks: labels", [dc.FileIn("nod-csv", "table", "table", {"table": {"columnCount": 2, "nameColumns": ["image"]}})], own_draft(XRAY), [("table", "new_collection")]),
    ("table with no match, no dataset → new (tabular) dataset", [dc.FileIn("nod-csv", "table", "table", {"table": {"columnCount": 3, "nameColumns": []}})], dc.Context(), [("table", "new_dataset")]),
    ("table with no match, dataset has other kinds → new collection, asks", [dc.FileIn("nod-csv", "table", "table", {"table": {"columnCount": 3}})], own_draft(XRAY), [("table", "new_collection")]),
    ("archive → unpack", [dc.FileIn("nod-zip", "archive", "archive")], dc.Context(), [("archive", "unpack")]),
    ("document → keep as reference", [dc.FileIn("nod-pdf", "document", "document", {"pages": 3})], own_draft(XRAY), [("document", "keep_reference")]),
    ("audio / unknown → keep, can't use yet", [dc.FileIn("nod-mp3", "unknown", "unknown")], dc.Context(), [("unknown", "keep_unsupported")]),
    ("failed inspection → keep, can't use yet", [dc.FileIn("nod-bad", "image", "image", flags={"unsupported": "We couldn't check this file"})], dc.Context(), [("image", "keep_unsupported")]),
    ("already in Files → link to the existing File", [img(1, existing=True)], own_draft(XRAY), [("image", "link_existing")]),
    ("duplicate within the drop (flag) → link", [img(1), img(2, flags={"duplicate_of": {"nodeId": "nod-img1"}})], dc.Context(), [("image", "new_dataset"), ("image", "link_existing")]),
    ("privacy hold → the normal action (plus a notice)", [img(1, flags={"privacy": {"reason": "burned-in text"}})], own_draft(XRAY), [("image", "add_to_collection")]),
]


@pytest.mark.parametrize("row,files,ctx,expected", ROWS, ids=[r[0] for r in ROWS])
def test_each_classification_row(row, files, ctx, expected):
    assert actions(files, ctx) == expected


def test_labels_table_asks_and_relates_to_the_collection():
    groups = dc.classify([dc.FileIn("nod-csv", "table", "table", {"table": {"columnCount": 2, "nameColumns": ["file"]}})], own_draft(XRAY))
    p = dc.plan("drp-1", groups, own_draft(XRAY), preset)
    (a,) = p["actions"]
    assert a["asks"] == "labels_table" and a["relatesTo"] == "col-xray" and p["needsPerson"] is True
    assert not dc.safe_to_auto_apply(p)


def test_labels_table_in_a_mixed_drop_relates_to_the_drops_images():
    files = [img(1), img(2), dc.FileIn("nod-csv", "table", "table", {"table": {"columnCount": 2, "nameColumns": ["file"]}})]
    groups = dc.classify(files, dc.Context())
    assert [(g.kind, g.action) for g in groups] == [("image", "new_dataset"), ("table", "new_collection")]
    p = dc.plan("drp-1", groups, dc.Context(), preset)
    assert p["actions"][1]["relatesTo"] == "g-image" and p["actions"][1]["asks"] == "labels_table"


def test_privacy_holds_and_spoofed_types_are_counted():
    files = [img(1, flags={"privacy": {"reason": "burned-in text"}}), dc.FileIn("nod-fake", "archive", "image")]
    groups = dc.classify(files, dc.Context())
    assert groups[0].held == 1 and groups[0].as_dict()["held"] == 1
    # A `.png` that's a ZIP is classified by content and counted as spoofed.
    assert groups[1].kind == "archive" and groups[1].action == "unpack" and groups[1].spoofed == 1
    p = dc.plan("drp-1", groups, dc.Context(), preset)
    assert p["actions"][0]["held"] == 1


def test_a_cleared_privacy_hold_is_not_counted():
    (g,) = dc.classify([img(1, flags={"privacy": {"reason": "x", "clearedBy": "user:a"}})], dc.Context())
    assert g.held == 0


def test_mixed_drop_becomes_one_dataset_with_several_collections():
    files = [img(1), dcm(1), dcm(2), dc.FileIn("nod-pdf", "document", "document"), dc.FileIn("nod-zip", "archive", "archive"), dc.FileIn("nod-mp3", "unknown", "unknown")]
    groups = dc.classify(files, dc.Context())
    assert [(g.kind, g.action) for g in groups] == [("image", "new_dataset"), ("dicom-series", "new_collection"), ("document", "keep_reference"), ("archive", "unpack"), ("unknown", "keep_unsupported")]
    p = dc.plan("drp-1", groups, dc.Context(), preset)
    by = {a["groupId"]: a for a in p["actions"]}
    # todo19 D5: one new_dataset action; the viewable groups are its members (one Studio).
    assert [a["type"] for a in p["actions"]].count("new_dataset") == 1 and "g-dicom-series-ct" not in by
    ds = by["g-image"]
    members = {m["groupId"]: m for m in ds["members"]}
    assert members["g-image"]["preset"] == "preset:image-2d" and members["g-dicom-series-ct"]["preset"] == "preset:volume-3d" and members["g-dicom-series-ct"]["name"] == "CT series"
    assert ds["kinds"] == ["image", "dicom-series"] and ds["presets"] == ["preset:image-2d", "preset:volume-3d"] and ds["count"] == 3
    assert by["g-unsupported-unknown"]["findPluginKind"] == "unknown" and by["g-reference-document"]["asks"] == "attach_documentation"
    assert "datasetId" not in ds  # the dataset this plan creates
    assert p["needsPerson"] is False and dc.safe_to_auto_apply(p)


def test_d6_published_or_someone_elses_dataset_waits_for_the_person():
    for ctx in (published(XRAY), dc.Context(dataset=dc.DatasetIn("ds-1", draft=True, own=False, collections=[XRAY]))):
        p = dc.plan("drp-1", dc.classify([img(1)], ctx), ctx, preset)
        assert p["actions"][0]["type"] in ("add_to_collection", "new_dataset")
        if p["actions"][0]["type"] == "add_to_collection":
            assert p["needsPerson"] is True and not dc.safe_to_auto_apply(p)
    # Someone else's draft: a new collection there asks which dataset.
    ctx = dc.Context(dataset=dc.DatasetIn("ds-1", draft=True, own=False, collections=[XRAY]))
    p = dc.plan("drp-1", dc.classify([dcm(1)], ctx), ctx, preset)
    assert p["actions"][0]["type"] == "new_collection" and p["actions"][0]["asks"] == "which_dataset" and p["needsPerson"]


def test_own_draft_plans_apply_on_their_own():
    p = dc.plan("drp-1", dc.classify([img(1), dcm(1)], own_draft(XRAY)), own_draft(XRAY), preset)
    assert [a["type"] for a in p["actions"]] == ["add_to_collection", "new_collection"]
    assert p["actions"][0]["collectionId"] == "col-xray" and p["actions"][1]["datasetId"] == "ds-1"
    assert dc.safe_to_auto_apply(p)


def test_group_ids_are_stable_across_reclassification():
    a = [g.group_id for g in dc.classify([img(1), dcm(1)], dc.Context())]
    b = [g.group_id for g in dc.classify([dcm(5), img(9), img(3)], dc.Context())]
    assert set(a) == set(b) == {"g-image", "g-dicom-series-ct"}


def test_the_plan_matches_the_contract_schema():
    import jsonschema

    schema = json.loads((REPO / "schemas" / "drop-plan.v1.json").read_text())
    files = [img(1), dcm(1), dc.FileIn("nod-csv", "table", "table", {"table": {"nameColumns": ["f"]}}), dc.FileIn("nod-zip", "archive", "image"), img(2, existing=True)]
    for ctx in (dc.Context(), own_draft(XRAY), published(CT)):
        jsonschema.validate(dc.plan("drp_1", dc.classify(files, ctx), ctx, preset), schema)


# ---- The fast path's preset (intents.py mirrors studio-tools' resolveIntent) ---------------------


@pytest.mark.parametrize(
    "text,kinds,expected",
    [
        (None, ["image"], "preset:image-2d"),
        (None, ["dicom-series"], "preset:volume-3d"),
        (None, ["video"], "preset:video"),
        (None, ["waveform"], "preset:ecg"),
        (None, ["image", "video"], None),  # a tie: never guess
        ("Chest X-ray classification with five labels", ["image", "video"], "preset:image-2d"),
        ("Chest X-ray classification with five labels", [], "preset:image-2d"),
        (None, ["table"], None),
        ("segment liver CT", [], "preset:volume-3d"),
    ],
)
def test_fast_path_presets(text, kinds, expected):
    m = intents.unambiguous(text, kinds, TABLE)
    assert (m.preset if m else None) == expected


def test_term_matching_is_word_bounded_and_plural_tolerant():
    assert intents.term_pattern("x-ray").search("two xrays here")
    assert intents.term_pattern("x-ray").search("X Ray")
    assert not intents.term_pattern("mr").search("Mrs Smith")
    assert not intents.term_pattern("ct").search("project")


def test_fast_preset_only_takes_a_kind_it_can_show():
    # A mixed drop (MRI volumes, a mask, ECGs) resolves to the volume preset by count; the ECG
    # collection must keep its own preset, not open in the volume viewer.
    assert intents.unambiguous(None, ["waveform", "volume", "mask"], TABLE).preset == "preset:volume-3d"
    assert not intents.serves_kind("preset:volume-3d", "waveform", TABLE)
    assert intents.serves_kind("preset:volume-3d", "mask", TABLE)
    assert intents.serves_kind("preset:ecg", "waveform", TABLE)


def test_wfdb_signal_files_are_part_of_their_recording():
    """A .hea's .mat/.dat (paired by the gatherer) joins its Waveforms group: added to the
    collection with it, not counted as an item, not "can't use yet"."""
    from studio_api.kernel.kinds import wfdb_parts

    nodes = [("h1", "d", "HR00001.hea"), ("h2", "d", "HR00002.hea"), ("m1", "d", "HR00001.mat"), ("m2", "d", "HR00002.mat"), ("x", "other", "HR00001.mat"), ("dat", "d", "HR00002.dat")]
    parts = wfdb_parts(nodes)
    assert parts == {"m1": "h1", "m2": "h2", "dat": "h2"}
    files = [dc.FileIn("h1", "waveform", "waveform"), dc.FileIn("h2", "waveform", "waveform"), dc.FileIn("m1", "unknown", "unknown", part_of="h1"), dc.FileIn("m2", "unknown", "unknown", part_of="h2"), dc.FileIn("x", "unknown", "unknown")]
    groups = dc.classify(files, dc.Context())
    wave = next(g for g in groups if g.kind == "waveform")
    assert wave.node_ids == ["h1", "h2", "m1", "m2"] and wave.count == 2 and wave.action == "new_dataset"
    assert wave.slots == {"m1": ("h1", "signal"), "m2": ("h2", "signal")}
    assert [g.node_ids for g in groups if g.action == "keep_unsupported"] == [["x"]]
    p = dc.plan("drp-1", groups, dc.Context(), preset)
    a = next(a for a in p["actions"] if a["kind"] == "waveform")
    assert a["count"] == 2 and a["nodeIds"] == ["h1", "h2", "m1", "m2"]
