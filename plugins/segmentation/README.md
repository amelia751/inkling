# Segmentation (reference plugin)

`image.segment` for 2D images (docs/plugins.md §12): the toolbar's **Segment** action calls
`studio.segmentation.segment_objects` through the kernel's command gateway; a worker runs
it in this plugin's own `uv` environment; the result is normalised into canonical mask
annotations (`ai-suggested`, `review_status: pending`, with provider, model and prompt), and
the trusted `studio.mask-review.v1` panel lets the expert accept, reject or edit each mask.

| Provider | Hosting | Needs | Status |
|---|---|---|---|
| `mock` | in process | nothing | deterministic masks; used in CI |
| `meta.sam` | hosted (Meta Model API, `sam-3.1`) | `network.egress:api.meta.ai`, `secrets.use:META_MODEL_API_KEY` | request and response mapping checked against dev.meta.ai on 2026-10-30 (sources in `providers/meta_sam.py`); priced at $2.50 per 1,000 images. Decoding Meta's mask payloads needs Meta's `meta-sam-parser`, which isn't locked yet, so until it's added the provider refuses before making the billable call |
| `local.sam` | self-hosted | `network.egress:sam.internal` (or your host) | posts the image and prompts to a SAM-compatible HTTP endpoint you run |

Switching providers (`configure` with `{"provider": "local.sam"}`) keeps every existing
mask and its provenance; the new provider's egress and secrets must be granted first.

```bash
cd plugins/segmentation && uv sync && uv run pytest
```
