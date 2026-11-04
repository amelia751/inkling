import { NAMING } from "@studio/contracts/naming";
import type { IllustrationName } from "@studio/ui/illustrations";
import {
  AiIcon,
  BeatIcon,
  BoxIcon,
  CardiacIcon,
  DatasetsIcon,
  DocumentIcon,
  HumanIcon,
  ImageIcon,
  PrivacyIcon,
  ReviewIcon,
  SlideIcon,
  TableFileIcon,
  TagIcon,
  VersionsIcon,
  VideoIcon,
  VolumeIcon,
  WaveformIcon,
  type IconComponent,
} from "@studio/ui/icons";
import { APP_URL } from "@/lib/runtime";

export { APP_URL };
export const NAME = NAMING.displayName;

export const ANNOUNCEMENTS = [
  `New: the ${NAME} assistant now boots a Studio from one sentence`,
  "Files: a drive per project, with 30 days of Trash and undo for every move",
  "Datasets: branch, review and merge versions like code",
];

export type MenuItem = { icon: IconComponent; title: string; text: string };
export type NavEntry = { label: string; href: string; menu?: MenuItem[] };

export const NAV: NavEntry[] = [
  {
    label: "Product",
    href: "#journey",
    menu: [
      { icon: AiIcon, title: "Assistant", text: "Sets up datasets, labels and Studios from a conversation" },
      { icon: BoxIcon, title: "Studio", text: "Label images, volumes, signals, video and text" },
      { icon: DatasetsIcon, title: "Datasets", text: "Group files into collections and items" },
      { icon: VersionsIcon, title: "Versions", text: "Branch, review and merge, then cite a version" },
    ],
  },
  {
    label: "Data types",
    href: "#data",
    menu: [
      { icon: ImageIcon, title: "Imaging", text: "X-ray, CT, MRI, retina and photos" },
      { icon: WaveformIcon, title: "Signals", text: "ECG and any time series" },
      { icon: VideoIcon, title: "Video", text: "Endoscopy, ultrasound and cine loops" },
      { icon: SlideIcon, title: "Pathology", text: "Whole-slide images at every zoom" },
    ],
  },
  { label: "Why us", href: "#why" },
];

export type Step = { title: string; text: string };

export const JOURNEY: Step[] = [
  { title: "Drop anything", text: "DICOM series, PNG folders, ZIPs, CSV signals, video. Files are checked and sorted while they upload." },
  { title: "Say what you need", text: "“Chest X-ray classification with five labels.” The assistant reads file facts, never pixels, and plans the dataset." },
  { title: "A Studio appears", text: "The right viewer, tools and label set boot in front of you, with the first item already open." },
  { title: "Review and version", text: "Second readers, agreement and review queues. Every release is a version you can branch, diff and cite." },
];

export const DATA_TYPES: { icon: IconComponent; label: string }[] = [
  { icon: ImageIcon, label: "Chest X-ray" },
  { icon: VolumeIcon, label: "CT volumes" },
  { icon: VolumeIcon, label: "Brain MRI" },
  { icon: CardiacIcon, label: "Cardiac cine" },
  { icon: BeatIcon, label: "12-lead ECG" },
  { icon: SlideIcon, label: "Whole-slide pathology" },
  { icon: VideoIcon, label: "Endoscopy video" },
  { icon: ImageIcon, label: "Retinal fundus" },
  { icon: DocumentIcon, label: "Clinical notes" },
  { icon: TableFileIcon, label: "Sensor CSV" },
  { icon: ImageIcon, label: "Satellite tiles" },
  { icon: VideoIcon, label: "Drone footage" },
];

export const BUILDERS = [
  { icon: HumanIcon, text: "Experts label. The assistant does the setup." },
  { icon: TagIcon, text: "Every label remembers who, or what, made it" },
  { icon: ReviewIcon, text: "Review queues and reader agreement built in" },
  { icon: PrivacyIcon, text: "Your files never reach the model" },
];

export const STATS = [
  { value: 9, suffix: "", label: "data families out of the box, from X-ray to ECG" },
  { value: 30, suffix: " days", label: "in Trash before anything is really gone" },
  { value: 1, suffix: "", label: "conversation from raw files to a labelled Studio" },
  { value: 0, suffix: "", label: "lines of code to set up a task" },
];

export type NewsItem = { date: string; title: string; art: IllustrationName };

export const NEWS: NewsItem[] = [
  { date: "Nov 2026", title: "The assistant now opens a Studio with your labels from one sentence", art: "annotation" },
  { date: "Oct 2026", title: "Files: one drive per project, with folders, recents and undo", art: "dataset" },
  { date: "Oct 2026", title: "Dataset versions: branch, review and merge like code", art: "release" },
  { date: "Sep 2026", title: "Workspaces for teams: invite readers and keep conversations private", art: "members" },
  { date: "Sep 2026", title: "CT and MRI: three views, window presets and slice-by-slice masks", art: "scan" },
];

/** Only links that go somewhere real; sections are absolute so they work from /privacy and /terms. */
export const FOOTER_LINKS: { label: string; href: string }[] = [
  { label: "How it works", href: "/#journey" },
  { label: "Data types", href: "/#data" },
  { label: "Why us", href: "/#why" },
  { label: "Sign in", href: APP_URL },
];
