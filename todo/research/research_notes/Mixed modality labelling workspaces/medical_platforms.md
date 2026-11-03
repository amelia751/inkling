# How medical-imaging and pathology annotation platforms organise mixed modalities and convert uploads (as of Nov 2026)

Scope note: sources were fetched on 2026-11-02. Most vendor doc pages are undated "living" docs; where a source is dated or visibly old it is flagged inline. Lunit, Gradient Health's own platform, and a dedicated WFDB/EDF labelling product beyond PhysioNet LightWAVE are thin or missing (see Gaps).

## 1. What is the unit of work, and is there a patient/study hierarchy where the viewer is picked per series?

### Takeaway
The radiology-native tools keep a DICOM-shaped hierarchy (patient → study/session → series/acquisition → instance) and make the **study or a hand-picked group of series** the unit of work. A layout or hanging protocol then picks the viewport per series. Generic labelling tools (Encord, V7, Ango) started with "one file = one task" and added a grouping object on top: Encord Data Groups, V7 slots, Ango multi-DICOM assets. Pathology tools use **case/accession → slide**, and each slide is a single tiled image.

### Cited Findings

**Flywheel**
- Hierarchy is Site > Group > Project > Subject > Session > Acquisition > Files. A Session is "a subject's visit or interaction with a modality", and an Acquisition is a "unit of data collected during a session (for example a T1 Weighted sequence or a tasked-based EEG)". Files can be attached at any level, for example a CSV on a project or exam results on a subject. — [Flywheel hierarchy](https://docs.flywheel.io/user/navigate/user_the_flywheel_hierarchy/)
- "The core organization is strictly enforced… Sessions cannot be directly attached to the group." Flywheel usually builds the structure itself by reading file headers such as DICOM tags. — [Flywheel hierarchy](https://docs.flywheel.io/user/navigate/user_the_flywheel_hierarchy/)
- A Read Protocol defines a hanging protocol: "Symmetric vs Asymmetric, modality, viewport type (2D vs 2D MPR), & series description for which image needs to go where". Several protocols can run in one project "without the need to copy data to new projects". — [Flywheel Intro to Tasks](https://docs.flywheel.io/user/workflow/tasks/user_introduction_to_read_tasks/)
- In the V3 task viewer, the file browser is disabled by default and can be scoped to "Enabled for Subject" or "Enabled for Session". The reader's context is therefore a configurable slice of the hierarchy. — [Flywheel Protocol Builder](https://docs.flywheel.io/user/workflow/tasks-manager/tasks_manager_protocol_builder/)

**MD.ai**
- "An MD.ai project consists of DICOM datasets, users, label groups and labels." — [MD.ai Create Project](https://docs.md.ai/annotator/projects/create-project/)
- Global labels have `Exam`, `Series` or `Image` scope. Local (region) labels apply to individual images only. — [MD.ai Label Types](https://docs.md.ai/annotator/ui/labels/label-types/)
- "Because our platform is built primarily for DICOM, images and videos are wrapped as virtual DICOM objects." The folder convention is `<study>/<video>.ext` for videos and `<study>/<series>/<image>.ext` for images. "Without this folder structure, each image or video will be created as a separate study." — [MD.ai Create Dataset](https://docs.md.ai/annotator/datasets/create-dataset/)

**RedBrick AI**
- A Task "can consist of anything - a single image, series, or entire study". For example, a 4-series MRI study should be uploaded "as a single Task". — [RedBrick Tasks](https://app.redbrickai.com/docs/projects/tasks-and-assignment)
- Each Items List entry becomes one Task, which holds `series: Series[]`. A Series can be a DICOM file list or a single NIfTI string. An alternative study-level format takes a flat `.dcm` list that RedBrick "will parse… on the client side and automatically split… into one or more series", but only "after a user opens the Task in the Annotation Tool". — [RedBrick Items List](https://app.redbrickai.com/docs/importing-data/import-cloud-data/creating-an-items-list)
- "A Series can represent anything from a single MRI/CT series, a video, or a single 2D image." — [RedBrick format reference](https://app.redbrickai.com/docs/python-sdk/formats/full-format-reference)
- The project-level Custom Hanging Protocol script receives `Series{seriesIndex, is2DImage, isVideo, numFrames, name, imagingAxis}`. It returns layout tabs and views (`plane: AXIAL|SAGITTAL|CORONAL|3D|MIP`), windowing, thresholding and sync. — [RedBrick Custom Hanging Protocol](https://app.redbrickai.com/docs/project-pages/settings-page/custom-hanging-protocol)

**Encord**
- Each DICOM upload creates a `DicomSeries` file. "Only `DicomSeries` are displayed in the Encord application." — [Encord Manual Data Registration](https://docs.encord.com/platform-documentation/Curate/add-files/index-register-cloud-data)
- The label editor has a dropdown to switch series by Patient ID / Study ID / Series title. Study-level classification works by grouping a study's series into a **Data Group**. "The Study level Classifications Project setting is no longer available." A Data Group holds at most 50 data units. — [Encord DICOM and NIfTI](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-dicom)
- A Data Group "can include any data type (images, videos, audio files, text files, PDFs, DICOM series)" and supports default grid, list (carousel) and custom split-pane layouts. — [Encord Data Groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups); [Encord registration JSON](https://docs.encord.com/platform-documentation/Curate/add-files/index-register-cloud-data)
- Data Groups reached general release with cross-tile instances and group-scoped global classifications. Timeseries became GA on Oct 16, 2026, uploadable "as a single modality, as part of a Data Group, or within Scenes". — [Encord 2026 release notes](https://docs.encord.com/release-notes/releasenotes-2026)

**V7 Darwin**
- A dataset item can hold several **slots**, each holding one file. "Only DICOM (.dcm) slices can be registered within the same slot_name, resulting in concatenation of those slices. Other file types must occupy their own slot." Different file types can sit in different slots of the same item. — [V7 Registering external items](https://docs.v7labs.com/docs/registering-items-from-external-storage)
- V7 Academy says slots are "especially valuable for medical use cases, for example, mammography hanging protocols". Its example is an ultrasound in one slot beside a PDF health record in another. — [V7 Slots](https://www.v7darwin.com/academy/slots)
- The `darwin-py` `push(item_merge_mode=…)` option accepts `slots`, `channels` or `series`. In `series` mode, "Other file types are ignored". — [V7 Upload files](https://docs.v7labs.com/docs/upload-images)
- Custom layouts go up to 16 files (8 columns or 4 rows) and exclude multi-planar-view (MPV) DICOM. — [V7 Layouts](https://docs.v7labs.com/docs/layouts)

**iMerit Ango Hub**
- Projects contain assets, assets generate tasks, and a project bundles datasets, ontology and workflow. — [Ango Hub FAQ](https://docs.imerit.net/faqs)
- A multi-DICOM asset shows each DICOM "in its own view" in a multi-view grid. — [Ango DICOM Labeling Editor](https://docs.imerit.net/labeling/labeling-editor-interface/dicom-labeling-editor)
- In the Medical (NRRD/NIfTI) editor, "reference volumes" are view-only. "Only the main volume can be annotated." — [Ango Medical Labeling Editor](https://docs.imerit.net/labeling/labeling-editor-interface/medical-labeling-editor)

**XNAT**
- The core types are Project, Subject and Experiment. An Image Session (MR, PET, CT…) is an Experiment with Scans (each scan is a DICOM series), Reconstructions, Assessors and Resources. A session "will usually contain multiple scans of different types". — [XNAT data model](https://wiki.xnat.org/documentation/understanding-the-xnat-data-model)
- The guidance is to group data by imaging session and "determine the correct modality" of the session. Files that are not from a session belong as subject or project resources, or in a custom experiment type. — [XNAT storage strategies](https://wiki.xnat.org/documentation/strategies-for-xnat-image-data-storage)

**OHIF (+ Orthanc / dcm4chee as the backing archive)**
- A mode lists `sopClassHandlers`, which build DisplaySets from series, and `hangingProtocols`. "If you specify an array of hanging protocols, they will get ranked based on the displaySetSelector requirements and the winner" runs. — [OHIF Modes](https://docs.ohif.org/platform/modes/)
- A protocol picks the layout, the viewport type (stack or volume), and which DisplaySet goes where (e.g. CT + SeriesDescription match). — [OHIF Hanging Protocol module](https://docs.ohif.org/llm/platform/extensions/modules/hpModule.md)
- A single series can split into several DisplaySets. For example, MG "might have mixed views in a single series". — [OHIF DisplaySetService](https://docs.ohif.org/llm/platform/services/data/DisplaySetService.md)
- OHIF v3.13 brings a "GenericViewport base with explicit, per-data-type render paths (planar CPU/GPU, video, ECG, whole-slide imaging, and 3D volume)" and "a dedicated ECG viewport for DICOM waveforms". One study viewer now dispatches to a renderer per data type. — [OHIF v3.13 release notes](https://ohif.org/release-notes/3p13/)

**Pathology (case → slide)**
- AISight Dx: "Cases are assigned by creating accessions". The pathologist opens an accession to read its slides. — [AISight Dx K243391 summary](https://fda.innolitics.com/submissions/PA/subpart-d%E2%80%94pathology-instrumentation-and-accessories/QKQ/K243391)
- Concentriq AP-Dx: "The reading pathologist selects a case from a worklist… the subject device fetches the associated images". — [FDA K261380](https://www.accessdata.fda.gov/cdrh_docs/reviews/K261380.pdf)
- HALO Link is marketed as having "flexible data organization and a study-centric browser experience". — [HALO Link](https://indicalab.com/halo-link/)
- In a QuPath project, each image is a project entry with a `serverBuilder` naming the reading library (OpenSlide, Bio-Formats) plus a URI. — [QuPath project structure](https://qupath.readthedocs.io/en/stable/docs/reference/projects%5Fstructure.html)
- Cytomine keeps uploads in a per-user **storage**. Deployed images can be linked to one or several projects "without uploading them again". — [Cytomine Upload & Storage](https://doc.cytomine.com/user-guide/storage)
- Orthanc Education plugin: "the whole-slide imaging viewer only works at the instance or series level". A WSI must be added to a project as a series, not as a study. — [Orthanc Education plugin](https://orthanc.uclouvain.be/book/plugins/education.html)

**Waveforms**
- PhysioNet LightWAVE is organised by database → record. The record opens in a View/edit panel with signals and annotation sets. Its parts are a C CGI back end, a JS front end, and a Perl "scribe" that writes annotation files. — [About LightWAVE](https://physionet.org/static/lightwave/doc/about.html); [LightWAVE paper (2013, old)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4627786/)

### Inferences
- The industry has converged on **one container (study, case, item or Data Group) holding several typed members, with the renderer chosen per member**. It has not converged on a separate editor product per modality. Even Encord and V7, which began with per-type editors, now place mixed types side by side in one task.
- The hierarchy has to be first-class, and modality is metadata on the leaf (series or acquisition), not on the project. Flywheel, XNAT and MD.ai treat it this way, and the OHIF v3.13 per-data-type render paths match the "same repository, renderer per file" model.
- Pathology diverges because a slide is a single huge image. The useful grouping is case → slides (plus reports), and the viewer is the same tiled renderer for every member.

### Gaps
- No public data-model docs were found for Lunit (INSIGHT products are inference products, not labelling tools), Gradient Health's internal platform, or Centaur's portal hierarchy beyond "cases" and "reads".
- PathAI AISight and Proscia do not document their internal case/slide/report schema publicly beyond the FDA summaries.

## 2. Can one labelling project mix modalities, and when platforms split by modality, why?

### Takeaway
Most platforms **allow** mixed modalities in one project at the storage level. The split, where it happens, comes from the **editor and ontology layer**: a different editor per file type, tools that exist in only one editor, or a hanging protocol that assumes certain series. Stated reasons for splitting are mostly practical (viewer support, regulatory clearance scope, reader specialisation in pathology). None of the docs gives a principled "one modality per project" rule.

### Cited Findings
- **MD.ai** supports DICOM modalities from CR/DX/CT/MR/MG/US/XA/ES (endoscopy)/OP/OCT and more, plus images and videos, all in project datasets. Several datasets per project are common, e.g. to separate training and test sets. — [MD.ai Create Dataset](https://docs.md.ai/annotator/datasets/create-dataset/)
- **MD.ai** project *types* (Regular, Anonymized, Education, Crowdsourcing) are fixed once the project has data: "Project type can only be changed for empty projects". This split is about workflow and privacy, not modality. — [MD.ai Create Project](https://docs.md.ai/annotator/projects/create-project/)
- **Flywheel** says "Multiple protocols can be defined in a single project and utilized in parallel workflows without the need to copy data to new projects." — [Flywheel Tasks](https://docs.flywheel.io/user/workflow/tasks/user_introduction_to_read_tasks/)
- **Flywheel** gears declare the file classifications they accept, and "If a gear job is submitted for a file whose classification does not match… the job fails with a descriptive warning message". Classification is per file, so mixed modalities coexist and routing happens by classification. — [Flywheel Data Classification](https://docs.flywheel.io/user/enhance/user_data_classification/)
- **Flywheel's** viewer split is by format, not modality. V3 (OHIF v3, Cornerstone3D, 21 CFR Part 11 compliant) supports **DICOM only**. Legacy V2 handles DICOM, NIfTI, TIFF, PNG, JPEG and MHD/RAW and "remains available for workflows that require non-DICOM image formats". — [Flywheel Viewer Overview](https://docs.flywheel.io/user/viewer/)
- **Ango Hub** routes `.dcm` to the DICOM editor and `.nrrd/.nii/.nii.gz` to the Medical editor, and the tool sets differ (only the Medical editor has Rotated Box and Cobb Angle). Neither the docs nor the search synthesis says a project is limited to one asset type. — [Ango DICOM editor](https://docs.imerit.net/labeling/labeling-editor-interface/dicom-labeling-editor); [Ango Medical editor](https://docs.imerit.net/labeling/labeling-editor-interface/medical-labeling-editor); [Ango supported types](https://docs.imerit.net/data/data-in-ango-hub/supported-asset-file-types)
- **Encord** accepts many data types in one registration JSON ("You can add one data type at a time, or combine multiple data types in one JSON"). Projects take datasets, and Data Groups combine DICOM series, CSV time series, video, PDF and text in one task. — [Encord registration](https://docs.encord.com/platform-documentation/Curate/add-files/index-register-cloud-data); [Encord Data Groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups)
- **Encord** limitation: "Determine Consensus nodes are not yet supported" for Data Groups. — [Encord Data Groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups)
- **V7** lets one item mix image, video, PDF and DICOM in separate slots. — [V7 registration](https://docs.v7labs.com/docs/registering-items-from-external-storage)
- **RedBrick** accepts DICOM, NIfTI, video (mp4/mov/avi), RGB images and NRRD. A task can mix 2D images and video series (`is2DImage`, `isVideo` flags in the hanging protocol input). — [RedBrick import](https://docs.redbrickai.com/importing-data/import-cloud-data); [RedBrick Hanging Protocol](https://app.redbrickai.com/docs/project-pages/settings-page/custom-hanging-protocol)
- **XNAT** separates by session modality type (MR Session, CT Session…), but a project holds any number of session types plus non-imaging resources. — [XNAT data model](https://wiki.xnat.org/documentation/understanding-the-xnat-data-model)
- **Regulatory scope (pathology)**: FDA-cleared viewers are cleared for specific scanner + file format + display combinations. AISight Dx lists Aperio GT 450 DX (SVS, DICOM) and NanoZoomer S360MD (NDPI). Concentriq AP-Dx lists SVS and NDPI. Both add formats via a Predetermined Change Control Plan (PCCP). — [AISight Dx K243391](https://fda.innolitics.com/submissions/PA/subpart-d%E2%80%94pathology-instrumentation-and-accessories/QKQ/K243391); [Concentriq K261380](https://www.accessdata.fda.gov/cdrh_docs/reviews/K261380.pdf)
- Concentriq ships separate products for clinical (AP) and life sciences (LS). — [Proscia Concentriq AP release](https://tissuepathology.com/2026/02/12/proscia-new-in-concentriq-ap-smoother-review-and-enhanced-performance/); [Concentriq LS release](https://tissuepathology.com/2026/01/15/proscia-new-in-concentriq-ls-strengthening-review-integrity-and-speed/)
- **Reader expertise / crowd**: Centaur Labs runs a gamified mobile app (DiagnosUs) for many medically trained labelers and aggregates many reads per case. It markets waveform (ECG/EEG/PPG), video and DICOM labelling as separate "data type" offerings. — [DiagnosUs](https://docs.centaurlabs.com/docs/diagnosus-labeling); [Centaur waveform](https://centaur.ai/data-type/datatype-waveform); [Centaur video](https://centaur.ai/data-type/datatype-video); [Centaur DICOM viewer](https://docs.centaurlabs.com/docs/centaur-dicom-viewer-101)

### Inferences
- Where splits exist, they follow (a) **the editor that can render the file**, as with Flywheel V2/V3 and Ango's DICOM/Medical editors, (b) **regulatory clearance scope** in clinical pathology, (c) **ontology and reader specialty**, since a cardiologist labelling ECGs and a radiologist labelling CT use different label sets and queues, and (d) **QA features that don't span types yet** (Encord consensus on Data Groups).
- None of these needs a separate project per data type. All of them are satisfied by per-protocol or per-task ontology, reader assignment and renderer selection inside one project. Flywheel's "multiple protocols per project, no data copying" is the clearest statement of this.
- The pattern where a product hard-splits is a *legacy viewer* that can't render a format. That is an implementation limitation, not a design goal.

### Gaps
- No vendor doc gives an explicit rationale such as "we require one modality per project because…". The reasons above are inferred from feature constraints.
- No source found for Aiforia's or HALO's project-level modality rules. Both are pathology-only, so the question mostly doesn't arise there.

## 3. Ingestion and conversion: who tiles, transcodes and parses, when, and how is progress reported?

### Takeaway
Three patterns exist:
- **Eager background conversion on upload** with a visible status machine: Cytomine, Aiforia, V7, Ango, the large_image/DSA conversion job, MD.ai's processing, Flywheel gear rules.
- **No server conversion; the browser parses the raw file**: RedBrick, VolView, Encord DICOM/NIfTI, OHIF via DICOMweb.
- **Lazy, on first open**: RedBrick's study auto-split.

WSI tiling is almost always OpenSlide and/or Bio-Formats/libvips. Video is normalised to H.264 MP4 at a constant frame rate. ECG and waveforms are mostly *not* parsed natively from WFDB/EDF by labelling vendors: Encord takes CSV, OHIF takes DICOM waveform.

### Cited Findings

**Whole-slide images**
- **large_image / DSA (Kitware)**: `createImageItem` runs a Girder job titled "Large Image Conversion: <file>", either on girder_worker (`create_tiff` task) or as a local job. It writes the output back to the item or folder. — [girder_large_image image_item source](https://girder.github.io/large_image/_modules/girder_large_image/models/image_item.html)
- The `create_tiff` task takes "a source input file, readable by vips, and output[s] a pyramidal tiff" with configurable tile size (256), JPEG quality (90) and compression (jpeg/deflate/lzw/zstd…). — [large_image_tasks source](https://girder.github.io/large_image/_modules/large_image_tasks/tasks.html)
- large-image-converter writes geospatial inputs to COG via gdal_translate, single-image inputs to pyramidal TIFF via pyvips, and multi-image inputs to multi-pyramid TIFF. — [large-image-converter PyPI](https://pypi.org/project/large-image-converter/); [Image Conversion docs](https://girder.github.io/large_image/image_conversion.html)
- large_image reads many formats *directly* through pluggable tile sources (openslide, bioformats, dicom, vips, tiff, tifffile, ometiff, zarr, nd2, openjpeg, gdal…). Conversion is only needed for inputs no source reads efficiently. — [large_image index](https://girder.github.io/large_image/); [formats table](https://girder.github.io/large_image/formats.html)
- **Cytomine (PIMS)**: native formats are served directly. Otherwise "Cytomine tries to convert the image to a natively supported format". Format detection "is not based on the file extension". MRXS and VMS must be uploaded as ZIP. — [Cytomine Upload & Storage](https://doc.cytomine.com/user-guide/storage)
- Cytomine statuses: UPLOADED → DETECTING FORMAT → EXTRACTING DATA → CONVERTING → DEPLOYING → DEPLOYED/CONVERTED/EXTRACTED, or ERROR FORMAT/EXTRACTION/CONVERSION/DEPLOYMENT. — [Cytomine Upload & Storage](https://doc.cytomine.com/user-guide/storage)
- Cytomine CE2025.1 "Remove[d] Bioformat plugin: no more conversion of images after upload". A CZI plugin was re-integrated in Sept 2025 after the code was merged into a single cytomine/cytomine repo. — [Cytomine releases](https://github.com/cytomine/Cytomine-community-edition/releases); [image.sc thread, Sept 2025](https://forum.image.sc/t/inquiry-on-czi-image-support-in-cytomine/116616)
- **Aiforia**: chunked upload, where "The final chunk triggers automatic image conversion". The client polls `GET /v2/upload/chunked/{uploadId}` for a ConversionStatus enum (1 Initializing, 2 Uploading, 3 Uploaded, 4 StartProcessing, 5 Processing, 9 Done, 10 Error) or subscribes to an `upload_complete` webhook. — [Aiforia Scanner Integration](https://cloud.aiforia.com/api/docs/integrations/scanner-integration); [Aiforia IMS Integration](https://cloud.aiforia.com/api/docs/integrations/ims-integration)
- Aiforia accepts about 50 extensions (svs, ndpi, scn, bif, czi, qptiff, isyntax, mrxs-as-`.3dhistech`, vsi-as-`.vsizip`, `.multidcm`…). DICOM WSI support is "Experimental". A desktop **Aiforia Connector** packages native multi-file formats and handles files over 5 GB with resume. — [Aiforia Supported File Formats](https://cloud.aiforia.com/api/docs/supported-file-formats)
- **V7**: the upload flow is register → sign → PUT to S3 → confirm. Confirm "enable[s] Darwin to pre-process… thumbnail generation, metadata extraction, and splitting a video into frames". V7 auto-builds pyramidal tiles for any image over 10,000 px, with a max of 65,535 px per side and 268 Mpx area. SVS and NDPI are listed as supported. — [V7 HTTP import](https://docs.v7labs.com/docs/import-image-or-video-data); [V7 supported formats](https://docs.v7labs.com/docs/supported-file-formats)
- **Orthanc WSI**: `OrthancWSIDicomizer` converts to DICOM Supplement 145. Tiled TIFF is transcoded without re-encoding JPEG tiles ("fast"). Proprietary formats (SVS, NDPI, MRXS) need the OpenSlide shared library, which "implies the re-encoding… much more time-consuming". — [Orthanc Book WSI](https://orthanc.uclouvain.be/book/plugins/wsi.html)
- OpenSlide must be forced with `--force-openslide=1`, otherwise pixel spacing can be wrong. v3.1 reads Aperio dimensions natively. — [Orthanc forum, 2025](https://discourse.orthanc-server.org/t/issue-with-image-dimensions-after-svs-dicom-conversion-using-orthancwsidicomizer/5585)
- Orthanc's web viewer transcodes JPEG 2000 tiles to PNG on the fly for browsers. — [Orthanc Book WSI](https://orthanc.uclouvain.be/book/plugins/wsi.html)
- The Orthanc Education plugin runs the Dicomizer from its admin UI. An "Upload status" page shows "the status of the DICOM-ization, including the logs of the command-line tool". — [Orthanc Education plugin](https://orthanc.uclouvain.be/book/plugins/education.html)
- **QuPath** does no conversion. It reads in place through OpenSlide (fast, 2D 8-bit RGB only) or Bio-Formats (multidimensional). iSyntax is unsupported, MRXS only partially works, and DICOM WSI is supported via Bio-Formats 6.8 (QuPath 0.4) and OpenSlide 4.0 (QuPath 0.5). — [QuPath formats](https://qupath.readthedocs.io/en/stable/docs/intro/formats.html)
- **HALO / HALO Link** list SVS, NDPI/NDPIS, MRXS, CZI, VSI, BIF, iSyntax/i2Syntax, KFB, QPTIFF, ND2, LIF/SCN, OME-TIFF and DICOM WSI. No conversion pipeline is documented publicly. — [HALO supported formats](https://indicalab.com/uncategorized/halo-supported-file-formats/)
- **Proscia Concentriq**: "45+ scanners and every major format including DICOM". The 2026 releases added Roche `.bif` and "re-ingest failed images directly from the Image Management worklist". At the 2025 DICOM WSI Connectathon, Concentriq received from 8 scanners via C-STORE/STOW and served 10 viewers. — [Proscia platform](https://proscia.com/platform/concentriq-digital-pathology-platform); [Concentriq AP Feb 2026](https://tissuepathology.com/2026/02/12/proscia-new-in-concentriq-ap-smoother-review-and-enhanced-performance/); [Proscia Connectathon](https://proscia.com/blog/proscia-demonstrates-seamless-interoperability-at-the-2025-dicom-wsi-connectathon)
- **PathAI AISight** v2.10 added MRXS and OptraScan TIF upload, with "AI support for MRXS… coming in a future release". Ingestion is "bulk… automatic slide upload" or manual. — [AISight 2.10](https://www.pathai.com/resources/aisight-version-2-10); [AISight Dx K243391](https://fda.innolitics.com/submissions/PA/subpart-d%E2%80%94pathology-instrumentation-and-accessories/QKQ/K243391)

**DICOM, NIfTI and volumes**
- **Flywheel** handles conversion as **gears** chained by **Gear Rules** on upload. File Metadata Importer extracts the DICOM header into `file.info.header.dicom`, File Classifier assigns the classification, and the `dcm2niix` gear converts DICOM (zip) or PAR/REC to NIfTI or NRRD plus a BIDS JSON sidecar, with optional PyDeface. — [Flywheel best practices](https://docs.flywheel.io/user/compute/gears/best-practices/user_best_practices_classifying/); [flywheel-apps/dcm2niix](https://github.com/flywheel-apps/dcm2niix)
- If the NIfTI sidecar is missing, the classifier "waits and retries… about 30 seconds before failing with 'Could not find NIfTI sidecar.'" — [File Classifier usage](https://flywheel-io.gitlab.io/scientific-solutions/gears/file-classifier/main/usages/)
- **RedBrick** streams raw files from the customer's bucket to the browser: "Your raw data will never be routed through RedBrick AI's servers". The study auto-split parses DICOM client-side on first open. — [RedBrick import](https://docs.redbrickai.com/importing-data/import-cloud-data); [RedBrick Items List](https://app.redbrickai.com/docs/importing-data/import-cloud-data/creating-an-items-list)
- RedBrick stores annotations in NIfTI by default. — [RedBrick Settings](https://app.redbrickai.com/docs/project-pages/settings-page/home)
- **Encord** requires the DICOM tags Rows, Columns, StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID and PatientID. 3D rendering additionally needs ImagePositionPatient, ImageOrientationPatient, SliceThickness and PixelSpacing. — [Encord Local Data](https://docs.encord.com/platform-documentation/Curate/add-files/index-upload-local-data)
- Encord: "Metadata is not supported for NIfTI." — [Encord DICOM/NIfTI](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-dicom)
- **V7** recommends zipping a series and renaming it to `.dcm`; otherwise "each slice will be uploaded as an individual image". Multi-planar view is chosen at import. Slice order follows SeriesNumber > InstanceNumber > SliceLocation > ImagePositionPatient > FileName, overridable with `ignore_dicom_layout`. — [V7 DICOM/NIfTI](https://docs.v7labs.com/docs/annotate-dicom-nifti-files); [V7 registration](https://docs.v7labs.com/docs/registering-items-from-external-storage)
- **Ango Hub** can convert grouped single-frame 2D DICOMs into one NRRD "During upload". — [Ango DICOM→NRRD](https://docs.imerit.net/data/importing-assets/bundled-assets/importing-multiple-single-frame-dicom-files-as-a-3d-dicom-series)
- **VolView** does zero server conversion. DICOM, NIfTI, NRRD, MHA and 20+ formats are parsed in-browser with ITK-WASM and rendered with VTK.js. The docs warn that "the orientation of the data in those files cannot be assured" for non-DICOM. Recent releases added incremental and streaming volume loading and automatic layering of non-DICOM images that share a filename prefix. — [VolView Loading Data](https://kitware.github.io/VolView/loading_data.html); [VolView releases](https://github.com/Kitware/VolView/releases); [Kitware Clara blog](https://www.kitware.com/integrating-nvidia-clara-models-into-volview-a-technical-deep-dive/)

**Video, endoscopy and cine**
- **Encord** supports H.264/H.265/AV1/VP8/VP9 in mp4/mov/webm/mkv. The limit is under 1 GB or 200,000 frames. Encord "automatically checks all uploaded videos for re-encoding" and shows a red badge with the issue count. In-platform re-encoding is Enterprise-only, as "Re-encode (Full)". The local recipe is `ffmpeg … -r 30 -c:v libx264 -movflags faststart -an`, because "browsers require a constant frame rate". — [Encord Supported Data](https://docs.encord.com/platform-documentation/General/general-supported-data); [Encord Re-encoding](https://docs.encord.com/platform-documentation/Curate/files/files-re-encoding)
- Encord's engineering blog explains the choice of CFR re-encode (`-vsync cfr`) over a frame→timestamp map, accepting duplicated or dropped frames. — [Encord blog (undated, likely 2022–23)](https://encord.com/blog/video-annotation-issues/)
- **MD.ai** wraps videos as virtual DICOM, and "the frame rate can be adjusted during processing". — [MD.ai Create Dataset](https://docs.md.ai/annotator/datasets/create-dataset/)
- **V7** splits video into frames during pre-processing. — [V7 HTTP import](https://docs.v7labs.com/docs/import-image-or-video-data)
- **Ango Hub** recommends H.264 MP4 and requires a constant bitrate. Frame-specific annotations are "not officially supported on videos with variable frame rate". — [Ango supported types](https://docs.imerit.net/data/data-in-ango-hub/supported-asset-file-types)
- **dcm4che/dcm4chee** wraps non-DICOM rather than transcoding it. `stowrs` and `jpg2dcm` encapsulate MP4, MPEG2 and QuickTime as Video Photographic Image Storage, PDF/CDA/STL/OBJ as Encapsulated documents, and JPEG/PNG as VL Photographic or Secondary Capture, generating the metadata. — [dcm4che stowrs README](https://github.com/dcm4che/dcm4che/blob/master/dcm4che-tool/dcm4che-tool-stowrs/README.md); [jpg2dcm README](https://github.com/dcm4che/dcm4che/blob/master/dcm4che-tool/dcm4che-tool-jpg2dcm/README.md); [DeepWiki summary (secondary)](https://deepwiki.com/dcm4che/dcm4che/6.1-stow-rs-implementation)
- The DICOMweb STOW-RS spec marks `video/mp4` as "Unchanged" and `image/png` and `image/gif` as "Transform". — [DICOM PS3.18 §6.6 (2018d edition, old)](https://dicom.nema.org/medical/Dicom/2018d/output/chtml/part18/sect_6.6.html)

**ECG and waveforms (WFDB, EDF)**
- **OHIF** v3.13 added a DICOM ECG waveform extension and viewport. Input is DICOM waveform objects, not WFDB or EDF. — [OHIF v3.13](https://ohif.org/release-notes/3p13/)
- An earlier community thread shows people wiring a custom ECG mode with its own `sopClassHandler`. — [OHIF forum](https://community.ohif.org/t/how-to-implement-ecg-viewer-hanging-protocol-not-matched/1112)
- **Encord** time series accepts **CSV** only (`text/csv`). "The Label Editor parses the timestamp and channel columns when the file is opened", which is lazy, client-side parsing. To align with video, the docs say to index by a `frame` column. — [Encord registration](https://docs.encord.com/platform-documentation/Curate/add-files/index-register-cloud-data); [Encord multimodal labelling](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/multimodal-groups)
- **PhysioNet LightWAVE** reads WFDB records server-side through a C CGI. It shows the standard beat and rhythm annotation codes and saves edits to PhysioBank-compatible annotation files. The repo's last push was July 2023, so treat it as old. — [LightWAVE](https://physionet.org/lightwave/); [About](https://physionet.org/static/lightwave/doc/about.html); [GitHub](https://github.com/bemoody/lightwave)
- **Centaur** markets ECG, EEG and PPG labelling as feature classification plus time-range segmentation. Input formats are not documented publicly. — [Centaur waveform](https://centaur.ai/data-type/datatype-waveform)

### Inferences
- WSI: open-source stacks read natively when possible and run a **background job** only for formats they can't read. That is large_image's per-source design, Cytomine's "native vs convert", and QuPath's read-in-place. Commercial SaaS (Aiforia, V7) **always** converts on ingest into their own tiled store and exposes a status enum.
- Video: everyone converges on **H.264 MP4, constant frame rate, faststart**. Encord *detects* problems and offers re-encoding rather than silently transcoding everything.
- ECG: no vendor documented native WFDB `.hea/.dat/.mat` or EDF ingestion for labelling. The common routes are DICOM waveform (OHIF), CSV (Encord), or the WFDB server tool (LightWAVE). A product that accepts WFDB and EDF directly would need its own parser step, for example the Python `wfdb` or `pyedflib` packages. Those packages are not cited in the sources here.
- Progress reporting is consistently a **per-file state machine** visible in the file list (Cytomine statuses, Aiforia enum, Ango "Preprocess failed", Encord red badge, Orthanc upload status with logs), not a modal progress bar.

### Gaps
- No public docs on how MD.ai, Encord or RedBrick transcode or tile on their servers: which library, or eager vs lazy. RedBrick says data streams from the customer bucket, which implies no transcoding, but video handling isn't documented.
- Proscia, PathAI and HALO don't publish their tiling library or whether they convert to an internal format.
- No 2025–2026 source on `wsidicom` (the Python DICOM WSI library) adoption by these platforms. The Cytomine PIMS WSI-DICOM plugin exists but is in an archived repo.
- NIfTI → DICOM (e.g. for OHIF display) was not documented by any platform. Flywheel documents only DICOM → NIfTI (dcm2niix).

## 4. How are unsupported or partially supported files handled in a mixed upload?

### Takeaway
The dominant pattern is to **keep the file, mark it with a failed or needs-attention state, allow retry, and never block the rest of the batch**. Some platforms silently drop or reshape files that don't fit the expected structure, such as V7's `series` merge mode ignoring non-DICOM, or MD.ai turning unstructured files into one study each.

### Cited Findings
- **Cytomine** keeps "aborted image uploads due to conversion error, non-supported formats or any other unexpected error" in the storage list with an ERROR_* status. A file tree shows intermediate conversion files. — [Cytomine Upload & Storage](https://doc.cytomine.com/user-guide/storage)
- **Ango Hub**: if DICOM→NRRD conversion fails, "the asset will remain in the Assets tab with a Preprocess failed status… and no labeling task will be created for it". Transient failures get a retry icon and bulk "Retry Preprocess", and are retried automatically. Permanent errors (unsupported or invalid DICOM) have no retry action. — [Ango DICOM→NRRD](https://docs.imerit.net/data/importing-assets/bundled-assets/importing-multiple-single-frame-dicom-files-as-a-3d-dicom-series)
- Ango shows distinct errors for a corrupt `.nii.gz` and for an invalid NIfTI volume, with a "Go to the Assets" escape. — [Ango supported types](https://docs.imerit.net/data/data-in-ango-hub/supported-asset-file-types)
- **Encord** flags videos needing re-encode with a red badge and per-issue details. It suggests a local ffmpeg fix for corrupted metadata. — [Encord Supported Data](https://docs.encord.com/platform-documentation/General/general-supported-data)
- **Encord** registration supports `skip_duplicate_urls`. — [Encord registration](https://docs.encord.com/platform-documentation/Curate/add-files/index-register-cloud-data)
- **Aiforia** reports ConversionStatus 10 = "Error: Upload or conversion failed". — [Aiforia Scanner Integration](https://cloud.aiforia.com/api/docs/integrations/scanner-integration)
- **Proscia** re-ingests failed images from the Image Management worklist (2026). — [Concentriq AP Feb 2026](https://tissuepathology.com/2026/02/12/proscia-new-in-concentriq-ap-smoother-review-and-enhanced-performance/)
- **Flywheel** gear jobs fail with "a descriptive warning message" on classification mismatch. The classifier fails explicitly when the sidecar is missing. — [Flywheel classification](https://docs.flywheel.io/user/enhance/user_data_classification/); [File Classifier usage](https://flywheel-io.gitlab.io/scientific-solutions/gears/file-classifier/main/usages/)
- **V7** `push(item_merge_mode="series")`: "Other file types are ignored". — [V7 Upload files](https://docs.v7labs.com/docs/upload-images)
- **MD.ai**: without the study/series folder convention, "each image or video will be created as a separate study". It also offers "ignore secondary captures" at dataset creation, for burned-in PHI. — [MD.ai Create Dataset](https://docs.md.ai/annotator/datasets/create-dataset/)
- **QuPath** may "open a low-resolution thumbnail for an unsupported MRXS image, but… not the full data", which is a partially-supported state. — [QuPath formats](https://qupath.readthedocs.io/en/stable/docs/intro/formats.html)
- **VolView** "no longer reports failed to load LICENSE files during extraction" of ZIPs. It detects archives by magic bytes and has improved error messages for load failures. — [VolView releases](https://github.com/Kitware/VolView/releases)
- **XNAT**: files that don't fit the scan model go into **Resources** at project, subject or experiment level. They "are not searchable via the XNAT search tools". — [XNAT resource files](https://wiki.xnat.org/documentation/adding-or-removing-resource-files); [XNAT storage strategies](https://wiki.xnat.org/documentation/strategies-for-xnat-image-data-storage)

### Inferences
- A good pattern for a mixed drop is: store every file as-is, give each its own state (`stored`, `converting`, `ready`, `failed:<reason>`, `unsupported`), distinguish transient from permanent errors, offer retry for transient ones, and give unrenderable files a generic "attachment" representation (like XNAT Resources) rather than rejecting them.
- Detect format by content, not extension. Cytomine and VolView both do this explicitly.

### Gaps
- No platform documented a user-facing "needs conversion — choose a target" prompt. Conversions are either automatic or left to the user offline.

## 5. Packaging: are conversion tools inside the worker image or shipped as plugins/gears?

### Takeaway
Both patterns exist:
- **Plugin or container per converter**: Flywheel gears (one Docker image each), Cytomine PIMS format plugins, large_image tile-source packages, OHIF extensions per data type.
- **Fat worker image**: DSA/Girder worker with libvips and OpenSlide; Orthanc WSI needing the OpenSlide `.so` beside the binary.

Open-source projects deliberately make the heavy native libraries optional extras.

### Cited Findings
- **Flywheel**: conversion and classification are **gears** (e.g. `flywheel-apps/dcm2niix`, File Metadata Importer, File Classifier). Each declares accepted inputs in a manifest and is triggered by project **Gear Rules**. — [flywheel-apps/dcm2niix](https://github.com/flywheel-apps/dcm2niix); [Flywheel classification](https://docs.flywheel.io/user/enhance/user_data_classification/)
- **Cytomine PIMS** uses format plugins listed in `plugin-list.csv` with a **resolution order**. More conservative checkers run first, and native formats default to order 0. The OpenSlide plugin "Depends on VIPS and Openslide", and a WSI-DICOM plugin exists. The repo is archived, with code moved to cytomine/cytomine. — [cytomine/pims](https://github.com/cytomine/pims)
- **large_image** puts each format in a separate pip package (`large-image-source-openslide`, `-bioformats`, `-dicom`, `-vips`, …). `[common]` installs from PyPI on Linux, macOS and Windows "without other external libraries". `[all]` on Linux needs Kitware's prebuilt wheels index (`--find-links https://girder.github.io/large_image_wheels`) for native deps. — [large_image setup.py](https://github.com/girder/large_image/blob/master/setup.py); [Getting Started](https://girder.github.io/large_image/getting_started.html)
- **OpenSlide Python** now offers `pip install openslide-bin` for the native library. — [OpenSlide Python docs](https://openslide.org/api/python/)
- **Orthanc WSI** ships the Dicomizer as a separate CLI. The OpenSlide shared library is loaded at runtime via `--openslide=` (Debian package `libopenslide0`, or DLLs on Windows). The Education plugin is configured through the `WholeSlideImagingDicomizer` and `OpenSlideLibrary` options. — [Orthanc WSI](https://orthanc.uclouvain.be/book/plugins/wsi.html); [Orthanc Education](https://orthanc.uclouvain.be/book/plugins/education.html)
- **OHIF** adds data types as **extensions and modes**, each with its own SOP class handler and viewport (DICOM video, microscopy/WSI, ECG). — [OHIF Modes](https://docs.ohif.org/platform/modes/); [OHIF v3.13](https://ohif.org/release-notes/3p13/)
- **QuPath** bundles both OpenSlide and Bio-Formats, and extensions add image servers (e.g. OMERO, OME-Zarr). — [QuPath formats](https://qupath.readthedocs.io/en/stable/docs/intro/formats.html); [QuPath OMERO](https://qupath.readthedocs.io/en/latest/docs/advanced/omero.html); [qupath-extension-cloud-omezarr](https://github.com/dimi-lab/qupath-extension-cloud-omezarr)
- **VolView** ships parsers to the client as WebAssembly (ITK-WASM), with no server component needed for loading. — [Kitware Clara blog](https://www.kitware.com/integrating-nvidia-clara-models-into-volview-a-technical-deep-dive/); [ITK-WASM formats](https://docs.itk.org/projects/wasm/en/latest/introduction/file_formats/images.html)
- **Aiforia** puts a client-side helper, the "Aiforia Connector", at the edge to package multi-file formats before upload. — [Aiforia formats](https://cloud.aiforia.com/api/docs/supported-file-formats)

### Inferences
- A modular split fits a product with heterogeneous formats: a **detector/registry** that maps content to converter, plus **one worker image per heavy native dependency family**. The families would be OpenSlide/libvips for WSI, ffmpeg for video, dcm2niix/ITK for volumes, and wfdb/pyedflib for waveforms. This mirrors Flywheel gears and Cytomine PIMS plugins and avoids one huge image.
- Client-side parsing (ITK-WASM, cornerstone DICOM loaders, CSV time series) removes server conversion for small and medium volumes and waveforms. Server work stays necessary for WSI pyramids and video normalisation.

### Gaps
- Commercial SaaS vendors (Encord, V7, MD.ai, RedBrick, Proscia, PathAI, HALO) don't disclose their worker packaging.
- No source found on the current DSA docker-compose image contents (whether OpenSlide and libvips ship in the main image). The `girder/large_image_wheels` approach is the documented route.
