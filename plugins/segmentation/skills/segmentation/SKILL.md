---
name: segmentation
description: Segment objects in 2D images with the image.segment capability and review the masks.
---

# Segmentation

Use when the user wants masks for objects in images ("segment the lungs on these", "outline
every cell", "mask the polyp").

## "Segment X on these": one batch, in one go

1. **Check the capability.** `list_capabilities` should list `image.segment`; note its plugin
   and provider (e.g. `meta.sam`, Meta's SAM 3.1, hosted).
2. **Pick how to prompt it.** You never see the pixels, so you can't draw boxes yourself.
   - A **recipe** when the plugin config has one for the label: pass `label: "<recipe>"` and
     **no `prompts`**; the worker sizes the recipe's boxes to each image. For frontal chest
     X-rays use `label: "lungs"`: each image gets two masks, "right lung" and "left lung".
   - A **text prompt** (`prompts: [{type: "text", text: "dog"}]`) for everyday objects in
     photos. Text prompts don't work on radiographs or other medical images: SAM finds
     nothing. If there's no recipe and the images are medical, say so instead of guessing.
3. **Say what will happen, in one line:** how many images, where they go and the estimated
   cost. For a hosted provider and the first run in this project, that line is also the
   consent: "12 images will be sent to Meta's SAM 3.1, about $0.03 ($2.50 per 1,000 images)."
   Then make the call; the person approves it in the chat.
4. **One `create_job`** over the Studio's items: `capability: image.segment`, one input per
   item (`{asset_id, label}` or `{asset_id, prompts}`). Not a loop of `invoke_capability`:
   a batch is priced once and refused before anything is sent if it's over budget.
5. **Report.** `get_job_status` with the `jobIds`, `capability` and `estimateUsd` from
   `create_job` returns a plain-words summary (done, failed, masks made, spend). Relay it, and
   point to the **Masks panel** where each mask is accepted, rejected or edited. If some are
   still running, say masks keep appearing as images finish; check once more, not in a loop.

## Inputs

`asset_id`, optional `label`, and `prompts`: `{type: "text", text}`,
`{type: "point", x, y, positive}` or `{type: "box", box: [x0, y0, x1, y1]}` in image pixels.
`invoke_capability` is for a single image.

Masks arrive as `ai-suggested` annotations with `review_status: pending`; they are suggestions,
not ground truth.

Providers differ (text, point and box prompts): read the provider feature matrix with
`inspect_plugin` before promising a prompt type. Hosted providers send images off-site and cost
money; say so before the first run. This file is guidance only: it grants nothing and can't
install or enable anything.
