/**
 * `when` clauses (VS Code style) decide where a tool, command or keybinding applies:
 *
 *   renderer.space == image2d && !drafting
 *   'playback' in renderer.capabilities || tool == brush
 *   selection.count > 0
 *
 * Operators, loosest first: `||`, `&&`, `!`, then comparisons `==` `!=` `<` `<=` `>` `>=`,
 * `in` / `not in` (membership in an array or object key) and `=~` (regex, /.../flags).
 * A bare word on the right of a comparison is a string literal; on the left (or alone)
 * it is a context key. Keys are dotted names looked up in a flat context object.
 * Parsed with a hand-written recursive-descent parser: never `eval`.
 */

export type { WhenContext } from "@studio/plugin-ui-sdk/resolved";
type WhenContext = import("@studio/plugin-ui-sdk/resolved").WhenContext;

type Node =
  | { t: "or" | "and"; a: Node; b: Node }
  | { t: "not"; a: Node }
  | { t: "cmp"; op: CmpOp; a: Operand; b: Operand }
  | { t: "truthy"; key: string }
  | { t: "lit"; v: boolean };
type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not in" | "=~";
type Operand = { key: string } | { lit: unknown };

export class WhenSyntaxError extends Error {}

const TOKEN = /\s*(\(|\)|&&|\|\||==|!=|<=|>=|=~|<|>|!|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)+\/[a-z]*|[A-Za-z0-9_.:\-@/]+)/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) throw new WhenSyntaxError(`Unexpected character at ${i} in "${src}"`);
    out.push(m[1]);
    i = TOKEN.lastIndex;
  }
  return out;
}

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (want?: string) => {
    const t = toks[p++];
    if (want !== undefined && t !== want) throw new WhenSyntaxError(`Expected "${want}" but found "${t ?? "end"}" in "${src}"`);
    return t;
  };
  const isWord = (t: string | undefined) => !!t && /^[A-Za-z0-9_.:\-@/]+$/.test(t) && !/^\/.+\/[a-z]*$/.test(t);

  const operand = (rhs: boolean): Operand => {
    const t = take();
    if (t === undefined) throw new WhenSyntaxError(`Unexpected end of "${src}"`);
    if (t[0] === "'" || t[0] === '"') return { lit: t.slice(1, -1).replace(/\\(.)/g, "$1") };
    if (/^\/.+\/[a-z]*$/.test(t)) {
      const end = t.lastIndexOf("/");
      return { lit: new RegExp(t.slice(1, end), t.slice(end + 1)) };
    }
    if (t === "true" || t === "false") return { lit: t === "true" };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { lit: Number(t) };
    if (!isWord(t)) throw new WhenSyntaxError(`Unexpected "${t}" in "${src}"`);
    return rhs ? { lit: t } : { key: t };
  };

  const primary = (): Node => {
    if (peek() === "(") {
      take("(");
      const n = or();
      take(")");
      return n;
    }
    if (peek() === "!") {
      take();
      return { t: "not", a: primary() };
    }
    const a = operand(false);
    let op = peek() as CmpOp | "not" | undefined;
    if (op === "not") {
      take();
      take("in");
      op = "not in";
    } else if (op && ["==", "!=", "<", "<=", ">", ">=", "in", "=~"].includes(op)) take();
    else op = undefined;
    if (!op) {
      if ("lit" in a) return { t: "lit", v: !!a.lit };
      return { t: "truthy", key: a.key };
    }
    // `x in key`: the right side names a context key holding the collection.
    const b = op === "in" || op === "not in" ? ({ key: take() } as Operand) : operand(true);
    return { t: "cmp", op: op as CmpOp, a, b };
  };
  const and = (): Node => {
    let n = primary();
    while (peek() === "&&") {
      take();
      n = { t: "and", a: n, b: primary() };
    }
    return n;
  };
  function or(): Node {
    let n = and();
    while (peek() === "||") {
      take();
      n = { t: "or", a: n, b: and() };
    }
    return n;
  }

  const n = or();
  if (p < toks.length) throw new WhenSyntaxError(`Unexpected "${toks[p]}" in "${src}"`);
  return n;
}

const cache = new Map<string, Node>();
function compiled(src: string): Node {
  let n = cache.get(src);
  if (!n) cache.set(src, (n = parse(src)));
  return n;
}

/** Throws WhenSyntaxError for an invalid clause; used by the resolver to report bad manifests. */
export function checkWhen(src: string): void {
  compiled(src);
}

/** Three-valued result: `undefined` means "depends on a key we don't know yet". */
type Tri = boolean | undefined;

function evaluate(n: Node, ctx: WhenContext, partial: boolean): Tri {
  const known = (key: string) => key in ctx || !partial;
  const val = (o: Operand) => ("lit" in o ? o.lit : ctx[o.key]);
  switch (n.t) {
    case "lit":
      return n.v;
    case "truthy":
      return known(n.key) ? truthy(ctx[n.key]) : undefined;
    case "not": {
      const a = evaluate(n.a, ctx, partial);
      return a === undefined ? undefined : !a;
    }
    case "and": {
      const a = evaluate(n.a, ctx, partial);
      if (a === false) return false;
      const b = evaluate(n.b, ctx, partial);
      if (b === false) return false;
      return a === undefined || b === undefined ? undefined : true;
    }
    case "or": {
      const a = evaluate(n.a, ctx, partial);
      if (a === true) return true;
      const b = evaluate(n.b, ctx, partial);
      if (b === true) return true;
      return a === undefined || b === undefined ? undefined : false;
    }
    case "cmp": {
      if (("key" in n.a && !known(n.a.key)) || ("key" in n.b && !known(n.b.key))) return undefined;
      const a = val(n.a), b = val(n.b);
      switch (n.op) {
        case "==":
          return loose(a) === loose(b);
        case "!=":
          return loose(a) !== loose(b);
        case "<":
          return Number(a) < Number(b);
        case "<=":
          return Number(a) <= Number(b);
        case ">":
          return Number(a) > Number(b);
        case ">=":
          return Number(a) >= Number(b);
        case "=~":
          return b instanceof RegExp && typeof a === "string" && b.test(a);
        case "in":
        case "not in": {
          const has = Array.isArray(b) ? b.includes(a) : b instanceof Set ? b.has(a) : !!b && typeof b === "object" && String(a) in b;
          return n.op === "in" ? has : !has;
        }
      }
    }
  }
}

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);
/** `selection.count == 0` should match the number 0 and `flag == true` the boolean. */
const loose = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Evaluate a clause; an empty or missing clause is always true. */
export function when(src: string | undefined, ctx: WhenContext): boolean {
  if (!src) return true;
  return evaluate(compiled(src), ctx, false) === true;
}

/** True only when the known context alone already makes the clause true (no unknown keys involved). */
export function alwaysTrue(src: string | undefined, ctx: WhenContext): boolean {
  if (!src) return true;
  return evaluate(compiled(src), ctx, true) === true;
}

/**
 * Whether a clause *can* be true given only some of the context (e.g. the resolved
 * environment but not the live tool or selection). Unknown keys count as "maybe".
 */
export function mayBeTrue(src: string | undefined, ctx: WhenContext): boolean {
  if (!src) return true;
  return evaluate(compiled(src), ctx, true) !== false;
}
