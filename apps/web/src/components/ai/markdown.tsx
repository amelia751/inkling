import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Small markdown renderer for model output: paragraphs, headings, lists, quotes,
 * code, tables, bold/italic/code/links. Builds React elements (never HTML
 * strings), so model text can't inject markup, and tolerates half-streamed input.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn("space-y-2 break-words text-body", className)}>{blocks(text)}</div>;
}

function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key()} className="overflow-x-auto rounded-lg bg-generic px-3 py-2 font-mono text-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(
        <p key={key()} className={cn("font-semibold", level === 1 ? "text-body-3 mt-1" : level === 2 ? "text-body-2 mt-1" : "text-body")}>
          {inline(heading[2])}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push(<hr key={key()} className="border-border" />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key()} className="border-l-2 border-border pl-3 text-muted-foreground">
          {blocks(body.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(
        <div key={key()} className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border text-muted-foreground">{head.map((c, j) => <th key={j} className="py-1 pr-3 font-normal">{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k} className="border-b border-border last:border-0">{r.map((c, j) => <td key={j} className="py-1 pr-3 align-top">{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /\d/.test(listItem.exec(line)![2]);
      const items: { text: string; nested: string[] }[] = [];
      while (i < lines.length) {
        const m = listItem.exec(lines[i]);
        if (m && m[1].length < 2) {
          items.push({ text: m[3], nested: [] });
          i++;
        } else if (items.length && (/^\s{2,}\S/.test(lines[i]) || (m && m[1].length >= 2))) {
          items[items.length - 1].nested.push(lines[i].replace(/^\s{2,4}/, ""));
          i++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key()} className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc", "marker:text-hint")}>
          {items.map((it, j) => (
            <li key={j}>
              {inline(it.text)}
              {it.nested.length > 0 && <div className="mt-1">{blocks(it.nested.join("\n"))}</div>}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p key={key()}>{inline(para.join(" "))}</p>);
  }
  return out;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode {
  const parts = text.split(INLINE);
  return parts.map((p, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
    if (p.startsWith("`")) return <code key={i} className="rounded-xs bg-generic px-1 py-px font-mono text-code">{p.slice(1, -1)}</code>;
    if (p.startsWith("**") || p.startsWith("__")) return <strong key={i} className="font-semibold">{inline(p.slice(2, -2))}</strong>;
    if (p.startsWith("[")) {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p)!;
      const safe = /^https?:\/\//i.test(m[2]);
      return safe ? (
        <a key={i} href={m[2]} target="_blank" rel="noreferrer noopener" className="text-brand underline-offset-2 hover:underline">{m[1]}</a>
      ) : (
        <Fragment key={i}>{m[1]}</Fragment>
      );
    }
    return <em key={i}>{inline(p.slice(1, -1))}</em>;
  });
}
