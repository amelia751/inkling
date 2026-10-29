# Inkling environment catalogue
An environment spec (JSON) picks a data kind, viewports (renderers), tools, panels, exporters and label groups by full id `<module>.<type>.<name>`.
Validate before saving; fix errors using their `path` and `suggestion`.

## dataKinds
- `inkling.image2d.dataKinds.raster` — Single-frame images, one item per file
- `inkling.volume.dataKinds.volume` — Volumes grouped by subject; each subject's sequences (NIfTI) or series (DICOM) feed the sequence picker, `sequence: seg` is the read-only reference segmentation
- `inkling.timeseries.dataKinds.multichannel-timeseries` — One item per recording; channels are leads / signals. Read by the strip chart's `reader` (wfdb, csv; EDF next)
- `inkling.video.dataKinds.video` — One item per video file (or frame archive)
- `inkling.cine.dataKinds.volume-time` — A 4D series plus reference segmentations, as one study
- `inkling.wsi.dataKinds.raster-pyramid` — One item per pyramid (slide); thumbnails are skipped

## renderers
- `inkling.image2d.renderers.cornerstone-stack` — Cornerstone3D stack viewport: window/level, invert, flip, rotate, magnifier, measurements, labelmaps; each view control can be switched off in config (consumes inkling.image2d.dataKinds.raster; space image2d)
- `inkling.image2d.renderers.canvas-raster` — Plain <canvas> for natural images (PNG/JPEG/WebP, no DICOM): pan, wheel zoom, select / move / resize, and the overlay2d box, polygon and keypoint tools (consumes inkling.image2d.dataKinds.raster; space image2d)
- `inkling.volume.renderers.cornerstone-mpr` — Cornerstone3D orthographic MPR with linked crosshairs and VOI, layouts 1×3, 1 + 2, single, 2×2 with 3D and 1 + 3D (consumes inkling.volume.dataKinds.volume; space volume)
- `inkling.timeseries.renderers.strip-chart` — Strip chart: stacked or column layouts, ECG paper or plain grid, zero-phase display filters, calipers (consumes inkling.timeseries.dataKinds.multichannel-timeseries; space time)
- `inkling.video.renderers.frame-canvas` — WebCodecs frame canvas with a playback clock, A–B range, filmstrip timeline and track overlays (consumes inkling.video.dataKinds.video; space image2d)
- `inkling.cine.renderers.slice-frame-canvas` — One slice × frame at a time on a canvas, with a slice × frame matrix, key frames and playback. Publishes runtime grid, playhead, references and coverage (consumes inkling.cine.dataKinds.volume-time; space image2d)
- `inkling.wsi.renderers.osd` — OpenSeadragon deep zoom with the overlay2d vector engine, navigator and colour adjustments (consumes inkling.wsi.dataKinds.raster-pyramid; space image2d)

## geometries
- `inkling.core.geometries.class` — Item-level class (whole image, recording or study)
- `inkling.core.geometries.box` — Axis-aligned rectangle in item pixels
- `inkling.core.geometries.ellipse` — Ellipse in item pixels
- `inkling.core.geometries.polygon` — Closed contour, optionally with holes
- `inkling.core.geometries.multipolygon` — Several disjoint regions with holes
- `inkling.core.geometries.polyline` — Open line through points
- `inkling.core.geometries.spline` — Smooth closed contour through control points
- `inkling.core.geometries.keypoint` — Single 2D location (landmark, cell)
- `inkling.core.geometries.point3d` — 3D landmark in voxel indices
- `inkling.core.geometries.measurement` — Measurement or ROI with computed stats (length, angle, area…)
- `inkling.core.geometries.mask` — Run-length encoded pixel / voxel mask
- `inkling.core.geometries.span` — Span on a time axis (seconds), optionally on one channel
- `inkling.core.geometries.instant` — Point in time (seconds or frame), optionally on one channel
- `inkling.core.geometries.track` — Object tracked across frames by keyframes
- `inkling.core.geometries.mark` — Deprecated: use keypoint
- `inkling.core.geometries.point` — Deprecated: use point3d
- `inkling.core.geometries.interval` — Deprecated: use span with channel
- `inkling.core.geometries.beat` — Deprecated: use instant with attributes.code
- `inkling.core.geometries.wave` — Deprecated: use span with attributes.wave
- `inkling.core.geometries.rhythm` — Deprecated: use span with attributes.rhythm
- `inkling.core.geometries.segment` — Deprecated: use span
- `inkling.core.geometries.event` — Deprecated: use instant
- `inkling.core.geometries.phase` — Deprecated: use instant with attributes.phase
- `inkling.volume.geometries.landmark` — 3D landmark: voxel indices (i, j, k) plus the plane and slice it was placed on
- `inkling.timeseries.geometries.span` — Strip-chart span: an interval, a delineated wave (attributes.wave, .peak) or a track episode (attributes.rhythm), by attributes.kind
- `inkling.timeseries.geometries.instant` — Strip-chart instant with a code (attributes.kind = beat, attributes.code)
- `inkling.video.geometries.segment` — A labelled segment of the video (seconds); was v1 `segment`
- `inkling.video.geometries.event` — A point-in-time event on a frame; was v1 `event`
- `inkling.video.geometries.track` — Object track with keyframes, interpolated between them (CVAT track semantics)
- `inkling.cine.geometries.phase` — Key frame (phase) marker: instant { frame } with attributes { kind: "phase", phase }
- `inkling.wsi.geometries.keypoint` — A counted point (cell) on a slide, in level-0 pixels

## tools
- `inkling.core.tools.select` — Select, move and edit annotations
- `inkling.core.tools.pan` — Pan and zoom the view
- `inkling.core.tools.windowLevel` — Adjust contrast and brightness by dragging (when 'windowLevel' in renderer.capabilities)
- `inkling.overlay2d.tools.box` — Axis-aligned box (creates box; when renderer.space == image2d)
- `inkling.overlay2d.tools.ellipse` — Ellipse (creates ellipse; when renderer.space == image2d)
- `inkling.overlay2d.tools.polygon` — Click-to-place polygon (creates polygon; when renderer.space == image2d)
- `inkling.overlay2d.tools.freehand` — Freehand closed outline (creates polygon; when renderer.space == image2d)
- `inkling.overlay2d.tools.polyline` — Open polyline (creates polyline; when renderer.space == image2d)
- `inkling.overlay2d.tools.spline` — Smooth closed spline contour (creates spline; when renderer.space == image2d)
- `inkling.overlay2d.tools.keypoint` — Single landmark (creates keypoint; when renderer.space == image2d)
- `inkling.overlay2d.tools.brush` — Paint a raster mask (creates mask; when renderer.space == image2d)
- `inkling.overlay2d.tools.eraser` — Erase a raster mask (creates mask; when renderer.space == image2d)
- `inkling.cornerstone.tools.zoom` — Drag to zoom (when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.crosshairs` — Linked MPR crosshairs (when 'cornerstone' in renderer.capabilities && 'planes' in renderer.capabilities)
- `inkling.cornerstone.tools.box` — Rectangle ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.ellipse` — Ellipse ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.polygon` — Spline / polygon ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.freehand` — Freehand ROI with stats (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.keypoint` — Landmark with the pixel value (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.length` — Distance in mm (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.angle` — Three-point angle (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.cobb` — Cobb angle between two lines (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.bidirectional` — RECIST long and short axes (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.probe` — Pixel value (HU for CT); saved as a measurement but not a drawing tool (when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.arrow` — Arrow with a note (creates measurement; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.brush` — Paint a labelmap, optionally thresholded to the window (creates mask; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.eraser` — Erase a labelmap (creates mask; when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.tools.wand` — Flood-fill a connected region of similar intensity (creates mask; when 'cornerstone' in renderer.capabilities)
- `inkling.timeline.tools.segment` — Drag along the timeline to label a span (creates span; when 'time' in renderer.capabilities)
- `inkling.timeline.tools.event` — Mark the current frame as an event (creates instant; when 'time' in renderer.capabilities)
- `inkling.volume.tools.point` — 3D landmark in voxel indices (creates point3d; when renderer.space == volume)
- `inkling.timeseries.tools.interval` — Time span on one channel or all (attributes.kind = interval) (creates span; when renderer == inkling.timeseries.renderers.strip-chart)
- `inkling.timeseries.tools.beat` — Instant with a code from `instantCodes` (attributes.kind = beat, .code) (creates instant; when renderer == inkling.timeseries.renderers.strip-chart)
- `inkling.timeseries.tools.wave` — Wave onset / peak / offset (attributes.kind = wave, .wave, .peak) (creates span; when renderer == inkling.timeseries.renderers.strip-chart)
- `inkling.timeseries.tools.rhythm` — Episode on the record-level track (attributes.kind = rhythm, .rhythm) (creates span; when renderer == inkling.timeseries.renderers.strip-chart)
- `inkling.timeseries.tools.caliper` — Measure Δt and Δamplitude (not saved) (when renderer == inkling.timeseries.renderers.strip-chart)
- `inkling.wsi.tools.brush` — Paint vector regions with the active label (creates multipolygon; when renderer == inkling.wsi.renderers.osd)
- `inkling.wsi.tools.eraser` — Erase from vector regions (creates multipolygon; when renderer == inkling.wsi.renderers.osd)
- `inkling.wsi.tools.wand` — Magic wand on tile pixels (creates polygon; when renderer == inkling.wsi.renderers.osd)
- `inkling.wsi.tools.mark` — Point (cell) counting (creates keypoint; when renderer == inkling.wsi.renderers.osd)
- `inkling.wsi.tools.length` — Distance in µm (creates measurement; when renderer == inkling.wsi.renderers.osd)

## commands
- `inkling.core.commands.undo` — Undo the last annotation change
- `inkling.core.commands.redo` — Redo
- `inkling.core.commands.deleteSelection` — Delete the selected, unlocked annotations
- `inkling.core.commands.deselect` — Clear the selection
- `inkling.core.commands.selectAll` — Select every visible annotation on the current item
- `inkling.core.commands.nextItem` — Go to the next item
- `inkling.core.commands.prevItem` — Go to the previous item
- `inkling.core.commands.pickLabel` — Make the n-th label class active
- `inkling.core.commands.brushSmaller` — Shrink the active tool's size (when 'size' in tool.options)
- `inkling.core.commands.brushLarger` — Grow the active tool's size (when 'size' in tool.options)
- `inkling.core.commands.showShortcuts` — Open the keyboard shortcuts sheet
- `inkling.core.commands.finishShape` — Close the shape being drawn (when 'drafting' in renderer.capabilities)
- `inkling.core.commands.cancelShape` — Cancel the shape being drawn (when 'drafting' in renderer.capabilities)
- `inkling.core.commands.removeLastVertex` — Remove the last vertex of the shape being drawn (when 'vertexUndo' in renderer.capabilities)
- `inkling.core.commands.holdToPan` — Pan while Space is held, whatever the tool (when 'holdToPan' in renderer.capabilities)
- `inkling.core.commands.rotateView` — Rotate the view 90° clockwise (when 'rotate' in renderer.capabilities)
- `inkling.core.commands.playPause` — Play or pause (when 'playback' in renderer.capabilities)
- `inkling.core.commands.prevFrame` — Step one frame back (when 'playback' in renderer.capabilities)
- `inkling.core.commands.nextFrame` — Step one frame forward (when 'playback' in renderer.capabilities)
- `inkling.core.commands.nextSuggestion` — Select the next unreviewed AI suggestion (when 'suggestions' in renderer.capabilities)
- `inkling.core.commands.prevSuggestion` — Select the previous unreviewed AI suggestion (when 'suggestions' in renderer.capabilities)
- `inkling.core.commands.acceptSuggestion` — Mark the selected AI suggestions as reviewed (when 'suggestions' in renderer.capabilities)
- `inkling.core.commands.rejectSuggestion` — Delete the selected AI suggestion and select the next (when 'suggestions' in renderer.capabilities)
- `inkling.cornerstone.commands.rotateViewLeft` — Rotate the view 90° counter-clockwise (when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.commands.toggleMagnifier` — Show or hide the hover magnifier (when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.commands.invertImage` — Invert the grayscale (when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.commands.flipHorizontal` — Mirror left–right (when 'cornerstone' in renderer.capabilities)
- `inkling.cornerstone.commands.flipVertical` — Mirror top–bottom (when 'cornerstone' in renderer.capabilities)
- `inkling.image2d.commands.fitView` — Reset zoom and pan (and, on the Cornerstone stack, flips, rotation and the window)
- `inkling.image2d.commands.cancelManipulation` — Abort a Cornerstone tool drag or an unfinished measurement; otherwise Escape clears the selection (when renderer == inkling.image2d.renderers.cornerstone-stack)
- `inkling.volume.commands.fitView` — Reset every viewport (zoom, pan, flips, rotation, window) (when renderer == inkling.volume.renderers.cornerstone-mpr)
- `inkling.volume.commands.stepSlice` — Scroll the active plane (↑ previous, ↓ next) (when renderer == inkling.volume.renderers.cornerstone-mpr)
- `inkling.volume.commands.firstLastSlice` — Jump to the first (Home) or last (End) slice of the active plane (when renderer == inkling.volume.renderers.cornerstone-mpr)
- `inkling.volume.commands.cancelManipulation` — Cancel an in-progress Cornerstone drag (drawing, handle move); otherwise Escape falls through to clearing the selection (when renderer == inkling.volume.renderers.cornerstone-mpr)
- `inkling.volume.commands.interpolateSlices` — Fill the slices between painted slices of the active label along the active plane (shape-based interpolation) (when renderer == inkling.volume.renderers.cornerstone-mpr)
- `inkling.volume.commands.removeIslands` — Keep only the largest 3D connected region of the active label (when renderer == inkling.volume.renderers.cornerstone-mpr)
- `inkling.volume.commands.smartFill` — Wand clicks grow a 3D region from the clicked structure's intensity statistics (confidence-connected, ±40 mm) (when renderer == inkling.volume.renderers.cornerstone-mpr && tool == wand)
- `inkling.volume.commands.similarFill` — Wand clicks flood the connected region on the clicked slice within ±8% of the window (when renderer == inkling.volume.renderers.cornerstone-mpr && tool == wand)
- `inkling.timeseries.commands.scrollWindow` — Scroll the visible time window
- `inkling.timeseries.commands.zoomTime` — Zoom the time axis
- `inkling.timeseries.commands.setBeatCode` — Set the code whose `hotkey` (strip-chart `instantCodes`) was pressed on the selected instants; bind the same keys to this command
- `inkling.timeseries.commands.clearCaliper` — Clear the caliper
- `inkling.timeseries.commands.detectBeats` — R-peak detection on the primary (or focused) channel; results are ai-suggested instants for review. Needs strip-chart config `ecg: true`
- `inkling.timeseries.commands.calibrateScreen` — Match an on-screen bar to a credit card so mm/s and mm per unit are true (grid: ecg)
- `inkling.video.commands.stepFrame` — Step one frame
- `inkling.video.commands.step10` — Step ten frames
- `inkling.video.commands.firstLastFrame` — Jump to the first or last frame
- `inkling.video.commands.toggleLoop` — Toggle looping
- `inkling.video.commands.fitView` — Fit the frame to the viewport
- `inkling.video.commands.toggleKeyframe` — Toggle a keyframe at the playhead
- `inkling.video.commands.toggleOutside` — Toggle outside at the playhead
- `inkling.video.commands.toggleOccluded` — Toggle occluded at the playhead
- `inkling.video.commands.prevKeyframe` — Jump to the previous keyframe
- `inkling.video.commands.nextKeyframe` — Jump to the next keyframe
- `inkling.video.commands.copyToNextFrame` — Propagate the selection one frame
- `inkling.video.commands.addEvent` — Add an event at the playhead (when tool == event)
- `inkling.cine.commands.fitView` — Fit the image to the viewport
- `inkling.cine.commands.stepFrame` — Step one frame
- `inkling.cine.commands.stepSlice` — Step one slice
- `inkling.cine.commands.copyContourReplace` — Copy the selected contours, replacing the target's
- `inkling.cine.commands.copyContour` — Copy the selected contours to the neighbouring cell
- `inkling.cine.commands.goTo` — Show a slice and frame; args { slice?, frame? } (0-based)
- `inkling.wsi.commands.toggleClassNames` — Toggle class names on regions (when renderer == inkling.wsi.renderers.osd)
- `inkling.wsi.commands.importGeoJSON` — Pick a GeoJSON file (QuPath, Cytomine, DSA) and add its objects to the current slide as one undo step (when renderer == inkling.wsi.renderers.osd)

## panels
- `inkling.core.panels.files` — The project's items, grouped, with per-item progress and a filter (slot left)
- `inkling.core.panels.labels` — Label classes (pick, hide, lock), item-level classes, overlay opacity and the selection inspector (slot left)
- `inkling.core.panels.review` — Every annotation with provenance, and the items with none yet (slot left)
- `inkling.core.panels.ai` — Assistant that can read and edit this environment (agent tools) (slot right)
- `inkling.image2d.panels.viewControls` — Window/level presets, invert, flip, rotate, fit, color map, interpolation and magnifier for the Cornerstone stack (controls follow the renderer config), plus wand mode and remove-islands for mask tools (slot viewport-bar)
- `inkling.timeseries.panels.measurements` — Rate and RR from instants, wave intervals (ecg), track episodes and record statements (a `multiple` Choices group) (slot right)
- `inkling.cardiac-metrics.panels.metrics` — Ventricular volumes and function, LV mass, the volume curve with an ED/ES suggestion, per-slice areas, Dice vs reference and body size (slot right)
- `inkling.wsi.panels.counts` — Point counts per class on the slide, and inside the selected region with density per mm² (slot right)
- `inkling.wsi.panels.adjust` — Brightness, contrast, gamma and saturation of the slide tiles (display only; the wand samples them) (slot viewport-bar)

## inspectors
- `inkling.image2d.inspectors.main` — Physical measurements (mm, mm², HU) for Cornerstone annotations
- `inkling.volume.inspectors.main` — Volumes (mL), lengths and ROI stats in patient space; HU for CT
- `inkling.timeseries.inspectors.main` — Times in s and ms, sample index (runtime.signalInfo), channel, code names and statement codes
- `inkling.video.inspectors.main` — Frames, times and sizes; a track's shape at the playhead
- `inkling.cine.inspectors.main` — Areas, perimeters and structure roles in mm (from runtime.grid); key frame names
- `inkling.wsi.inspectors.main` — Areas and lengths in µm from the runtime's `mpp`, and points inside regions

## exporters
- `inkling.image2d.exporters.coco` — Boxes, polygons, RLE masks and keypoints in COCO format (pixel coordinates), plus image-level class labels. (accepts box, polygon, keypoint, measurement, mask, class)
- `inkling.volume.exporters.nifti-labelmap` — One .nii.gz labelmap of the subject open in the studio; geometry copied from its own scan. BraTS values 1/2/4, otherwise label index + 1. (accepts mask)
- `inkling.volume.exporters.masks-json` — Every subject's masks as run-length encoded voxel grids (x fastest, background first) with label values, voxel counts and volumes. (accepts mask)
- `inkling.timeseries.exporters.wfdb-atr` — MIT-format <record>.atr (beats, rhythm changes, noise) plus LUDB-style per-lead wave files (<record>.i, .ii … with ( peak ) triplets), the source .hea headers and a RECORDS list. Readable with rdann / wfdb-python. (accepts span, instant, class)
- `inkling.timeseries.exporters.ecg-json` — Per record: beats, P/QRS/T waves (onset/peak/offset), rhythm episodes, intervals and record statements, in seconds and sample indices. (accepts span, instant, class)
- `inkling.timeseries.exporters.ecg-intervals-csv` — One row per interval, wave and rhythm episode: record, kind, lead, label, start/end in s and samples, duration in ms, provenance. (accepts span)
- `inkling.video.exporters.cvat-video` — One annotations XML per video: tracks with every frame interpolated (keyframe, outside, occluded flags); per-frame shapes as one-frame tracks. (accepts track, box, polygon, keypoint)
- `inkling.video.exporters.mot` — Box tracks per video as gt/gt.txt (frame, id, x, y, w, h, conf, class, visibility; 1-based frames) with seqinfo.ini. (accepts track, box)
- `inkling.video.exporters.temporal-json` — Labeled segments and point-in-time events per video, in seconds and frames. (accepts span, instant)
- `inkling.cine.exporters.acdc-nifti` — 4D uint8 .nii.gz on the cine's grid and orientation; value = label position (1 = RV, 2 = MYO, 3 = LV for ACDC labels). Frames without contours are zero. (accepts spline, polygon, mask)
- `inkling.cine.exporters.cine-contours-json` — Every contour with its spline control points, densely sampled outline, slice, frame, area and source. (accepts spline, polygon)
- `inkling.cardiac-metrics.exporters.function-csv` — Per-frame, per-slice RV/MYO/LV areas and volumes, plus EDV, ESV, SV, EF and LV mass (Simpson's method of discs). (accepts spline, polygon, mask)
- `inkling.wsi.exporters.qupath-geojson` — Regions, lines and per-class point sets in level-0 pixels with classifications and measurements. Opens in QuPath (File › Import objects), Cytomine and DSA. (accepts polygon, multipolygon, keypoint, polyline, measurement, box, ellipse)
- `inkling.wsi.exporters.asap-xml` — ASAP / CAMELYON annotation XML: polygons, rectangles, point sets and groups per class; holes become <class>_exclusion polygons. (accepts polygon, multipolygon, keypoint, polyline, measurement, box, ellipse)
- `inkling.wsi.exporters.point-counts-csv` — Per-slide, per-class point counts with region count, region area and points/mm². (accepts keypoint)
- `inkling.dicom-export.exporters.dicom-seg` — Masks as a DICOM Segmentation object referencing the source DICOM images (one segment per label). DICOM inputs only. (accepts mask)
- `inkling.dicom-export.exporters.dicom-sr` — Lengths, angles, ROIs, probes and arrows as a DICOM Structured Report (TID 1500). DICOM inputs only. (accepts measurement)

## labelControls
- `inkling.core.labelControls.Labels` — Classes for any drawn geometry
- `inkling.core.labelControls.RectangleLabels` — Classes for boxes
- `inkling.core.labelControls.EllipseLabels` — Classes for ellipses
- `inkling.core.labelControls.PolygonLabels` — Classes for polygons and regions
- `inkling.core.labelControls.KeyPointLabels` — Classes for points
- `inkling.core.labelControls.BrushLabels` — Classes for painted masks
- `inkling.core.labelControls.TimeSeriesLabels` — Classes for spans and instants on a time axis
- `inkling.core.labelControls.VideoRectangle` — Classes for objects tracked through video
- `inkling.core.labelControls.Choices` — Item-level classes; `multiple: true` allows several per item

## reviewRules
- `inkling.core.reviewRules.source-label-disagreement` — Flags item classes that differ from the source dataset's label for that item
- `inkling.core.reviewRules.unlabeled-items` — Flags items with no annotations yet

## presets
- `preset:cine-4d` — Cardiac cine MRI: spline contours and masks per slice and frame, copy-forward, ED/ES phases, function metrics; ACDC NIfTI export.
- `preset:drone-video-tracks` — Aerial video: vehicles and people tracked across frames with keyframed boxes; MOT and CVAT export.
- `preset:ecg` — ECG strips on paper grid: intervals, beats with WFDB codes, P/QRS/T delineation, rhythm episodes, SNOMED CT record statements, calipers and Pan–Tompkins beat detection; WFDB and LUDB export.
- `preset:generic-image` — Natural images (photos, scans, screenshots) on a light canvas renderer: boxes, polygons and keypoints with select / move / resize; COCO export. No Cornerstone, no window/level.
- `preset:image-2d` — Radiographs and photos on a Cornerstone3D stack: window/level, ROI shapes, measurements, masks; COCO and DICOM export.
- `preset:pathology` — Whole-slide images: vector regions, region brush and wand, cell counting, µm measurements; QuPath GeoJSON, ASAP XML and counts export.
- `preset:satellite-tiles` — Deep-zoom satellite or aerial imagery (DZI): building footprints, fields and points of interest, with areas in m² from metres per pixel.
- `preset:video` — Video with tracked boxes, polygons and keypoints, segments and events; CVAT, MOT and temporal JSON export.
- `preset:volume-3d` — MRI / CT volumes in linked MPR with crosshairs, 3D labelmaps, measurements; NIfTI and DICOM export.
