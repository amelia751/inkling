import { assetUrl } from "@studio/plugin-ui-sdk/host";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { DownloadIcon, UnknownFileIcon } from "@studio/ui/icons";
import { fileFacts, mainAsset, previewable } from "./facts";

/** Generic file view (todo19 D3): see manifest.ts. */
export default function FileView({ item }: RendererProps) {
  const asset = mainAsset(item);
  if (!asset) return <div className="p-6 text-sm text-muted-foreground" data-testid="file-view">This item has no files.</div>;
  const name = asset.name ?? item.name ?? asset.path.split("/").pop();
  const href = assetUrl(asset.path);
  return (
    <div className="flex h-full w-full flex-col items-center gap-4 overflow-auto p-6" data-testid="file-view">
      {previewable(asset) ? (
        <img src={href} alt={name} className="max-h-[60%] max-w-full rounded border object-contain" data-testid="file-view-preview" />
      ) : (
        <UnknownFileIcon className="size-12 text-muted-foreground" />
      )}
      <div className="text-base font-medium break-all">{name}</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {fileFacts(asset, item.dataKind).map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="break-all">{r.value}</dd>
          </div>
        ))}
      </dl>
      <a href={href} download={name} className="inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-accent" data-testid="file-view-download">
        <DownloadIcon className="size-4" /> Download
      </a>
    </div>
  );
}
