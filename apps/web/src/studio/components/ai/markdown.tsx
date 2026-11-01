import { Fragment, type ReactNode } from "react";
import { cn } from "@studio/ui/utils";
import { CopyButton } from "./copy-button";

/**
 * Small markdown renderer for model output: paragraphs, headings, lists, quotes,
 * code, tables, bold/italic/code/links. Builds React elements (never HTML
 * strings), so model text can't inject markup, and tolerates half-streamed input.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn("space-y-3 break-words text-body", className)}>{blocks(text)}</div>;
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
        <div key={key()} className="relative">
          <pre className="rounded-lg bg-code-well py-3 pr-10 pl-3.5 font-mono text-code break-words whitespace-pre-wrap text-complementary">
            <code>{body.join("\n")}</code>
          </pre>
          <CopyButton text={body.join("\n")} label="Copy code" className="absolute top-2 right-2 bg-code-well" />
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(
        <p key={key()} className={cn("font-semibold", level <= 2 ? "text-body-3 not-first:pt-1" : "not-first:pt-0.5")}>
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
        <div key={key()} className="overflow-x-auto rounded-lg border border-border bg-background">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-generic">{head.map((c, j) => <th key={j} className="px-3 py-2 font-semibold">{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k} className="border-t border-border">{r.map((c, j) => <td key={j} className="px-3 py-2 align-top">{inline(c)}</td>)}</tr>
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
    if (p.startsWith("`")) return <code key={i} className="rounded-xs bg-generic px-1 py-px font-mono text-code text-code-inline">{p.slice(1, -1)}</code>;
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
