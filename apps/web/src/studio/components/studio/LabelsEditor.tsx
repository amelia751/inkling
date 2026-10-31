import { useMemo } from "react";
import type { LabelClass, LabelGroup } from "@studio/contracts/environment";
import { ChevronDownIcon, ChevronUpIcon, DeleteIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Input } from "@studio/ui/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { cn } from "@studio/ui/utils";
import { CHART_COLORS, classKey, groupKind, nextColor, slugify } from "@/studio/lib/task-setup";

/**
 * The Labels section of Task setup (todo8 D7): each label group with its classes, their
 * colors (the theme's chart tokens), keys and order, and for a question (`Choices`) whether
 * one or several answers are allowed. A new class takes its id from its name until saved; an
 * existing class keeps its id (annotations store it) and only its display name changes.
 */
export function LabelsEditor({
  labels,
  onChange,
  conflicts,
  readOnly,
  fresh,
  onFresh,
}: {
  labels: LabelGroup[];
  onChange: (labels: LabelGroup[]) => void;
  conflicts: Map<string, string>;
  readOnly: boolean;
  /** Classes added on this page (`group:id` keys), whose id still follows the name. */
  fresh: Set<string>;
  onFresh: (fresh: Set<string>) => void;
}) {
  if (!labels.length) return <p className="text-sm text-muted-foreground">This task has no labels. Annotators can only look.</p>;

  const setGroup = (gi: number, g: LabelGroup) => onChange(labels.map((x, i) => (i === gi ? g : x)));
  const setClass = (gi: number, ci: number, patch: Partial<LabelClass>) => {
    const g = labels[gi];
    const cur = g.classes[ci];
    const next = { ...cur, ...patch };
    const key = `${gi}:${cur.id}`;
    if (fresh.has(key) && patch.name !== undefined) {
      next.id = slugify(patch.name);
      const f = new Set(fresh);
      f.delete(key);
      f.add(`${gi}:${next.id}`);
      onFresh(f);
    }
    if (next.hotkey === "") delete next.hotkey;
    setGroup(gi, { ...g, classes: g.classes.map((c, i) => (i === ci ? next : c)) });
  };
  const move = (gi: number, ci: number, by: -1 | 1) => {
    const classes = [...labels[gi].classes];
    const [c] = classes.splice(ci, 1);
    classes.splice(ci + by, 0, c);
    setGroup(gi, { ...labels[gi], classes });
  };
  const remove = (gi: number, ci: number) => setGroup(gi, { ...labels[gi], classes: labels[gi].classes.filter((_, i) => i !== ci) });
  const add = (gi: number) => {
    const g = labels[gi];
    // A placeholder id until the class is named (an empty id doesn't save).
    let n = g.classes.length + 1;
    while (g.classes.some((c) => c.id === `class-${n}`)) n++;
    const id = `class-${n}`;
    onFresh(new Set([...fresh, `${gi}:${id}`]));
    setGroup(gi, { ...g, classes: [...g.classes, { id, name: "", color: nextColor(g) }] });
  };

  return (
    <div className="flex flex-col gap-6">
      {labels.map((g, gi) => (
        <div key={`${gi}:${g.name}`} data-testid="label-group" data-group={g.name}>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold capitalize">{g.name}</h3>
            <span className="text-sm text-muted-foreground">{groupKind(g)}</span>
            {g.control === "Choices" && (
              <span className="ml-auto">
                {readOnly ? (
                  <span className="text-sm text-muted-foreground">{g.multiple ? "Multiple choice" : "Single choice"}</span>
                ) : (
                  <SegmentedControl
                    aria-label={`Answers for ${g.name}`}
                    value={g.multiple ? "multiple" : "single"}
                    onValueChange={(v) => setGroup(gi, { ...g, multiple: v === "multiple" ? true : undefined })}
                    options={[
                      { value: "single", label: "Single choice" },
                      { value: "multiple", label: "Multiple choice" },
                    ]}
                  />
                )}
              </span>
            )}
          </div>
          <ul className="flex flex-col">
            {g.classes.map((c, ci) => (
              <ClassRow
                key={`${ci}:${fresh.has(`${gi}:${c.id}`) ? "new" : c.id}`}
                cls={c}
                isNew={fresh.has(`${gi}:${c.id}`)}
                conflict={conflicts.get(classKey(gi, ci))}
                readOnly={readOnly}
                first={ci === 0}
                last={ci === g.classes.length - 1}
                onChange={(patch) => setClass(gi, ci, patch)}
                onMove={(by) => move(gi, ci, by)}
                onRemove={() => remove(gi, ci)}
              />
            ))}
          </ul>
          {!readOnly && (
            <Button variant="outline" size="sm" className="mt-2" onClick={() => add(gi)} data-testid="add-class">
              Add class
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function ClassRow({
  cls,
  isNew,
  conflict,
  readOnly,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  cls: LabelClass;
  isNew: boolean;
  conflict?: string;
  readOnly: boolean;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<LabelClass>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const name = cls.name ?? (isNew ? "" : cls.id);
  return (
    <li className="group/row flex flex-wrap items-center gap-2 py-1" data-testid="class-row" data-class={cls.id}>
      <ColorPicker value={cls.color} onChange={(color) => onChange({ color })} readOnly={readOnly} />
      <Input
        value={name}
        onChange={(e) => onChange({ name: e.target.value })}
        placeholder="Class name"
        aria-label="Class name"
        className="h-7 w-48"
        disabled={readOnly}
        autoFocus={isNew && !name}
        data-testid="class-name"
      />
      {!isNew && name !== cls.id && <code className="font-mono text-xs text-hint" title="Stored on annotations">{cls.id}</code>}
      <Input
        value={cls.hotkey ?? ""}
        onChange={(e) => onChange({ hotkey: e.target.value.trim().toLowerCase() })}
        placeholder="Key"
        aria-label={`Key for ${name || "this class"}`}
        aria-invalid={!!conflict}
        className={cn("h-7 w-20 font-mono", conflict && "border-danger")}
        disabled={readOnly}
        maxLength={16}
        data-testid="class-key"
      />
      {conflict && (
        <span className="flex items-center gap-1 text-sm text-danger" role="alert" data-testid="class-key-conflict">
          <WarningIcon className="size-3.5" /> {conflict}
        </span>
      )}
      {!readOnly && (
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <Button variant="ghost-secondary" size="icon-sm" disabled={first} onClick={() => onMove(-1)} aria-label="Move up" data-testid="class-up">
            <ChevronUpIcon />
          </Button>
          <Button variant="ghost-secondary" size="icon-sm" disabled={last} onClick={() => onMove(1)} aria-label="Move down" data-testid="class-down">
            <ChevronDownIcon />
          </Button>
          <Button variant="ghost-secondary" size="icon-sm" onClick={onRemove} aria-label={`Remove ${name || "class"}`} data-testid="class-remove">
            <DeleteIcon />
          </Button>
        </span>
      )}
    </li>
  );
}

const swatch = (color: string | undefined) => (color && /^chart-[1-5]$/.test(color) ? `hsl(var(--${color}))` : (color ?? "hsl(var(--chart-1))"));

function ColorPicker({ value, onChange, readOnly }: { value?: string; onChange: (c: string) => void; readOnly: boolean }) {
  const dot = useMemo(() => <span className="block size-3.5 rounded-full" style={{ background: swatch(value) }} />, [value]);
  if (readOnly) return <span className="grid size-7 place-content-center">{dot}</span>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost-secondary" size="icon" aria-label="Color" data-testid="class-color">
          {dot}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-auto gap-1.5 p-2" align="start">
        {CHART_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={`Color ${c.replace("chart-", "")}`}
            aria-pressed={value === c}
            className={cn("grid size-7 place-content-center rounded-md hover:bg-generic", value === c && "ring-2 ring-[var(--g-line-focus)]")}
          >
            <span className="block size-4 rounded-full" style={{ background: swatch(c) }} />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
