// PreToolUse guard for the repo rules in AGENTS.md that an agent can break in one tool call.
// Reads the hook payload on stdin; prints a deny decision or `{}`. Never blocks on its own errors.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const allow = () => {
  process.stdout.write("{}\n");
  process.exit(0);
};
const deny = (reason) => {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`);
  process.exit(0);
};

let event;
try {
  event = JSON.parse(readFileSync(0, "utf8"));
} catch {
  allow();
}
const input = event.tool_input ?? {};
const cwd = event.cwd ?? process.cwd();
const repo = resolve(new URL("../..", import.meta.url).pathname);
const rel = (p) => relative(repo, isAbsolute(p) ? p : resolve(input.workdir ?? cwd, p));

// Files a tool is about to write, with the text it adds.
const writes = [];
for (const key of ["path", "file_path", "filePath"]) {
  if (typeof input[key] === "string" && !/^(read|view|ls|list|glob|grep|search)/i.test(event.tool_name ?? "")) {
    const text = [input.content, input.new_string, input.new_str, input.replacement, input.text].filter((t) => typeof t === "string").join("\n");
    writes.push({ file: rel(input[key]), text });
  }
}
for (const patch of [input.patch, input.input].filter((p) => typeof p === "string" && p.includes("*** "))) {
  let current;
  for (const line of patch.split("\n")) {
    const m = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/);
    if (m) writes.push((current = { file: rel(m[1].trim()), text: "" }));
    else if (current && line.startsWith("+")) current.text += `${line.slice(1)}\n`;
  }
}
const reads = typeof input.path === "string" && /^(read|view)/i.test(event.tool_name ?? "") ? [rel(input.path)] : [];
const command = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";

// Generated files are rebuilt by `pnpm regen`, never edited by hand.
const GENERATED = [/^schemas\/[^/]+\.json$/, /^schemas\/catalog\.md$/, /^docs\/modules-reference\.md$/, /^registry\/index\.json$/];
for (const w of writes) {
  if (GENERATED.some((g) => g.test(w.file))) deny(`${w.file} is generated. Change its source and run \`pnpm regen\` instead.`);
}

// The display name and past namespaces appear in code only in packages/contracts/src/naming.ts
// (same scope and pattern as tools/check-boundaries.mjs).
const namingFile = join(repo, "schemas/naming.json");
if (existsSync(namingFile)) {
  const naming = JSON.parse(readFileSync(namingFile, "utf8"));
  const words = [naming.displayName, ...(naming.legacyNamespaces ?? [])]
    .flatMap((w) => [w.toLowerCase(), w[0].toUpperCase() + w.slice(1).toLowerCase(), w.toUpperCase()])
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const brand = new RegExp(`(?:(?<![A-Za-z])|(?<=[a-z]))(?:${[...new Set(words)].join("|")})(?![a-z])`);
  const roots = ["apps/web/src/", "apps/web/dev/", "apps/web/scripts/", "apps/agent/src/", "apps/agent/scripts/", "apps/agent/test/", "apps/mcp/src/", "packages/", "plugins/", "tools/"];
  const exempt = (f) => f.endsWith("contracts/src/naming.ts") || f === "tools/check-boundaries.mjs" || f.includes("__fixtures__") || f.includes("/_generated/") || f.includes("/node_modules/");
  for (const w of writes) {
    if (!/\.(tsx?|mjs)$/.test(w.file) || w.file.endsWith(".d.ts") || !roots.some((r) => w.file.startsWith(r)) || exempt(w.file)) continue;
    const hit = w.text.split("\n").find((line) => !/^\s*(\/\/|\/?\*)/.test(line) && brand.test(line));
    if (hit) deny(`${w.file}: the product name or a past namespace in code (\`${hit.trim().slice(0, 80)}\`). Use NAMING, ns() or NS from @studio/contracts.`);
  }
}

// Secret files stay out of the model's context: load them into a process, never print them.
const SECRET = /(^|[\s"'=/])secrets\/(?!README\.md|[^\s"']*\.example)[^\s"'|;&>]+/;
const isSecret = (f) => /^secrets\//.test(f) && !/^secrets\/(README\.md|.*\.example)$/.test(f);
for (const f of reads) if (isSecret(f)) deny(`${f} holds credentials. Load it into the process that needs it (\`set -a; . ${f}\`) instead of reading it.`);
if (SECRET.test(command) && /(^|[\s|;&(])(cat|head|tail|less|more|bat|grep|rg|sed|awk|strings|xxd|od|cp|base64)\s/.test(command)) {
  deny("That command would print a secrets file into the conversation. Source it into the process that needs it instead.");
}

// Parallel work: the main checkout's branch belongs to whoever is using it.
const inWorktree = (dir) => dir.includes("/.worktrees/");
if (/(^|[\s;&|(])git\s+(-C\s+\S+\s+)?(switch|checkout)\b/.test(command) && !/\bgit\s+(-C\s+\S+\s+)?checkout\s+(\S+\s+)?--\s/.test(command)) {
  const dir = input.workdir ?? cwd;
  if (!inWorktree(dir) && !/\.worktrees\//.test(command)) {
    deny("Don't switch branches in the shared checkout. Use your own worktree: `git worktree add .worktrees/<branch> -b <branch>`. To restore a file, use `git restore <path>`.");
  }
}

allow();
