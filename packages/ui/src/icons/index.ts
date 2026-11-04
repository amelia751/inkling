/**
 * The only place the app imports icons from. Each export is named for its job,
 * not its glyph, so one meaning always draws the same icon.
 *
 * Source: Gravity UI icons (MIT), the set Nebius uses, on a 16-unit grid. Glyphs
 * Gravity lacks (mostly annotation tools) are drawn to match in `./custom`.
 *
 * Sizes follow Gravity: 16 by default; 12 inside xs controls, labels and inline
 * metadata; 14 inside small (24px) controls; 20 for large tiles; 18 in the nav rail.
 */
import type { ComponentType, SVGProps } from "react";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// Navigation and app chrome
export { default as DatasetsIcon } from "@gravity-ui/icons/Database";
export { default as AnnotateIcon } from "@gravity-ui/icons/Pencil";
export { default as ReviewIcon } from "@gravity-ui/icons/ListCheck";
export { default as ExportIcon } from "@gravity-ui/icons/ArrowDownToLine";
export { default as UploadIcon } from "@gravity-ui/icons/ArrowUpFromLine";
export { default as SidebarIcon } from "@gravity-ui/icons/LayoutSideContentLeft";
export { default as SidePanelIcon } from "@gravity-ui/icons/LayoutSideContentRight";
export { default as MenuIcon } from "@gravity-ui/icons/Bars";
export { default as KeyboardIcon } from "@gravity-ui/icons/Keyboard";
export { default as SearchIcon } from "@gravity-ui/icons/Magnifier";
export { default as MoreIcon } from "@gravity-ui/icons/Ellipsis";
export { default as CloseIcon } from "@gravity-ui/icons/Xmark";
export { default as DeleteIcon } from "@gravity-ui/icons/TrashBin";
export { default as CopyIcon } from "@gravity-ui/icons/Copy";
export { default as SettingsIcon } from "@gravity-ui/icons/Sliders";
export { default as TagIcon } from "@gravity-ui/icons/Tag";
export { default as LightThemeIcon } from "@gravity-ui/icons/Sun";
export { default as DarkThemeIcon } from "@gravity-ui/icons/Moon";
export { default as SystemThemeIcon } from "@gravity-ui/icons/Display";
export { default as SendIcon } from "@gravity-ui/icons/PaperPlane";
export { default as LicenseIcon } from "@gravity-ui/icons/ShieldCheck";
export { default as FileIcon } from "@gravity-ui/icons/FileCode";
// The product logo, in colour (a mark, not a glyph): `custom.tsx`.
export { BrandLogo } from "./custom";
// Projects and sources (todo6 §3). Glyphs may repeat across jobs; a job never gets two glyphs.
export { default as HomeIcon } from "@gravity-ui/icons/House";
export { default as ProjectsIcon } from "@gravity-ui/icons/LayoutCellsLarge";
export { default as OverviewIcon } from "@gravity-ui/icons/House";
export { default as SourcesIcon } from "@gravity-ui/icons/FolderTree";
export { default as ExploreIcon } from "@gravity-ui/icons/Compass";
export { default as ActivityIcon } from "@gravity-ui/icons/ListTimeline";
export { default as ProjectSettingsIcon } from "@gravity-ui/icons/Gear";
export { default as AddDataIcon } from "@gravity-ui/icons/CloudArrowUpIn";
export { default as TopUpIcon } from "@gravity-ui/icons/Plus";
export { default as ContactIcon } from "@gravity-ui/icons/Comment";
export { default as DocsIcon } from "@gravity-ui/icons/BookOpen";
export { default as ExternalLinkIcon } from "@gravity-ui/icons/ArrowUpRightFromSquare";
export { default as TeamIcon } from "@gravity-ui/icons/Persons";
export { default as PersonIcon } from "@gravity-ui/icons/Person";
export { default as InviteIcon } from "@gravity-ui/icons/PersonPlus";
export { default as ApiKeyIcon } from "@gravity-ui/icons/Key";
export { default as SecurityIcon } from "@gravity-ui/icons/ShieldKeyhole";
export { default as AuditLogIcon } from "@gravity-ui/icons/ListUl";
export { default as OrganizationIcon } from "@gravity-ui/icons/Briefcase";
export { default as BillingIcon } from "@gravity-ui/icons/CreditCard";
export { default as InvoiceIcon } from "@gravity-ui/icons/Receipt";
export { default as UsageIcon } from "@gravity-ui/icons/ChartLine";
export { default as MailIcon } from "@gravity-ui/icons/Envelope";
export { default as DomainIcon } from "@gravity-ui/icons/Globe";
export { default as SignOutIcon } from "@gravity-ui/icons/ArrowRightFromSquare";
export { default as FingerprintIcon } from "@gravity-ui/icons/Fingerprint";
export { default as FolderIcon } from "@gravity-ui/icons/Folder";
export { default as FolderOpenIcon } from "@gravity-ui/icons/FolderOpen";
export { default as FileSequenceIcon } from "@gravity-ui/icons/Files";
export { default as TableFileIcon } from "@gravity-ui/icons/LayoutHeaderCellsLarge";
export { default as ArchiveFileIcon } from "@gravity-ui/icons/FileZipper";
export { default as MaskFileIcon } from "@gravity-ui/icons/Layers3Diagonal";
export { default as AnnotationFileIcon } from "@gravity-ui/icons/Tags";
export { default as UnknownFileIcon } from "@gravity-ui/icons/FileQuestion";
export { default as QueuedIcon } from "@gravity-ui/icons/Hourglass";
export { default as PrivacyIcon } from "@gravity-ui/icons/ShieldExclamation";
export { default as RelationshipIcon } from "@gravity-ui/icons/Link";
export { default as NoRelationshipIcon } from "@gravity-ui/icons/LinkSlash";
// Sources browser (todo6 Phase 4): the listing's view switch and Quick Look.
export { default as ListViewIcon } from "@gravity-ui/icons/ListUl";
export { default as GridViewIcon } from "@gravity-ui/icons/LayoutCells";
export { default as QuickLookIcon } from "@gravity-ui/icons/Eye";
// Files (todo7 §2 Visuals): the project's drive. Reused glyphs keep one meaning per job.
export { default as NewFolderIcon } from "@gravity-ui/icons/FolderPlus";
export { default as RenameIcon } from "@gravity-ui/icons/PencilToLine";
export { default as MoveIcon } from "@gravity-ui/icons/FolderArrowRight";
export { default as CutIcon } from "@gravity-ui/icons/Scissors";
/** Gravity has no clipboard glyph. */
export { default as PasteIcon } from "@gravity-ui/icons/CopyArrowRight";
/** Move to Trash: the same glyph as `DeleteIcon`. */
export { default as TrashIcon } from "@gravity-ui/icons/TrashBin";
export { default as RestoreIcon } from "@gravity-ui/icons/ArrowUturnCcwLeft";
export { default as StarIcon } from "@gravity-ui/icons/Star";
export { default as StarFillIcon } from "@gravity-ui/icons/StarFill";
/** The same glyph as `ExportIcon`. */
export { default as DownloadIcon } from "@gravity-ui/icons/ArrowDownToLine";
/** A file's versions: the same glyph as `HistoryIcon`. */
export { default as VersionsIcon } from "@gravity-ui/icons/ClockArrowRotateLeft";
export { default as CollapseAllIcon } from "@gravity-ui/icons/ChevronsCollapseVertical";
/** New ▾ in the Files toolbar and a tree row's "new folder inside". */
export { default as PlusIcon } from "@gravity-ui/icons/Plus";
/** The tree's Sort menu. */
export { default as SortIcon } from "@gravity-ui/icons/BarsDescendingAlignLeft";
// Annotations written from a source file (a CSV column): todo6 D8.
export { default as ImportedIcon } from "@gravity-ui/icons/FileArrowUp";
// Dataset versioning
export { default as BranchIcon } from "@gravity-ui/icons/CodeFork";
export { default as MergeIcon } from "@gravity-ui/icons/CodeMerge";
export { default as HistoryIcon } from "@gravity-ui/icons/ClockArrowRotateLeft";
// Studio, calmer (todo8): the Items panel's Queue and Folders views, and Task setup.
export { default as QueueIcon } from "@gravity-ui/icons/ListUl";
export { default as FoldersIcon } from "@gravity-ui/icons/FolderTree";
export { default as TaskSetupIcon } from "@gravity-ui/icons/Sliders";

// Disclosure and direction
export { default as ChevronDownIcon } from "@gravity-ui/icons/ChevronDown";
export { default as ChevronUpIcon } from "@gravity-ui/icons/ChevronUp";
export { default as ChevronLeftIcon } from "@gravity-ui/icons/ChevronLeft";
export { default as ChevronRightIcon } from "@gravity-ui/icons/ChevronRight";
export { default as ArrowLeftIcon } from "@gravity-ui/icons/ArrowLeft";
export { default as ArrowRightIcon } from "@gravity-ui/icons/ArrowRight";
export { default as ArrowUpIcon } from "@gravity-ui/icons/ArrowUp";
export { default as ArrowDownIcon } from "@gravity-ui/icons/ArrowDown";
export { default as CheckIcon } from "@gravity-ui/icons/Check";
export { default as DotIcon } from "@gravity-ui/icons/CircleFill";

// Edit and view state
export { default as UndoIcon } from "@gravity-ui/icons/ArrowUturnCcwLeft";
export { default as RedoIcon } from "@gravity-ui/icons/ArrowUturnCwRight";
export { default as ShowIcon } from "@gravity-ui/icons/Eye";
export { default as HideIcon } from "@gravity-ui/icons/EyeSlash";
export { default as LockIcon } from "@gravity-ui/icons/Lock";
export { default as UnlockIcon } from "@gravity-ui/icons/LockOpen";
export { default as ZoomInIcon } from "@gravity-ui/icons/MagnifierPlus";
export { default as ZoomOutIcon } from "@gravity-ui/icons/MagnifierMinus";
export { default as FitIcon } from "@gravity-ui/icons/ArrowsExpand";
export { default as FullscreenIcon } from "@gravity-ui/icons/ChevronsExpandUpRight";
export { default as RotateLeftIcon } from "@gravity-ui/icons/ArrowRotateLeft";
export { default as RotateRightIcon } from "@gravity-ui/icons/ArrowRotateRight";
export { default as RetryIcon } from "@gravity-ui/icons/ArrowRotateRight";
export { default as GridIcon } from "@gravity-ui/icons/LayoutCells";
export { default as ChartIcon } from "@gravity-ui/icons/ChartColumn";
export { default as RegionIcon } from "@gravity-ui/icons/SquareDashed";
export { default as ProjectionIcon } from "@gravity-ui/icons/Layers";
export { default as InterpolateIcon } from "@gravity-ui/icons/LayersVertical";
export { default as CleanupIcon } from "@gravity-ui/icons/BroomMotion";
export { default as OverlayOpacityIcon } from "@gravity-ui/icons/Droplet";
export { FlipHorizontal as FlipHorizontalIcon, FlipVertical as FlipVerticalIcon, Invert as InvertIcon } from "./custom";

// Status
export { default as DoneIcon } from "@gravity-ui/icons/CircleCheck";
export { default as DoneFillIcon } from "@gravity-ui/icons/CircleCheckFill";
export { default as TodoIcon } from "@gravity-ui/icons/Circle";
export { default as WarningIcon } from "@gravity-ui/icons/TriangleExclamation";
export { default as ErrorIcon } from "@gravity-ui/icons/CircleExclamation";
export { default as InfoIcon } from "@gravity-ui/icons/CircleInfo";

// AI and provenance (AI glyphs pair with the lime AI colour, never brand violet)
export { default as AiIcon } from "@gravity-ui/icons/Sparkles";
export { default as SubmitIcon } from "@gravity-ui/icons/ArrowUp";
export { default as StopIcon } from "@gravity-ui/icons/StopFill";
// todo13: attach files to a chat message.
export { default as AttachIcon } from "@gravity-ui/icons/Paperclip";
export { default as NewChatIcon } from "@gravity-ui/icons/CommentPlus";
export { default as ToolIcon } from "@gravity-ui/icons/Wrench";
export { default as DocumentIcon } from "@gravity-ui/icons/FileText";
export { default as HumanIcon } from "@gravity-ui/icons/Person";
export { default as CorrectedIcon } from "@gravity-ui/icons/PencilToLine";

// Data types
export { default as ImageIcon } from "@gravity-ui/icons/Picture";
export { default as VolumeIcon } from "@gravity-ui/icons/Cube";
export { default as WaveformIcon } from "@gravity-ui/icons/Pulse";
export { default as CardiacIcon } from "@gravity-ui/icons/HeartPulse";
export { default as VideoIcon } from "@gravity-ui/icons/Filmstrip";
export { default as SlideIcon } from "@gravity-ui/icons/Microscope";

// Playback
export { default as PlayIcon } from "@gravity-ui/icons/Play";
export { default as PauseIcon } from "@gravity-ui/icons/Pause";
export { default as StepBackIcon } from "@gravity-ui/icons/BackwardStep";
export { default as StepForwardIcon } from "@gravity-ui/icons/ForwardStep";
export { default as SkipBackIcon } from "@gravity-ui/icons/ChevronsLeft";
export { default as SkipForwardIcon } from "@gravity-ui/icons/ChevronsRight";
export { default as LoopIcon } from "@gravity-ui/icons/ArrowsRotateRight";
export { default as LoopOnceIcon } from "@gravity-ui/icons/ArrowRotateRight";
export { default as KeyframeIcon } from "@gravity-ui/icons/Diamond";

// Annotation tools
export { default as PanIcon } from "@gravity-ui/icons/Hand";
export { default as BoxIcon } from "@gravity-ui/icons/Square";
export { default as EllipseIcon } from "@gravity-ui/icons/Circle";
export { default as KeypointIcon } from "@gravity-ui/icons/Target";
export { default as Point3DIcon } from "@gravity-ui/icons/MapPin";
export { default as ArrowNoteIcon } from "@gravity-ui/icons/ArrowUpRight";
export { default as BrushIcon } from "@gravity-ui/icons/Brush";
export { default as EraserIcon } from "@gravity-ui/icons/Eraser";
export { default as FillIcon } from "@gravity-ui/icons/BucketPaint";
export { default as BeatIcon } from "@gravity-ui/icons/HeartPulse";
export { default as RhythmIcon } from "@gravity-ui/icons/Pulse";
export { default as EventIcon } from "@gravity-ui/icons/Flag";
export {
  SelectPointer as SelectIcon,
  WindowLevel as WindowLevelIcon,
  Crosshairs as CrosshairsIcon,
  Polygon as PolygonIcon,
  Lasso as FreehandIcon,
  Polyline as PolylineIcon,
  Spline as SplineIcon,
  PointMarks as PointMarksIcon,
  Length as LengthIcon,
  Angle as AngleIcon,
  CobbAngle as CobbAngleIcon,
  Bidirectional as BidirectionalIcon,
  Probe as ProbeIcon,
  Caliper as CaliperIcon,
  Interval as IntervalIcon,
  Wave as WaveIcon,
  TimeSpan as SegmentIcon,
} from "./custom";
