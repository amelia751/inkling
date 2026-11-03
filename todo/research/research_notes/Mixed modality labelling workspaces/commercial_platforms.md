# How commercial labelling platforms organise mixed data types (as of late 2026)

Scope: Labelbox, Encord, V7 Darwin / V7 Go, Scale AI (Nucleus / Rapid / Studio), SuperAnnotate, Kili Technology, Dataloop, Segments.ai, Labellerr, BasicAI, Supervisely. Sources are official docs, SDK references and release notes, fetched November 2026. Pages carry no dates unless a date is noted. Older material is flagged.

## 1. Containers: what is the top-level container, the data container and the work container, and where does media type live?

### Takeaway
Almost every platform types the **work container** (project/dataset-as-project) by media type. They differ on whether the **data container** is typed too. Only Encord, V7 and Dataloop leave the data container (or the item) untyped and pick the editor per asset.

| Platform | Top level | Data container | Work container | Where media type lives |
|---|---|---|---|---|
| Labelbox | Workspace | Catalog → Datasets → Data rows | Project (+ batches) | Project **and** ontology (both chosen at creation); data row media type optional / inferred |
| Encord | Workspace | Files/Folders ("Index"/Curate) → Datasets → data units | Annotate Project | Per data unit (file); Projects and Datasets not typed |
| V7 Darwin | Team | Dataset → items → slots | Workflow (1 dataset ↔ 1 workflow) | Per slot (file type) |
| Scale | Account | Nucleus Dataset (items **or** scenes) | Project (one task type) → batches → tasks | Project task type; Nucleus dataset fixed to items vs scenes |
| SuperAnnotate | Team | Project folders | Project | Project type (Vector / Video / Document / Multimodal) |
| Kili | Organization | Assets inside project | Project | Project `input_type`, immutable |
| Dataloop | Org → Project | Datasets (each with a Recipe) | Tasks / pipelines | Recipe is modality-typed; editor ("studio") picked per file type |
| Segments.ai | Org / user | Dataset = labelling unit | Dataset | Dataset `task_type` |
| Labellerr | Workspace / domain | Dataset (typed by file type) | Project (one data type) | Project and dataset |
| BasicAI | Team | Dataset (typed) | Task | Dataset type |
| Supervisely | Team → Workspace | Project → Datasets | Labeling jobs on a project | Project type, immutable |

### Cited Findings
**Labelbox**
- When you create a project you choose a "data modality or task type". After that, "you will only be able to attach data rows that match the data type you set here… you cannot select video as the data type upon project creation and then send image data rows to this project later." — [Labelbox: Create a project](https://docs.labelbox.com/docs/create-a-project)
- SDK: `client.create_dataset(name=...)` takes no media type. `client.create_project(name, media_type=lb.MediaType.Image)` and `client.create_ontology(..., media_type=lb.MediaType.Image)` both take one. Data rows go to projects as batches (`project.create_batch(global_keys=...)`). — [Labelbox Quick start](https://docs.labelbox.com/reference/quick-start)
- Ontologies are created with a media type: "Choose the type of data this ontology will be used for (e.g., Image, Video, Text). This is a critical step. The media type determines which annotation tools … will be available." — [Labelbox: Ontologies](https://docs.labelbox.com/horizon/guides/labelbox-ontology)
- One ontology can be shared across many projects. Instructions live with the ontology, not the project. — [Labelbox: Labeling instructions](https://docs.labelbox.com/docs/instructions-and-quizzes)
- On data rows, `media_type` is optional ("optional media type to provide better validation and error messaging"). — [Labelbox: Import video data](https://docs.labelbox.com/reference/import-video-data)
- Datasets live in Catalog, and data rows are identified by global keys unique to the workspace. — [Labelbox: Import and upload data](https://docs.labelbox.com/horizon/guides/data-setup)

**Encord**
- Hierarchy: files sit in Folders. "All files must be placed into folders and cannot be added to the top level." Files "can be added to one or multiple Datasets". — [Encord: Basics (Files)](https://docs.encord.com/platform-documentation/Curate/index-files)
- "Projects tie together Datasets, Ontologies, and labels." `create_project(project_title, dataset_hashes=[...], ontology_hash, workflow_template_hash)` takes no media type. — [Encord: Create a Project (SDK)](https://docs.encord.com/sdk-documentation/getting-started-sdk/sdk-get-started-project)
- "Datasets are composed of data units… a video, a single image, an image group, or a DICOM series." Datasets "can be reused across multiple Projects". — [Encord: Entities and Relationships](https://docs.encord.com/sdk-documentation/general-sdk/general-concepts-sdk)
- The ontology-creation steps (title, description, objects/classifications) include no media-type choice. — [Encord: End-to-End Walkthrough](https://docs.encord.com/solutions-documentation/applied-ai/end-to-end-walkthrough)

**V7 Darwin**
- In the SDK, a dataset can currently be part of only one workflow (`workflow_ids[0]`, with the code comment "currently we can only be part of one workflow"). — [darwin-py remote_dataset_v2 source](https://darwin-py-sdk.v7labs.com/_modules/darwin/dataset/remote_dataset_v2.html) (darwin-py 3.4.3; possibly outdated)
- An item's `type` (`image`, `video`, `pdf`, `dicom`) is set per item or per slot at registration, or inferred from the file extension. — [V7: Registering items from external storage](https://docs.v7labs.com/docs/registering-items-from-external-storage)

**Scale**
- "A project is tied to one specific annotation use case, which is associated with a task type… All tasks will share the same instructions and annotation rules." The taxonomy is defined at project level. — [Scale: Key concepts](https://scale.com/docs/key-concepts-and-definitions)
- In Nucleus, "Datasets can only accept one of DatasetItems or Scenes, never both. This behavior is set during Dataset creation with the `is_scene` flag." — [Nucleus SDK reference](https://docs.nucleus.scale.com/en/latest/api/nucleus/index.html)

**SuperAnnotate**
- `create_project(..., project_type)` accepts "'Vector', 'Video', 'Document', 'Multimodal'". `classes` are "Not allowed for 'Multimodal' projects", and `form` is "Required for Multimodal projects". — [SuperAnnotate SDK: Projects](https://superannotate.readthedocs.io/en/stable/api%5Freference/api%5Fproject.html)

**Kili**
- UI: "Asset type is a critical choice. You won't be able to change it later." Types: Image, Text, PDF, Geospatial, Audio, Video. — [Kili: Creating a new project](https://docs.kili-technology.com/docs/creating-a-new-project)
- In the SDK, `input_type` is one of `IMAGE, GEOSPATIAL, PDF, TEXT, VIDEO, LLM_RLHF, LLM_INSTR_FOLLOWING, LLM_STATIC, AUDIO`. The docstring still says "Currently, one of IMAGE, PDF, TEXT or VIDEO", so it lags the type signature. — [Kili Python SDK 26.1: Project](https://python-sdk-docs.kili-technology.com/26.1/sdk/project/)

**Dataloop**
- A Recipe (ontology, tools, labels, interface) is "required to process a specific data type". There are Project Recipes shared across datasets and Unique Recipes tied to one dataset. Recipe types: GenAI/Multimodal, Image, Video, Audio, Text & Documents. — [Dataloop: Recipes overview](https://docs.dataloop.ai/docs/recipes-overview)
- The default annotation studio is chosen by file type: Images → Image Studio, PDF → PDF Studio, Videos → Video Studio, Audio → Audio Studio, PCD/`dltype: PCDFrames` JSON → Lidar Studio, txt → Text Classification Studio, JSON `dltype: gis` → GIS Studio, and so on. — [Dataloop: Annotation studios](https://docs.dataloop.ai/docs/annotation-studios)

**Segments.ai**
- Creating a dataset requires `task_type` (e.g. `segmentation-bitmap`, `vector`, `bboxes`). — [Segments.ai API](https://docs.segments.ai/reference/api)
- Each task type maps to one sample type (image, image sequence, point cloud, point cloud sequence, multi-sensor sequence). — [Segments.ai: Task types](https://docs.segments.ai/reference/sample-and-label-types) (page marked "Last updated 2 years ago")

**Labellerr**
- "Only one data type can be selected per project" (Image, Video, Audio, Text, Document). — [Labellerr: Create project](https://docs.labellerr.com/getting-started/create-project)
- "Data is segregated based on file type." Workspace-level datasets "can be linked to any project in the workspace". — [Labellerr: Datasets](https://docs.labellerr.com/tutorials/datasets)

**BasicAI**
- Datasets are created with a type: LiDAR Fusion, Image, DICOM, Audio & Video, Text, Generative AI. — [BasicAI: Create datasets](https://docs.basic.ai/docs/create-dataset)

**Supervisely**
- "Each project can contain only one type of data." "Once the project is created, its type cannot be changed." — [Supervisely: Create project](https://docs.supervisely.com/data-organization/project-dataset/create)
- The `ProjectType` enum has `images, videos, volumes, point_clouds, point_cloud_episodes, meshes, audio`. — [Supervisely SDK source](https://supervisely.readthedocs.io/latest/_modules/supervisely/project/project_type.html)
- "You can't mix multiple content types in the same project, and this setting can't be changed later." — [Supervisely: How to import](https://docs.supervisely.com/getting-started/how-to-import)

### Inferences
- There are two families:
  - **Typed work container.** Labelbox, Scale, SuperAnnotate, Kili, Labellerr, Supervisely, Segments.ai and BasicAI. Media type is a creation-time, usually immutable, property of the project or dataset. It also selects the toolset and ontology vocabulary.
  - **Typed asset.** Encord, V7 and Dataloop. Media type belongs to the file or slot. Projects, datasets and workflows are type-agnostic, and the editor is chosen per item.
- Labelbox is a hybrid. Its catalog (data store) is untyped, but its projects and ontologies are typed.

### Gaps
- V7 Go is a separate generative-AI "agents" product. I found no docs describing it as a labelling workspace for CV/medical data, so it is not covered.
- Scale Studio's own project-creation parameters (beyond the general "project = one task type" concept) were not found in public docs.

## 2. Can one project hold images AND video AND DICOM AND text? If so, how is the editor chosen per item?

### Takeaway
Only **Encord** (one project over datasets of mixed data units, plus Data Groups) and **V7** (mixed datasets, multi-slot items) clearly support mixed modalities in one labelling project for classic CV/medical work. **Dataloop** mixes them at dataset level, with the studio chosen per file. Every other platform forbids it. The stated reason is that the toolset and ontology depend on the media type.

### Cited Findings
- **Labelbox: no.** Project data rows must match the project's media type ([Create a project](https://docs.labelbox.com/docs/create-a-project)). The ontology's media type "determines which annotation tools… will be available" ([Ontologies](https://docs.labelbox.com/horizon/guides/labelbox-ontology)). DICOM is no longer labellable at all: "On November 25th 2024, we sunsetted the DICOM editor… Labeling DICOM data is no longer supported in Labelbox" ([Release notes](https://docs.labelbox.com/horizon/release-notes)), "Due to a lack of usage" ([Deprecations](https://docs.labelbox.com/horizon/guides/deprecations)). Current import types: images (PNG/JPEG/BMP), video (MP4), text, conversational text, geospatial/simple tiled, audio, PDF, HTML ([Import and upload data](https://docs.labelbox.com/horizon/guides/data-setup)).
- **Encord: yes.** "All types of data (videos, images, image groups, image sequences, and DICOM)… are added to a Dataset in the same way" ([Encord: Curation, management, annotation](https://docs.encord.com/platform-documentation/Annotate/annotate-gettingstarted/curation-management-annotation)). An official end-to-end example imports "a mixture of images and videos" into one dataset and project, noting "The Ontology is the same for ALL tasks. The Workflow varies depending on the task" ([Encord: Import local images and videos](https://docs.encord.com/end-to-end/Modalities/images-videos/data-import-basic-local-images-videos)). Supported data-unit types include point cloud, time series (.csv), image, image group, image sequence, video, audio, PDF, text (html/json/xml/txt), DICOM and NIfTI ([Encord: Supported data](https://docs.encord.com/platform-documentation/General/general-supported-data)). The editor follows the data unit's type: DICOM/NIfTI open in the DICOM editor ([Encord: DICOM and NIfTI](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-dicom)).
- **V7: yes, at dataset and item level.** The registration API takes `type: image | video | pdf | dicom` per item, inferred from the extension when omitted. "It's possible to register different filetypes in different slots within the same dataset item" ([V7: Registering items](https://docs.v7labs.com/docs/registering-items-from-external-storage)). Supported files include jpg/png/webp/bmp, pdf, mp4/mov/mkv/hevc/avi, svs/ndpi (pathology), tif/tiff, dcm, rvg (dental), nii/nii.gz and zip-of-dcm ([V7: Supported file formats](https://docs.v7labs.com/docs/supported-file-formats)).
- **Dataloop: mixed datasets are possible, and the studio is chosen per file type** (table in [Annotation studios](https://docs.dataloop.ai/docs/annotation-studios)). But recipes, which hold the ontology and tools, are modality-typed ([Recipes overview](https://docs.dataloop.ai/docs/recipes-overview)). The GenAI Evaluation Studio supports "Per-Item Layouts for varied formats" and evaluates "text, images, audio, video, and mixed formats in a single interface" ([Dataloop: GenAI evaluation](https://docs.dataloop.ai/docs/gen-ai-eval-overview)). The tool-availability matrix shows tools are per studio, e.g. 3D cuboid only in LiDAR and bounding box not in Audio/Text ([Annotation studio basics](https://docs.dataloop.ai/docs/annotation-studio-basics)).
- **SuperAnnotate: no for CV.** The project type fixes the editor. The "Multimodal" type is a form builder for LLM/GenAI tasks ("SFT, RLHF, Multimodal LLMs, Agents"); classes are not allowed and items are generated from the form or a CSV ([SuperAnnotate: Multimodal](https://doc.superannotate.com/docs/getting-started-multimodal); [SDK](https://superannotate.readthedocs.io/en/stable/api%5Freference/api%5Fproject.html)). The name means mixed content in a form, not one CV project holding images, video and DICOM.
- **Kili: no.** Asset type is fixed at project creation ([Kili](https://docs.kili-technology.com/docs/creating-a-new-project)).
- **Scale: no.** One project = one task type ([Scale key concepts](https://scale.com/docs/key-concepts-and-definitions)). Nucleus can send slices only to "General Image Annotation, General Video Annotation, and Lidar Cuboid Annotation projects" ([Nucleus: Send to labeling](https://nucleus.scale.com/docs/send-to-labeling)).
- **Supervisely: no.** One type per project, immutable ([Supervisely: Create](https://docs.supervisely.com/data-organization/project-dataset/create)).
- **Labellerr: no.** "Only one data type can be selected per project" ([Labellerr](https://docs.labellerr.com/getting-started/create-project)). The FAQ says the platform "will load the relevant annotation tools and templates automatically" based on the chosen type ([Labellerr FAQ](https://www.labellerr.com/faq)).
- **BasicAI: no.** Typed datasets ([BasicAI](https://docs.basic.ai/docs/create-dataset)). One crossover: "Video can be extract frame in image dataset and then be treated as a Scene for tracking tasks. If you are going to create Clip type annotations, please use our Audio and Video datatype."
- **Segments.ai: no**, except for multi-sensor sequences (see Q4). Dataset `task_type` is required ([API](https://docs.segments.ai/reference/api)).

### Inferences
- The recurring reason for single-type projects is that the **toolset and ontology vocabulary depend on the media type**, as Labelbox's ontology doc states explicitly and Dataloop's per-studio tool matrix shows.
- Encord's mixed approach shares one ontology across types and lets each editor ignore tools it can't use. Labelbox instead types the ontology.
- Neither Labelbox nor Supervisely documents QA/metrics reasons (e.g. per-frame vs per-image throughput metrics). I found no explicit vendor rationale beyond tooling.

### Gaps
- No vendor states why it chose single-type projects beyond "the media type determines tools". There is no design blog explaining the trade-off.
- Encord docs don't say what happens when an ontology tool can't apply to a data unit, e.g. a polygon class on an audio file in a mixed project.

## 3. Catalog vs labelling project: is there a separate "all data" catalog, and how does a mixed upload become labelling work?

### Takeaway
Labelbox (Catalog), Encord (Files/Folders + Explorer, "Index"/Curate) and Scale (Nucleus) separate the data store from labelling projects, which pull curated subsets. V7, Supervisely, Kili, SuperAnnotate, Segments.ai and Labellerr mostly upload straight into the work container. Dataloop and Labellerr sit in between, with datasets that can be linked to several projects.

### Cited Findings
- **Labelbox**: datasets live in Catalog. In a project you click Add data, "filter and search your data rows to curate a batch… then click Queue batch". So the catalog is shared and projects take type-matching subsets as batches. — [Create a project](https://docs.labelbox.com/docs/create-a-project); [Import and upload data](https://docs.labelbox.com/horizon/guides/data-setup)
- **Encord**: upload to Folders, then Data > Explore to filter by data type, metadata, quality metrics and embeddings. Save a Collection, create a Dataset from it, and attach the Dataset to a Project. — [Encord end-to-end walkthrough](https://docs.encord.com/solutions-documentation/applied-ai/end-to-end-walkthrough); [Encord curation](https://docs.encord.com/platform-documentation/Annotate/annotate-gettingstarted/curation-management-annotation)
- Encord also has "mirrored Datasets", which skip curation and sync all data into the project automatically. — [Encord: Import local images and videos](https://docs.encord.com/end-to-end/Modalities/images-videos/data-import-basic-local-images-videos)
- Encord Explorer filters include "Data Types… images, image sequences, image groups, and videos" and MIME type. — [Encord: Curate & explore](https://docs.encord.com/platform-documentation/Curate/index-video)
- **Scale**: a Nucleus Dataset → Slice → `slice.send_to_labeling(project_id)`. Each scene becomes one task. Results flow back to Nucleus, and existing projects can be ingested with `create_dataset_from_project` / `ingest_tasks`. — [Nucleus: Send to labeling](https://nucleus.scale.com/docs/send-to-labeling); [Nucleus: Ingest from labeling](https://nucleus.scale.com/docs/ingest-from-labeling)
- **Labellerr**: workspace-level datasets "can be linked to any project in the workspace", but each dataset is one file type. — [Labellerr: Datasets](https://docs.labellerr.com/tutorials/datasets)
- **Dataloop**: datasets get a recipe at creation ("Select a recipe based on your data type"). — [Dataloop: Create datasets](https://docs.dataloop.ai/docs/create-datasets)
- **Supervisely**: at import you pick the project type. An agent runs an "Auto Import" app in Docker that converts files and creates the project. — [Supervisely: How to import](https://docs.supervisely.com/getting-started/how-to-import)
- **V7**: `dataset.push` uploads into a dataset, which is then attached to a workflow. — [V7: Upload files](https://docs.v7labs.com/docs/upload-images); [V7 Academy: Data upload](https://www.v7darwin.com/academy/data-upload)

### Inferences
- On typed-project platforms (Labelbox), the catalog is the only place a mixed upload can live. Turning it into work means filtering by media type into one project per type.
- On Encord, a mixed folder can go into one dataset and one project, with no split per type.

### Gaps
- None of the docs I found give an explicit "upload a mixed folder → auto-split into per-type projects" wizard on any typed-project platform.

## 4. Grouped / multi-file items (patient with MRI + ECG + report, video with sidecars, image + mask pairs)

### Takeaway
Grouping is where the platforms converge on per-asset renderers. Encord **Data Groups** (GA 2026) group any mix of image, video, audio, text, PDF and DICOM into one task with a tiled layout. V7 **slots** put different file types in one item. Segments.ai **multi-sensor sequences** and BasicAI **LiDAR Fusion** group sensors. Supervisely and Scale only group within one type. Labelbox has read-only **attachments** rather than labellable groups.

### Cited Findings
- **Encord Data Groups**: "Data Groups can include any data type (images, videos, audio files, text files, PDFs, DICOM series) AND… support default and custom layouts". Layouts are grid, carousel or custom, limited to 50 data units. Groups can be created manually in Files or via the SDK, then added to Datasets and Projects. DICOM study-level annotation works by grouping the series of a study into one Data Group. — [Encord: Set up multimodal groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups)
- Custom layouts are a tree of row/column splits with `splitPercentage`, mapping keys to data-unit UUIDs. "Multi-Layer Data Groups" share one label layer across images, but "support images only" with equal aspect ratios. — [Encord SDK: Data Groups](https://docs.encord.com/sdk-documentation/index-sdk/sdk-data-groups)
- In the editor: synchronised zoom/pan across image and video tiles ("Tiles with 3D scenes or other non-2D content are not affected"), cross-tile object instantiation with a single synchronised timeline, and per-tile review. — [Encord: Label multi-modal groups](https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/multimodal-groups)
- Timeline: Data Groups went to general release in 2026 ("label multiple files as a single task… cross-tile instances… global classifications"). **Auto Data Groups** became generally available on April 24, 2026; they group files by keys when you select a source folder, "without requiring SDK scripts". — [Encord 2026 release notes](https://docs.encord.com/release-notes/releasenotes-2026). Auto Data Groups run as new data lands in cloud-synced folders; existing groups are untouched. — [Encord Data Groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups)
- Data Groups are not supported in Consensus "Determine" nodes yet. — [Encord Data Groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups)
- **V7 slots**: "If you need to display multiple files next to each other simultaneously, you'll need to register them in different slots." Different file types can share an item, but "Only DICOM (.dcm) slices can be registered within the same slot_name". — [V7: Registering items](https://docs.v7labs.com/docs/registering-items-from-external-storage). `dataset.push(item_merge_mode="slots" | "channels" | "series")` turns a directory into one multi-slot, multi-channel or DICOM-series item. — [V7: Upload files](https://docs.v7labs.com/docs/upload-images)
- **Segments.ai**: a `multisensor-sequence` sample is a list of sensors, each with its own `name`, `task_type` and attributes (point cloud sequence or image sequence). Labels can carry cross-sensor `links`. — [Segments.ai: Sample formats](https://docs.segments.ai/reference/sample-types); [Label formats](https://docs.segments.ai/reference/label-types)
- **BasicAI LiDAR Fusion**: point cloud + camera images + calibration as one item. Attributes are split into General, LiDAR-only and Image-only (per camera view). — [BasicAI: Attributes](https://docs.basic.ai/docs/attribute-classification); [BasicAI: LiDAR tool](https://docs.basic.ai/docs/lidar-fusion-tool). Its open-source sibling Xtreme1 requires a folder convention (`lidar_point_cloud_0`, `camera_image_N`, `camera_config`, `scene_N`) with identical filenames across folders. — [Xtreme1: Upload dataset](https://docs.xtreme1.io/xtreme1-docs/product-guides/upload-dataset)
- **Supervisely**: multiview stays within one type. In Videos projects, "All videos within one dataset form a synchronized multiview group" with shared object IDs. Ordering comes from `videoStreamIndex` in `<file>.meta.json` sidecars — [Supervisely: Multiview videos](https://docs.supervisely.com/labeling/labeling-toolbox/multi-view-videos). In Images projects, groups are images tagged with a `multiview` tag whose value is the folder name — [Supervisely: Multiview images](https://docs.supervisely.com/import-and-export/import/supported-annotation-formats/images/multiview). On import, DICOM metadata (StudyInstanceUID, SeriesInstanceUID, Modality…) becomes a group tag — [Supervisely: Medical 2D](https://docs.supervisely.com/import-and-export/import/supported-annotation-formats/images/medical2d).
- **Scale Nucleus**: items can be grouped into `LidarScenes` (point clouds + camera images over time, made of Frames) or `VideoScenes`. — [Nucleus: Datasets](https://nucleus.scale.com/docs/datasets-in-nucleus); [Nucleus SDK](https://docs.nucleus.scale.com/en/latest/api/nucleus/index.html)
- **Labelbox attachments**: data rows can carry context attachments of type IMAGE, VIDEO, RAW_TEXT, TEXT_URL, HTML, IMAGE_OVERLAY and PDF_URL alongside the labelled asset. — [Labelbox: Dataset (developer guide)](https://docs.labelbox.com/horizon/developer-guides/dataset)

### Inferences
- The industry's answer to "a patient with MRI + ECG + report" is a **group item whose tiles each use their own renderer**, not a separate studio per type. Encord's Data Groups are the most general (any modality, custom tiling, cross-tile objects, study-level classifications).
- Labelbox's attachments are context only: the attachment isn't labelled.
- Supervisely's multiview requires same-type members because the project is typed.

### Gaps
- No platform documents a time-series/ECG tile inside a Data Group. Encord lists time series (.csv) as a data unit type ([supported data](https://docs.encord.com/platform-documentation/General/general-supported-data)) but not among the Data Group member types.
- No platform documents grouping image + mask pairs as a group; masks are typically imported as labels.

## 5. Format conversion at ingest (AVI→MP4, SVS/NDPI tiling, DICOM series assembly, NIfTI)

### Takeaway
Behaviour varies a lot:
- **V7** does the most server-side: it accepts AVI/MKV/HEVC, auto-tiles images over 10k px, and natively handles SVS/NDPI, NIfTI and DICOM. But DICOM series assembly relies on a user-side "zip and rename to .dcm" convention.
- **Supervisely** converts on import via import apps (DICOM/NIfTI→NRRD).
- **Encord** detects video encoding problems on ingest but makes re-encoding an explicit, Enterprise-only action that produces a new "_normalized" file.
- **Labelbox** requires users to transcode to H.264/H.265 MP4 themselves.

### Cited Findings
- **Labelbox**: MP4 only, H.264/H.265, max 1024 MB and 20,000 frames, with a frame-count consistency check ("Unsupported video detected" warning). The fix it suggests is user-run `ffmpeg -i <input.mp4> -vcodec libx264 -acodec aac <output.mp4>`. — [Labelbox: Import video data](https://docs.labelbox.com/reference/import-video-data). Ingest still processes files ("generate embeddings, extract media attributes, and standardize formats"), with a `ConversionFailed` error. — [Labelbox: Import errors & warnings](https://docs.labelbox.com/horizon/guides/import-errors-and-warnings). A support thread (January 2025) rejects "MPEG4" files that aren't real MP4s. — [Labelbox Community](https://community.labelbox.com/t/video-mp4-import-problem/2361)
- **Encord**: "Encord automatically checks all uploaded videos for re-encoding… a red badge on the file icon indicates the number of issues." Re-encoding is Enterprise-only, in Auto (spot fix) or Full mode. It writes a new `<name>_normalized.mp4`, and Encord recommends doing it at Folder level so the result is reusable across projects. — [Encord: Re-encoding videos](https://docs.encord.com/platform-documentation/Curate/files/files-re-encoding). MOV only plays in Safari. — [Encord: Supported data](https://docs.encord.com/platform-documentation/General/general-supported-data)
- **Encord** DICOM import needs the tags Rows, Columns, StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID and PatientID, plus ImagePositionPatient, ImageOrientationPatient, SliceThickness and PixelSpacing for 3D. The upload dialog has a dedicated "DICOM: Create a DICOM series from local DICOM files" path. — [Encord: Basics](https://docs.encord.com/platform-documentation/Curate/index-files). The architecture doc caps videos at "up to 2 hours at 30fps" and folders at 10,000,000 images. — [Encord: Platform architecture](https://docs.encord.com/solutions-documentation/enterprise-ai/platform-architecture)
- **V7**: "V7 will automatically create pyramidal tile for any file over 10,000 pixels in height or width". Max size is 65,535 × 65,535 px. — [V7: Supported formats](https://docs.v7labs.com/docs/supported-file-formats)
- **V7** DICOM series: "we'd recommend zipping the series together outside of V7 and renaming the .zip file to .dcm"; otherwise "each slice will be uploaded as an individual image". Multi-planar views are extracted on import, and DICOM is shown in native 16-bit. — [V7: Annotate DICOM & NIfTI](https://docs.v7labs.com/docs/annotate-dicom-nifti-files). Image sequences use the same trick: zip and rename to `.mp4`. Slices are reoriented to LPI using ImagePositionPatient/ImageOrientationPatient. — [V7: Convert images and DICOM slices](https://docs.v7labs.com/docs/convert-images-and-dicom-slices-into-image-sequencesseries). With read-only external storage, "DICOM slices and series must first be converted to images" by the user. — [V7: Registering items](https://docs.v7labs.com/docs/registering-items-from-external-storage)
- **Supervisely**: the Import DICOM Volumes app converts DICOM to NRRD automatically during import and finds series in any directory structure. — [import-dicom-volumes (GitHub)](https://github.com/supervisely-ecosystem/import-dicom-volumes). The Medical 2D converter turns non-NRRD files (.dcm/.nii/.nii.gz) into NRRD and slices 3D files axially. — [Supervisely: Medical 2D](https://docs.supervisely.com/import-and-export/import/supported-annotation-formats/images/medical2d)
- **SuperAnnotate**: `upload_video_to_project(project, video_path, target_fps=...)` (on Vector projects) extracts frames client-side at a target FPS. — [SuperAnnotate SDK: Projects](https://superannotate.readthedocs.io/en/stable/api%5Freference/api%5Fproject.html)
- **Nucleus**: uploads go through an async pipeline that "handles phash computation, image optimization, and NLS search indexing". — [Nucleus SDK](https://docs.nucleus.scale.com/en/latest/api/nucleus/index.html)
- **BasicAI**: LiDAR Fusion data must be uploaded as an archive (.zip/.gzip/.tar/.rar). — [BasicAI: LiDAR tool](https://docs.basic.ai/docs/lidar-fusion-tool)

### Inferences
- The pattern most like "convert on ingest, keep the original" is Encord's: detect on upload, flag the file, write a new normalized sibling file.
- V7 tiles server-side by size threshold, which is the closest analogue to SVS/NDPI tiling on ingest.

### Gaps
- No docs found on Encord, Labelbox or Supervisely support for SVS/NDPI whole-slide images. Encord's supported-data table lists TIFF but no WSI formats ([Encord supported data](https://docs.encord.com/platform-documentation/General/general-supported-data)). Labelbox lists only PNG/JPEG/BMP images.
- V7 does not say whether its AVI support transcodes server-side or plays natively.
- Kili, Labellerr, Dataloop and Segments.ai conversion behaviour was not researched in depth because of the tool-call budget.

## 6. Documented rationale and reversals (single-type → multimodal)

### Takeaway
The clearest documented move toward mixed modalities is **Encord**: image groups grew into any-type Data Groups (GA 2026), then Auto Data Groups (GA April 2026). Elsewhere "multimodal" mostly means GenAI form builders (SuperAnnotate Multimodal, Dataloop GenAI/Multimodal recipes, Kili LLM types), not CV/medical mixed projects. **Labelbox narrowed its modalities** by sunsetting its DICOM editor in November 2024 for lack of usage.

### Cited Findings
- Encord describes Data Groups as "like image groups in Encord, except that Data Groups can include any data type". This frames them as a generalisation of a previously single-type grouping. — [Encord Data Groups](https://docs.encord.com/platform-documentation/Curate/data-groups/index-data-groups)
- Encord 2026 release notes: Data Groups general release ("a powerful and intuitive way to build complex labeling tasks with different types of media"), and Auto Data Groups GA on April 24, 2026. — [Encord 2026 release notes](https://docs.encord.com/release-notes/releasenotes-2026)
- Labelbox sunset its DICOM editor on November 25, 2024 "Due to a lack of usage". — [Labelbox Deprecations](https://docs.labelbox.com/horizon/guides/deprecations); [Release notes](https://docs.labelbox.com/horizon/release-notes)
- SuperAnnotate's Multimodal project type exists because "Large Language Models and Generative AI have data needs that set them apart". — [SuperAnnotate Multimodal](https://doc.superannotate.com/docs/getting-started-multimodal)
- Dataloop added a GenAI/Multimodal recipe type with per-item layouts alongside its modality-specific recipes. — [Dataloop Recipes](https://docs.dataloop.ai/docs/recipes-overview); [GenAI evaluation](https://docs.dataloop.ai/docs/gen-ai-eval-overview)
- Kili added `LLM_RLHF`, `LLM_INSTR_FOLLOWING` and `LLM_STATIC` input types beside IMAGE/VIDEO/etc. Project type remains immutable. — [Kili SDK](https://python-sdk-docs.kili-technology.com/26.1/sdk/project/)
- Supervisely added multiview as a project setting, not a new project type. — [Supervisely multiview videos](https://docs.supervisely.com/labeling/labeling-toolbox/multi-view-videos)

### Inferences
- For the "studio per data type vs one repository with per-file renderer" question, the evidence splits two ways:
  - **Data store**: the market leaders (Labelbox Catalog, Encord Files/Folders, Scale Nucleus, V7 datasets) keep one untyped repository and render each file by its type when browsing.
  - **Labelling work**: most vendors still type the project, because ontology tools depend on modality. The newest designs (Encord Data Groups, V7 slots, Dataloop per-file default studios) instead compose per-file renderers inside one task or project.
- A hybrid matches current practice: one untyped repository, per-file renderer chosen by type, grouping for multi-file items, and work containers that may be typed or mixed.
- "Multimodal" in vendor marketing usually refers to GenAI forms. Don't read it as evidence of mixed CV/medical projects.

### Gaps
- I found no vendor blog or design post explaining *why* projects are typed (beyond tool availability), and no post-mortem on a reversal.
- No evidence of Labelbox, Supervisely or Kili planning untyped projects.
- Scale Studio and V7 Go positioning for mixed modalities not found.
