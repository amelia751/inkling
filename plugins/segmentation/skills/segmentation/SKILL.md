---
name: segmentation
description: Segment objects in 2D images with the image.segment capability and review the masks.
---

# Segmentation

Use when the user wants masks for objects in an image ("outline the lungs", "segment every
cell", "mask the polyp").

1. Check the capability is active: `list_capabilities` should list `image.segment`.
2. Call it through the gateway (`invoke_capability` with `capability: image.segment`), one
   asset at a time or as a batch. Input: `asset_id`, optional `label`, and `prompts`:
   `{type: "text", text}`, `{type: "point", x, y, positive}` or `{type: "box", box: [x0, y0, x1, y1]}`
   in image pixels.
3. Masks arrive as `ai-suggested` annotations with `review_status: pending`. Ask the user to
   review them in the Masks panel; don't treat them as ground truth.

Providers differ (text prompts, point prompts, boxes): read the provider feature matrix with
`inspect_plugin` before promising a prompt type. Hosted providers send images off-site and
may cost money; say so before using one. This file is guidance only: it grants nothing and
can't install or enable anything.
