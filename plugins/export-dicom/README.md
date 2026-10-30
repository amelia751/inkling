# DICOM export (`inkling.dicom-export`)

Two exporters for items whose source images are DICOM (the Cornerstone renderers in
`inkling.image2d` and `inkling.volume`). The module is UI-only (`runtime.kind:
browser-bundled`) and asks for no permissions: it runs in the trusted origin and writes a
file the browser downloads.

- `exporters.dicom-seg`: masks (`mask` geometry) as a DICOM Segmentation object that
  references the source images, one segment per label, with the label's colour. It writes
  `<project>-seg.dcm`.
- `exporters.dicom-sr`: measurements (`measurement` geometry: lengths, angles, ROIs,
  probes and arrows) as a DICOM Structured Report (TID 1500). It writes `<project>-sr.dcm`.

Both export the current item only. They're offered only when the project has `.dcm`
assets, and they fail with a message if the item isn't DICOM or has nothing to export.
For non-DICOM inputs, use the NIfTI or COCO exporters instead.

The files are built with `@cornerstonejs/adapters` and written with `dcmjs`
(`ui/dicomExport.ts`). They're loaded lazily through `ui/impl.ts`, so Cornerstone stays out
of the app shell. `ui/manifest.ts` is the trusted module manifest, and `plugin.yaml` is
the data-only manifest that the registry and installer read.
