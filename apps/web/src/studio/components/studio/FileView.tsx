import { assetUrl } from "@studio/plugin-ui-sdk/host";
import type { StudioItem } from "@studio/contracts/types";
import { DownloadIcon, FileIcon } from "@studio/ui/icons";
import { buttonVariants } from "@studio/ui/ui/button";

/**
 * The generic file view (todo19 D3): an item whose kind this Studio doesn't map still opens,
 * with its name, kind and a download per file. Nothing disappears.
 * TODO(todo19 C): switch to the `file-view` renderer in packages/renderers once it lands.
 */
export function FileView({ item, kind }: { item: StudioItem; kind: string | undefined }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-sm text-canvas-foreground/80" data-testid="file-view" data-kind={kind ?? ""}>
      <FileIcon className="size-8 text-canvas-foreground/60" aria-hidden />
      <div className="font-medium" data-testid="file-view-name">{item.name}</div>
      <div className="text-canvas-foreground/60">{kind ? `This Studio has no viewer for ${kind.split(".").pop()} files` : "This Studio has no viewer for this file"}</div>
      <ul className="flex flex-col gap-1">
        {item.assets.map((a) => (
          <li key={a.path}>
            <a href={assetUrl(a.path)} download className={buttonVariants({ size: "sm", variant: "outline" })} data-testid="file-view-download">
              <DownloadIcon className="size-3.5" aria-hidden />
              {a.path.split("/").pop()}
              <span className="tnum text-hint">{formatBytes(a.bytes)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
