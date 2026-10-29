import { seedUrl } from "@/lib/api";
import type { ExporterImpl, InspectFn, ModuleImpl } from "@/platform/module";
import type { TextSpan } from "./manifest";
import { TextReader } from "./reader";
import { toJsonl } from "./spans";

const inspect: InspectFn = (a) => {
  const g = a.geometry as unknown as TextSpan;
  return [
    ["Text", g.text],
    ["Characters", `${g.start}–${g.end} (${g.end - g.start})`],
  ];
};

const jsonl: ExporterImpl = {
  filename: (p) => `${p.id}-spans.jsonl`,
  async build({ items, annotations }) {
    const docs = await Promise.all(items.map(async (i) => ({ id: i.id, text: await (await fetch(seedUrl(i.assets[0].path))).text() })));
    return new Blob([toJsonl(docs, annotations)], { type: "application/jsonl" });
  },
};

export default { renderers: { reader: TextReader }, inspectors: { main: inspect }, exporters: { jsonl } } satisfies ModuleImpl;
