# Spurby environment catalogue
An environment spec (JSON) is one Studio: a task over a set of items. `accepts` lists the data kinds it takes; `data.kinds` maps each kind to its profile (renderer, config, tools, panels, exporters), and the active item's kind picks the profile. Tools, panels, exporters and label groups are referenced by full id `<module>.<type>.<name>`; a label group's `appliesTo` names the kinds it applies to.
Validate before saving; fix errors using their `path` and `suggestion`.

## profiles
Each preset is a profile for its kind (kind → preset; a kind can have several). A Studio over several kinds `extends` one profile per kind it accepts.
- `studio.text-spans.dataKinds.text` → `preset:ner` (renderer studio.text-spans.renderers.reader)
- `studio.cine.dataKinds.volume-time` → `preset:cine-4d` (renderer studio.cine.renderers.slice-frame-canvas)
- `studio.video.dataKinds.video` → `preset:drone-video-tracks` (renderer studio.video.renderers.frame-canvas)
- `studio.timeseries.dataKinds.multichannel-timeseries` → `preset:ecg` (renderer studio.timeseries.renderers.strip-chart)
- `studio.image2d.dataKinds.raster` → `preset:generic-image` (renderer studio.image2d.renderers.canvas-raster)
- `studio.image2d.dataKinds.raster` → `preset:image-2d` (renderer studio.image2d.renderers.cornerstone-stack)
- `studio.wsi.dataKinds.raster-pyramid` → `preset:pathology` (renderer studio.wsi.renderers.osd)
- `studio.wsi.dataKinds.raster-pyramid` → `preset:satellite-tiles` (renderer studio.wsi.renderers.osd)
- `studio.timeseries.dataKinds.multichannel-timeseries` → `preset:sensor-timeseries-events` (renderer studio.timeseries.renderers.strip-chart)
- `studio.video.dataKinds.video` → `preset:video` (renderer studio.video.renderers.frame-canvas)
- `studio.volume.dataKinds.volume` → `preset:volume-3d` (renderer studio.volume.renderers.cornerstone-mpr)

## dataKinds
- `studio.generic.dataKinds.files` — One item per file, any format; shown by a sandboxed viewer renderer
- `studio.image2d.dataKinds.raster` — Single-frame images, one item per file
- `studio.volume.dataKinds.volume` — Volumes grouped by subject; each subject's sequences (NIfTI) or series (DICOM) feed the sequence picker, `sequence: seg` is the read-only reference segmentation
- `studio.timeseries.dataKinds.multichannel-timeseries` — One item per recording; channels are leads / signals. Read by the strip chart's `reader` (wfdb, csv; EDF next)
- `studio.video.dataKinds.video` — One item per video file (or frame archive)
- `studio.cine.dataKinds.volume-time` — A 4D series plus reference segmentations, as one study
- `studio.wsi.dataKinds.raster-pyramid` — One item per pyramid (slide); thumbnails are skipped
- `studio.text-spans.dataKinds.text` — One item per UTF-8 text file

## renderers
- `studio.file-view.renderers.file` — Generic file view: name, size, kind, facts, preview for images, download (consumes studio.generic.dataKinds.files; space image2d)
- `studio.image2d.renderers.cornerstone-stack` — Cornerstone3D stack viewport: window/level, invert, flip, rotate, magnifier, measurements, labelmaps; each view control can be switched off in config (consumes studio.image2d.dataKinds.raster; space image2d)
- `studio.image2d.renderers.canvas-raster` — Plain <canvas> for natural images (PNG/JPEG/WebP, no DICOM): pan, wheel zoom, select / move / resize, and the overlay2d box, polygon and keypoint tools (consumes studio.image2d.dataKinds.raster; space image2d)
- `studio.volume.renderers.cornerstone-mpr` — Cornerstone3D orthographic MPR with linked crosshairs and VOI, layouts 1×3, 1 + 2, single, 2×2 with 3D and 1 + 3D (consumes studio.volume.dataKinds.volume; space volume)
- `studio.timeseries.renderers.strip-chart` — Strip chart: stacked or column layouts, ECG paper or plain grid, zero-phase display filters, calipers (consumes studio.timeseries.dataKinds.multichannel-timeseries; space time)
- `studio.video.renderers.frame-canvas` — WebCodecs frame canvas with a playback clock, A–B range, filmstrip timeline and track overlays (consumes studio.video.dataKinds.video; space image2d)
- `studio.cine.renderers.slice-frame-canvas` — One slice × frame at a time on a canvas, with a slice × frame matrix, key frames and playback. Publishes runtime grid, playhead, references and coverage (consumes studio.cine.dataKinds.volume-time; space image2d)
- `studio.wsi.renderers.osd` — OpenSeadragon deep zoom with the overlay2d vector engine, navigator and colour adjustments (consumes studio.wsi.dataKinds.raster-pyramid; space image2d)
- `studio.text-spans.renderers.reader` — Reading view: select text to label a span; click a span to select it (consumes studio.text-spans.dataKinds.text; space text)

## geometries
- `studio.core.geometries.class` — Item-level class (whole image, recording or study)
- `studio.core.geometries.box` — Axis-aligned rectangle in item pixels
- `studio.core.geometries.ellipse` — Ellipse in item pixels
- `studio.core.geometries.polygon` — Closed contour, optionally with holes
- `studio.core.geometries.multipolygon` — Several disjoint regions with holes
- `studio.core.geometries.polyline` — Open line through points
- `studio.core.geometries.spline` — Smooth closed contour through control points
- `studio.core.geometries.keypoint` — Single 2D location (landmark, cell)
- `studio.core.geometries.point3d` — 3D landmark in voxel indices
- `studio.core.geometries.measurement` — Measurement or ROI with computed stats (length, angle, area…)
- `studio.core.geometries.mask` — Run-length encoded pixel / voxel mask
- `studio.core.geometries.span` — Span on a time axis (seconds), optionally on one channel
- `studio.core.geometries.instant` — Point in time (seconds or frame), optionally on one channel
- `studio.core.geometries.track` — Object tracked across frames by keyframes
- `studio.core.geometries.mark` — Deprecated: use keypoint
- `studio.core.geometries.point` — Deprecated: use point3d
- `studio.core.geometries.interval` — Deprecated: use span with channel
- `studio.core.geometries.beat` — Deprecated: use instant with attributes.code
- `studio.core.geometries.wave` — Deprecated: use span with attributes.wave
- `studio.core.geometries.rhythm` — Deprecated: use span with attributes.rhythm
- `studio.core.geometries.segment` — Deprecated: use span
- `studio.core.geometries.event` — Deprecated: use instant
- `studio.core.geometries.phase` — Deprecated: use instant with attributes.phase
- `studio.volume.geometries.landmark` — 3D landmark: voxel indices (i, j, k) plus the plane and slice it was placed on
- `studio.timeseries.geometries.span` — Strip-chart span: an interval, a delineated wave (attributes.wave, .peak) or a track episode (attributes.rhythm), by attributes.kind
- `studio.timeseries.geometries.instant` — Strip-chart instant with a code (attributes.kind = beat, attributes.code)
- `studio.video.geometries.segment` — A labelled segment of the video (seconds); was v1 `segment`
- `studio.video.geometries.event` — A point-in-time event on a frame; was v1 `event`
- `studio.video.geometries.track` — Object track with keyframes, interpolated between them (CVAT track semantics)
- `studio.cine.geometries.phase` — Key frame (phase) marker: instant { frame } with attributes { kind: "phase", phase }
- `studio.wsi.geometries.keypoint` — A counted point (cell) on a slide, in level-0 pixels
- `studio.text-spans.geometries.span` — Character span [start, end) of a text item

## tools
- `studio.core.tools.select` — Select, move and edit annotations
- `studio.core.tools.pan` — Pan and zoom the view
- `studio.core.tools.windowLevel` — Adjust contrast and brightness by dragging (when 'windowLevel' in renderer.capabilities)
- `studio.overlay2d.tools.box` — Axis-aligned box (creates box; when renderer.space == image2d)
- `studio.overlay2d.tools.ellipse` — Ellipse (creates ellipse; when renderer.space == image2d)
- `studio.overlay2d.tools.polygon` — Click-to-place polygon (creates polygon; when renderer.space == image2d)
- `studio.overlay2d.tools.freehand` — Freehand closed outline (creates polygon; when renderer.space == image2d)
- `studio.overlay2d.tools.polyline` — Open polyline (creates polyline; when renderer.space == image2d)
- `studio.overlay2d.tools.spline` — Smooth closed spline contour (creates spline; when renderer.space == image2d)
- `studio.overlay2d.tools.keypoint` — Single landmark (creates keypoint; when renderer.space == image2d)
- `studio.overlay2d.tools.brush` — Paint a raster mask (creates mask; when renderer.space == image2d)
- `studio.overlay2d.tools.eraser` — Erase a raster mask (creates mask; when renderer.space == image2d)
- `studio.cornerstone.tools.zoom` — Drag to zoom (when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.crosshairs` — Linked MPR crosshairs (when 'cornerstone' in renderer.capabilities && 'planes' in renderer.capabilities)
- `studio.cornerstone.tools.box` — Rectangle ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.ellipse` — Ellipse ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.polygon` — Spline / polygon ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.freehand` — Freehand ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.keypoint` — Landmark with the pixel value (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.length` — Distance in mm (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.angle` — Three-point angle (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.cobb` — Cobb angle between two lines (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.bidirectional` — RECIST long and short axes (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.probe` — Pixel value (HU for CT); saved as a measurement but not a drawing tool (when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.arrow` — Arrow with a note (creates measurement; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.brush` — Paint a labelmap, optionally thresholded to the window (creates mask; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.eraser` — Erase a labelmap (creates mask; when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.tools.wand` — Flood-fill a connected region of similar intensity (creates mask; when 'cornerstone' in renderer.capabilities)
- `studio.timeline.tools.segment` — Drag along the timeline to label a span (creates span; when 'time' in renderer.capabilities)
- `studio.timeline.tools.event` — Mark the current frame as an event (creates instant; when 'time' in renderer.capabilities)
- `studio.volume.tools.point` — 3D landmark in voxel indices (creates point3d; when renderer.space == volume)
- `studio.timeseries.tools.interval` — Time span on one channel or all (attributes.kind = interval) (creates span; when renderer == studio.timeseries.renderers.strip-chart)
- `studio.timeseries.tools.beat` — Instant with a code from `instantCodes` (attributes.kind = beat, .code) (creates instant; when renderer == studio.timeseries.renderers.strip-chart)
- `studio.timeseries.tools.wave` — Wave onset / peak / offset (attributes.kind = wave, .wave, .peak) (creates span; when renderer == studio.timeseries.renderers.strip-chart)
- `studio.timeseries.tools.rhythm` — Episode on the record-level track (attributes.kind = rhythm, .rhythm) (creates span; when renderer == studio.timeseries.renderers.strip-chart)
- `studio.timeseries.tools.caliper` — Measure Δt and Δamplitude (not saved) (when renderer == studio.timeseries.renderers.strip-chart)
- `studio.wsi.tools.brush` — Paint vector regions with the active label (creates multipolygon; when renderer == studio.wsi.renderers.osd)
- `studio.wsi.tools.eraser` — Erase from vector regions (creates multipolygon; when renderer == studio.wsi.renderers.osd)
- `studio.wsi.tools.wand` — Magic wand on tile pixels (creates polygon; when renderer == studio.wsi.renderers.osd)
- `studio.wsi.tools.mark` — Point (cell) counting (creates keypoint; when renderer == studio.wsi.renderers.osd)
- `studio.wsi.tools.length` — Distance in µm (creates measurement; when renderer == studio.wsi.renderers.osd)
- `studio.text-spans.tools.entity` — Label a selected text span (creates studio.text-spans.span; when renderer.space == text)

## commands
- `studio.core.commands.undo` — Undo the last change (an annotation in the Studio; a file operation in Sources)
- `studio.core.commands.redo` — Redo the last undone change
- `studio.core.commands.deleteSelection` — Delete the selected, unlocked annotations
- `studio.core.commands.deselect` — Clear the selection
- `studio.core.commands.selectAll` — Select every visible annotation on the current item
- `studio.core.commands.nextItem` — Go to the next item
- `studio.core.commands.prevItem` — Go to the previous item
- `studio.core.commands.nextTodo` — Go to the next item nobody has annotated yet, in queue order (the task's item order)
- `studio.core.commands.pickLabel` — Make the n-th label class active
- `studio.core.commands.brushSmaller` — Shrink the active tool's size (when 'size' in tool.options)
- `studio.core.commands.brushLarger` — Grow the active tool's size (when 'size' in tool.options)
- `studio.core.commands.showShortcuts` — Open the keyboard shortcuts sheet
- `studio.core.commands.toggleNavigation` — Collapse the project sidebar to its icon rail, or expand it (in the Studio: hide or show the rail)
- `studio.core.commands.newProject` — Open the new-project dialog: name it, Create, and it opens with its chat (when section == home || section == projects)
- `studio.core.commands.quickLook` — Preview the selected file large; arrows step through its folder (when section == sources)
- `studio.core.commands.openItem` — Open the selected folder, or show the selected file's details (when section == sources)
- `studio.core.commands.parentFolder` — Show the folder that contains the current one (when section == sources)
- `studio.core.commands.focusSearch` — Search file names across the project's files (when section == sources)
- `studio.core.commands.newFolder` — Make a folder in the folder shown, and name it (when section == sources)
- `studio.core.commands.rename` — Rename the selected file or folder (when section == sources)
- `studio.core.commands.cut` — Mark the selection to be moved by Paste (when section == sources)
- `studio.core.commands.copy` — Mark the selection to be copied by Paste (copies share the same bytes) (when section == sources)
- `studio.core.commands.paste` — Move or copy what was cut or copied into the focused or shown folder (when section == sources)
- `studio.core.commands.duplicate` — Make a copy next to the original, named “name (copy)” (when section == sources)
- `studio.core.commands.moveToTrash` — Move the selection to Trash (undo brings it back) (when section == sources)
- `studio.core.commands.clearSelection` — Deselect every file and folder (when section == sources)
- `studio.core.commands.expandAllBelow` — Open the focused folder and every folder in it (up to 2,000 rows) (when section == sources)
- `studio.core.commands.toggleInspector` — Show or hide the inspector (Info) (when section == sources)
- `studio.core.commands.filterItems` — Filter the Items panel by name (while the panel has focus) (when section == studio)
- `studio.core.commands.contextMenu` — Open the menu of the focused file or folder, as a right-click does (when section == sources)
- `studio.core.commands.toggleSidePanel` — Hide the Studio's left panel (Items and Labels) so the canvas takes its width, or show it again
- `studio.core.commands.toggleAssistant` — Open or close the assistant, in any project section
- `studio.core.commands.finishShape` — Close the shape being drawn (when 'drafting' in renderer.capabilities)
- `studio.core.commands.cancelShape` — Cancel the shape being drawn (when 'drafting' in renderer.capabilities)
- `studio.core.commands.removeLastVertex` — Remove the last vertex of the shape being drawn (when 'vertexUndo' in renderer.capabilities)
- `studio.core.commands.holdToPan` — Pan while Space is held, whatever the tool (when 'holdToPan' in renderer.capabilities)
- `studio.core.commands.rotateView` — Rotate the view 90° clockwise (when 'rotate' in renderer.capabilities)
- `studio.core.commands.playPause` — Play or pause (when 'playback' in renderer.capabilities)
- `studio.core.commands.prevFrame` — Step one frame back (when 'playback' in renderer.capabilities)
- `studio.core.commands.nextFrame` — Step one frame forward (when 'playback' in renderer.capabilities)
- `studio.core.commands.nextSuggestion` — Select the next unreviewed AI suggestion (when 'suggestions' in renderer.capabilities)
- `studio.core.commands.prevSuggestion` — Select the previous unreviewed AI suggestion (when 'suggestions' in renderer.capabilities)
- `studio.core.commands.acceptSuggestion` — Mark the selected AI suggestions as reviewed (when 'suggestions' in renderer.capabilities)
- `studio.core.commands.rejectSuggestion` — Delete the selected AI suggestion and select the next (when 'suggestions' in renderer.capabilities)
- `studio.cornerstone.commands.rotateViewLeft` — Rotate the view 90° counter-clockwise (when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.commands.toggleMagnifier` — Show or hide the hover magnifier (when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.commands.invertImage` — Invert the grayscale (when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.commands.flipHorizontal` — Mirror left–right (when 'cornerstone' in renderer.capabilities)
- `studio.cornerstone.commands.flipVertical` — Mirror top–bottom (when 'cornerstone' in renderer.capabilities)
- `studio.image2d.commands.fitView` — Reset zoom and pan (and, on the Cornerstone stack, flips, rotation and the window)
- `studio.image2d.commands.cancelManipulation` — Abort a Cornerstone tool drag or an unfinished measurement; otherwise Escape clears the selection (when renderer == studio.image2d.renderers.cornerstone-stack)
- `studio.volume.commands.fitView` — Reset every viewport (zoom, pan, flips, rotation, window) (when renderer == studio.volume.renderers.cornerstone-mpr)
- `studio.volume.commands.stepSlice` — Scroll the active plane (↑ previous, ↓ next) (when renderer == studio.volume.renderers.cornerstone-mpr)
- `studio.volume.commands.firstLastSlice` — Jump to the first (Home) or last (End) slice of the active plane (when renderer == studio.volume.renderers.cornerstone-mpr)
- `studio.volume.commands.cancelManipulation` — Cancel an in-progress Cornerstone drag (drawing, handle move); otherwise Escape falls through to clearing the selection (when renderer == studio.volume.renderers.cornerstone-mpr)
- `studio.volume.commands.interpolateSlices` — Fill the slices between painted slices of the active label along the active plane (shape-based interpolation) (when renderer == studio.volume.renderers.cornerstone-mpr)
- `studio.volume.commands.removeIslands` — Keep only the largest 3D connected region of the active label (when renderer == studio.volume.renderers.cornerstone-mpr)
- `studio.volume.commands.smartFill` — Wand clicks grow a 3D region from the clicked structure's intensity statistics (confidence-connected, ±40 mm) (when renderer == studio.volume.renderers.cornerstone-mpr && tool == wand)
- `studio.volume.commands.similarFill` — Wand clicks flood the connected region on the clicked slice within ±8% of the window (when renderer == studio.volume.renderers.cornerstone-mpr && tool == wand)
- `studio.timeseries.commands.scrollWindow` — Scroll the visible time window
- `studio.timeseries.commands.zoomTime` — Zoom the time axis
- `studio.timeseries.commands.setBeatCode` — Set the code whose `hotkey` (strip-chart `instantCodes`) was pressed on the selected instants; bind the same keys to this command
- `studio.timeseries.commands.clearCaliper` — Clear the caliper
- `studio.timeseries.commands.detectBeats` — R-peak detection on the primary (or focused) channel; results are ai-suggested instants for review. Needs strip-chart config `ecg: true`
- `studio.timeseries.commands.calibrateScreen` — Match an on-screen bar to a credit card so mm/s and mm per unit are true (grid: ecg)
- `studio.video.commands.stepFrame` — Step one frame
- `studio.video.commands.step10` — Step ten frames
- `studio.video.commands.firstLastFrame` — Jump to the first or last frame
- `studio.video.commands.toggleLoop` — Toggle looping
- `studio.video.commands.fitView` — Fit the frame to the viewport
- `studio.video.commands.toggleKeyframe` — Toggle a keyframe at the playhead
- `studio.video.commands.toggleOutside` — Toggle outside at the playhead
- `studio.video.commands.toggleOccluded` — Toggle occluded at the playhead
- `studio.video.commands.prevKeyframe` — Jump to the previous keyframe
- `studio.video.commands.nextKeyframe` — Jump to the next keyframe
- `studio.video.commands.copyToNextFrame` — Propagate the selection one frame
- `studio.video.commands.addEvent` — Add an event at the playhead (when tool == event)
- `studio.cine.commands.fitView` — Fit the image to the viewport
- `studio.cine.commands.stepFrame` — Step one frame
- `studio.cine.commands.stepSlice` — Step one slice
- `studio.cine.commands.copyContourReplace` — Copy the selected contours, replacing the target's
- `studio.cine.commands.copyContour` — Copy the selected contours to the neighbouring cell
- `studio.cine.commands.goTo` — Show a slice and frame; args { slice?, frame? } (0-based)
- `studio.wsi.commands.toggleClassNames` — Toggle class names on regions (takes N from Next to do) (when renderer == studio.wsi.renderers.osd)
- `studio.wsi.commands.importGeoJSON` — Pick a GeoJSON file (QuPath, Cytomine, DSA) and add its objects to the current slide as one undo step (when renderer == studio.wsi.renderers.osd)
- `studio.segmentation.commands.segment` — Segment objects in this image (selected label, or the provider's) (when item.mediaType =~ /^(?:image\/png|image\/jpeg|image\/webp)$/)

## panels
- `studio.core.panels.files` — The task's items, grouped, with per-item progress and a filter; the Studio titles the tab with the data kind's plural noun (Images, Studies, Slides) (slot left)
- `studio.core.panels.labels` — Item-level classes, label classes (pick; hide, lock and color in each row's menu), the current item's annotations ("On this item") and the selection (slot left)
- `studio.core.panels.review` — Every annotation in the task with provenance, and the items with none yet; not in any preset (the project's Review page has the same feed), add it when a task needs it in the Studio (slot left)
- `studio.core.panels.ai` — Assistant that can read and edit this environment (agent tools) (slot right)
- `studio.image2d.panels.viewControls` — Window/level presets, invert, flip, rotate, fit, color map, interpolation and magnifier for the Cornerstone stack (controls follow the renderer config), plus wand mode and remove-islands for mask tools (slot viewport-bar)
- `studio.timeseries.panels.measurements` — Rate and RR from instants, wave intervals (ecg), track episodes and record statements (a `multiple` Choices group) (slot right)
- `studio.cardiac-metrics.panels.metrics` — Ventricular volumes and function, LV mass, the volume curve with an ED/ES suggestion, per-slice areas, Dice vs reference and body size (slot right)
- `studio.wsi.panels.counts` — Point counts per class on the slide, and inside the selected region with density per mm² (slot right)
- `studio.wsi.panels.adjust` — Brightness, contrast, gamma and saturation of the slide tiles (display only; the wand samples them) (slot viewport-bar)
- `studio.segmentation.panels.mask-review` — Review AI-suggested masks: accept, reject or edit each instance (when item.mediaType =~ /^(?:image\/png|image\/jpeg|image\/webp)$/; slot right)

## inspectors
- `studio.image2d.inspectors.main` — Physical measurements (mm, mm², HU) for Cornerstone annotations
- `studio.volume.inspectors.main` — Volumes (mL), lengths and ROI stats in patient space; HU for CT
- `studio.timeseries.inspectors.main` — Times in s and ms, sample index (runtime.signalInfo), channel, code names and statement codes
- `studio.video.inspectors.main` — Frames, times and sizes; a track's shape at the playhead
- `studio.cine.inspectors.main` — Areas, perimeters and structure roles in mm (from runtime.grid); key frame names
- `studio.wsi.inspectors.main` — Areas and lengths in µm from the runtime's `mpp`, and points inside regions
- `studio.text-spans.inspectors.main` — Offsets, length and covered text

## exporters
- `studio.image2d.exporters.coco` — Boxes, polygons, RLE masks and keypoints in COCO format (pixel coordinates), plus image-level class labels. (accepts box, polygon, keypoint, measurement, mask, class)
- `studio.volume.exporters.nifti-labelmap` — One .nii.gz labelmap of the subject open in the studio; geometry copied from its own scan. BraTS values 1/2/4, otherwise label index + 1. (accepts mask)
- `studio.volume.exporters.masks-json` — Every subject's masks as run-length encoded voxel grids (x fastest, background first) with label values, voxel counts and volumes. (accepts mask)
- `studio.timeseries.exporters.wfdb-atr` — MIT-format <record>.atr (beats, rhythm changes, noise) plus LUDB-style per-lead wave files (<record>.i, .ii … with ( peak ) triplets), the source .hea headers and a RECORDS list. Readable with rdann / wfdb-python. (accepts span, instant, class)
- `studio.timeseries.exporters.ecg-json` — Per record: beats, P/QRS/T waves (onset/peak/offset), rhythm episodes, intervals and record statements, in seconds and sample indices. (accepts span, instant, class)
- `studio.timeseries.exporters.ecg-intervals-csv` — One row per interval, wave and rhythm episode: record, kind, lead, label, start/end in s and samples, duration in ms, provenance. (accepts span)
- `studio.video.exporters.cvat-video` — One annotations XML per video: tracks with every frame interpolated (keyframe, outside, occluded flags); per-frame shapes as one-frame tracks. (accepts track, box, polygon, keypoint)
- `studio.video.exporters.mot` — Box tracks per video as gt/gt.txt (frame, id, x, y, w, h, conf, class, visibility; 1-based frames) with seqinfo.ini. (accepts track, box)
- `studio.video.exporters.temporal-json` — Labeled segments and point-in-time events per video, in seconds and frames. (accepts span, instant)
- `studio.cine.exporters.acdc-nifti` — 4D uint8 .nii.gz on the cine's grid and orientation; value = label position (1 = RV, 2 = MYO, 3 = LV for ACDC labels). Frames without contours are zero. (accepts spline, polygon, mask)
- `studio.cine.exporters.cine-contours-json` — Every contour with its spline control points, densely sampled outline, slice, frame, area and source. (accepts spline, polygon)
- `studio.cardiac-metrics.exporters.function-csv` — Per-frame, per-slice RV/MYO/LV areas and volumes, plus EDV, ESV, SV, EF and LV mass (Simpson's method of discs). (accepts spline, polygon, mask)
- `studio.wsi.exporters.qupath-geojson` — Regions, lines and per-class point sets in level-0 pixels with classifications and measurements. Opens in QuPath (File › Import objects), Cytomine and DSA. (accepts polygon, multipolygon, keypoint, polyline, measurement, box, ellipse)
- `studio.wsi.exporters.asap-xml` — ASAP / CAMELYON annotation XML: polygons, rectangles, point sets and groups per class; holes become <class>_exclusion polygons. (accepts polygon, multipolygon, keypoint, polyline, measurement, box, ellipse)
- `studio.wsi.exporters.point-counts-csv` — Per-slide, per-class point counts with region count, region area and points/mm². (accepts keypoint)
- `studio.dicom-export.exporters.dicom-seg` — Masks as a DICOM Segmentation object referencing the source DICOM images (one segment per label). DICOM inputs only. (accepts mask)
- `studio.dicom-export.exporters.dicom-sr` — Lengths, angles, ROIs, probes and arrows as a DICOM Structured Report (TID 1500). DICOM inputs only. (accepts measurement)
- `studio.text-spans.exporters.jsonl` — One line per document: {"text", "spans": [[start, end, label]…]}, readable by spaCy and doccano. (accepts studio.text-spans.span)

## labelControls
- `studio.core.labelControls.Labels` — Classes for any drawn geometry
- `studio.core.labelControls.RectangleLabels` — Classes for boxes
- `studio.core.labelControls.EllipseLabels` — Classes for ellipses
- `studio.core.labelControls.PolygonLabels` — Classes for polygons and regions
- `studio.core.labelControls.KeyPointLabels` — Classes for points
- `studio.core.labelControls.BrushLabels` — Classes for painted masks
- `studio.core.labelControls.TimeSeriesLabels` — Classes for spans and instants on a time axis
- `studio.core.labelControls.VideoRectangle` — Classes for objects tracked through video
- `studio.core.labelControls.Choices` — Item-level classes; `multiple: true` allows several per item
- `studio.text-spans.labelControls.SpanLabels` — Classes for text spans (named entities)

## reviewRules
- `studio.core.reviewRules.source-label-disagreement` — Flags item classes that differ from the source dataset's label for that item
- `studio.core.reviewRules.unlabeled-items` — Flags items with no annotations yet

## presets
- `preset:ner` — Person / organisation / location spans on plain text, JSONL export.
- `preset:cine-4d` — Cardiac cine MRI: spline contours and masks per slice and frame, copy-forward, ED/ES phases, function metrics; ACDC NIfTI export.
- `preset:drone-video-tracks` — Aerial video: vehicles and people tracked across frames with keyframed boxes; MOT and CVAT export.
- `preset:ecg` — ECG strips on paper grid: intervals, beats with WFDB codes, P/QRS/T delineation, rhythm episodes, SNOMED CT record statements, calipers and Pan–Tompkins beat detection; WFDB and LUDB export.
- `preset:generic-image` — Natural images (photos, scans, screenshots) on a light canvas renderer: boxes, polygons and keypoints with select / move / resize; COCO export. No Cornerstone, no window/level.
- `preset:image-2d` — Radiographs and photos on a Cornerstone3D stack: window/level, ROI shapes, measurements, masks; COCO and DICOM export.
- `preset:pathology` — Whole-slide images: vector regions, region brush and wand, cell counting, µm measurements; QuPath GeoJSON, ASAP XML and counts export.
- `preset:satellite-tiles` — Deep-zoom satellite or aerial imagery (DZI): building footprints, fields and points of interest, with areas in m² from metres per pixel.
- `preset:sensor-timeseries-events` — Accelerometer or other sensor CSV on a plain-grid strip chart: activity spans (walk / run / rest) and point events (step, fall).
- `preset:video` — Video with tracked boxes, polygons and keypoints, segments and events; CVAT, MOT and temporal JSON export.
- `preset:volume-3d` — MRI / CT volumes in linked MPR with crosshairs, 3D labelmaps, measurements; NIfTI and DICOM export.
