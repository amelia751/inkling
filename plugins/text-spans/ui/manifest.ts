import { FileIcon, TagIcon } from "@studio/studio-ui/icons";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Project, StudioItem } from "@studio/plugin-contracts/types";
import { ns } from "@studio/plugin-contracts/naming";

/**
 * Named-entity / span labelling on plain text. Written from the outside, against the
 * public contract only: it changes no file outside this folder except its one line in
 * src/bundle.ts. Spans are a module geometry (`inkling.text-spans.span`, character offsets).
 */
export const TEXT = ns("text-spans");
export const SPAN = `${TEXT}.span` as const;

export interface TextSpan {
  type: typeof SPAN;
  /** Character offsets into the item's text, end exclusive. */
  start: number;
  end: number;
  /** The covered text, kept for exports and for checking the source didn't change. */
  text: string;
}

export const isTextSpan = (a: Annotation): a is Annotation & { geometry: TextSpan } => a.geometry.type === SPAN;

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({ id: a.path, name: a.path.split("/").pop() ?? a.path, group: "Documents", assets: [a], sourceLabel: a.label, dataKind: `${TEXT}.dataKinds.text` }));
}

const clip = (s: string) => (s.length > 32 ? `${s.slice(0, 31)}…` : s);

export default defineModule({
  id: TEXT,
  version: "0.1.0",
  title: "Text spans",
  description: "Plain-text documents with character-offset span labels (named entities, phrases); JSONL export in the spaCy / doccano shape.",
  contributes: {
    dataKinds: [{ id: "text", label: "Text", icon: FileIcon, itemNoun: "document", match: { ext: [".txt", ".md"] }, groupItems, description: "One item per UTF-8 text file" }],
    renderers: [
      {
        id: "reader",
        consumes: [`${TEXT}.dataKinds.text`],
        space: "text",
        capabilities: [],
        description: "Reading view: select text to label a span; click a span to select it",
      },
    ],
    geometries: [
      {
        id: "span",
        type: SPAN,
        spaces: ["text"],
        description: "Character span [start, end) of a text item",
        describe: (g) => {
          const s = g as unknown as TextSpan;
          return `“${clip(s.text)}” · chars ${s.start}–${s.end}`;
        },
      },
    ],
    tools: [
      { id: "entity", label: "Span", hint: "Select text with the mouse to label it with the active class", icon: TagIcon, group: "shape", hotkey: "e", creates: SPAN, when: "renderer.space == text", description: "Label a selected text span" },
    ],
    labelControls: [{ id: "SpanLabels", geometries: [SPAN], description: "Classes for text spans (named entities)" }],
    inspectors: [{ id: "main", geometries: [SPAN], description: "Offsets, length and covered text" }],
    exporters: [{ id: "jsonl", label: "Spans JSONL", accepts: [SPAN], description: "One line per document: {\"text\", \"spans\": [[start, end, label]…]}, readable by spaCy and doccano." }],
    presets: [
      {
        id: "ner",
        title: "Named entities",
        description: "Person / organisation / location spans on plain text, JSONL export.",
        spec: {
          data: { kind: `${TEXT}.dataKinds.text` },
          viewports: [{ name: "main", renderer: `${TEXT}.renderers.reader` }],
          tools: [ns("core.tools.select"), `${TEXT}.tools.entity`],
          labels: [{ name: "entities", control: "SpanLabels", classes: [{ id: "PER", color: "#ef476f" }, { id: "ORG", color: "#118ab2" }, { id: "LOC", color: "#06d6a0" }] }],
          panels: { left: [ns("core.panels.files"), ns("core.panels.labels"), ns("core.panels.review")], right: [ns("core.panels.ai")] },
          exporters: [`${TEXT}.exporters.jsonl`],
          reviewRules: [ns("core.reviewRules.unlabeled-items")],
        },
      },
    ],
  },
  load: () => import("./impl"),
});
