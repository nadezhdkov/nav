/**
 * Flow expressions (spec §6.2.2), `${{ … }}`. Deliberately small and evaluated without `eval`:
 * a path (`nodes.verify.outputs.passed`, `params.max_fix_iterations`, `project.autonomy_level`),
 * a literal (number, 'string', true, false, null), or two of them compared with
 * `<`, `<=`, `>`, `>=`, `==`, `!=`. A leading `!` negates the result.
 */

export class ExprError extends Error {}

export const ROOTS = ["nodes", "params", "project", "trigger", "repo"] as const;

type Operand = { kind: "path"; path: string[] } | { kind: "literal"; value: unknown };
export type Expr = { negate: boolean; left: Operand; op?: Op; right?: Operand };
type Op = "<" | "<=" | ">" | ">=" | "==" | "!=";

const WRAPPED = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/;
const TOKEN = /\s*(<=|>=|==|!=|<|>|!|'[^']*'|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/y;

/** True for `${{ … }}`; anything else is a plain value. */
export function isExpression(text: string): boolean {
  return WRAPPED.test(text.trim());
}

export function parseExpr(text: string): Expr {
  const m = WRAPPED.exec(text.trim());
  if (!m) throw new ExprError(`not an expression: ${JSON.stringify(text)} (expected \${{ … }})`);
  const body = m[1]!;
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < body.length) {
    const start = TOKEN.lastIndex;
    const t = TOKEN.exec(body);
    if (!t) {
      if (/^\s*$/.test(body.slice(start))) break;
      throw new ExprError(`unexpected ${JSON.stringify(body.slice(start).trim())} in ${JSON.stringify(text)}`);
    }
    tokens.push(t[1]!);
  }
  let i = 0;
  const negate = tokens[0] === "!";
  if (negate) i++;
  const left = operand(tokens[i++], text);
  if (i === tokens.length) return { negate, left };
  const op = tokens[i++] as Op;
  if (!["<", "<=", ">", ">=", "==", "!="].includes(op)) throw new ExprError(`expected a comparison in ${JSON.stringify(text)}`);
  const right = operand(tokens[i++], text);
  if (i !== tokens.length) throw new ExprError(`too many terms in ${JSON.stringify(text)}`);
  return { negate, left, op, right };
}

function operand(token: string | undefined, text: string): Operand {
  if (token === undefined) throw new ExprError(`incomplete expression ${JSON.stringify(text)}`);
  if (token.startsWith("'")) return { kind: "literal", value: token.slice(1, -1) };
  if (/^-?\d/.test(token)) return { kind: "literal", value: Number(token) };
  if (token === "true" || token === "false") return { kind: "literal", value: token === "true" };
  if (token === "null") return { kind: "literal", value: null };
  const path = token.split(".");
  if (!(ROOTS as readonly string[]).includes(path[0]!)) {
    throw new ExprError(`unknown name ${JSON.stringify(path[0])} in ${JSON.stringify(text)}; use one of ${ROOTS.join(", ")}`);
  }
  return { kind: "path", path };
}

/** Paths an expression reads, for validation (e.g. that `nodes.<id>` exists). */
export function exprPaths(expr: Expr): string[][] {
  return [expr.left, expr.right].flatMap((o) => (o?.kind === "path" ? [o.path] : []));
}

export type Scope = Record<string, unknown>;

/** The value of a single-operand expression, or the result of a comparison. */
export function evaluate(expr: Expr, scope: Scope): unknown {
  const left = resolve(expr.left, scope);
  if (!expr.op) return expr.negate ? !left : left;
  const right = resolve(expr.right!, scope);
  let result: boolean;
  switch (expr.op) {
    case "==":
      result = left === right;
      break;
    case "!=":
      result = left !== right;
      break;
    default: {
      if (typeof left !== "number" || typeof right !== "number") {
        result = false;
        break;
      }
      result = expr.op === "<" ? left < right : expr.op === "<=" ? left <= right : expr.op === ">" ? left > right : left >= right;
    }
  }
  return expr.negate ? !result : result;
}

export function truthy(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function resolve(o: Operand, scope: Scope): unknown {
  if (o.kind === "literal") return o.value;
  let value: unknown = scope;
  for (const key of o.path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
