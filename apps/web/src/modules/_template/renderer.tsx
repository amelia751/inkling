import { useEffect, useRef } from "react";
import type { RendererProps } from "@/platform/module";
import { newAnnotation, useStudio, visibleFor } from "@/stores/studio";

/** Renderers get everything through props (env, item, config, runtime) and write through the store. */
export function CanvasRenderer({ item, config, runtime }: RendererProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const annotations = useStudio((s) => s.annotations);
  const tool = useStudio((s) => s.tool);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.fillStyle = String(config.background);
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#fff";
    ctx.fillText(item.name, 12, 20);
    for (const a of visibleFor(annotations, item.id, [])) if (a.geometry.type === "keypoint") ctx.fillRect(a.geometry.x - 2, a.geometry.y - 2, 4, 4);
    runtime.publish("status", `${item.name}`);
  }, [annotations, item, config.background, runtime]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = useStudio.getState();
    if (tool !== "dot" || !s.activeLabel) return;
    s.add(newAnnotation({ itemId: item.id, label: s.activeLabel, geometry: { type: "keypoint", x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY } }));
  };
  return <canvas ref={ref} width={640} height={480} onClick={onClick} data-testid="example-canvas" />;
}
