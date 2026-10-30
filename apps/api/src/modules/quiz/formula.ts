/**
 * Safe arithmetic formulas for calculated questions (Moodle-compatible syntax), evaluated by a
 * small recursive-descent parser: no `eval`, no property access, bounded length and depth.
 *
 *   {x} + {y}^2 * sqrt({z}) / pi()        variables are written {name}
 *
 * Operators: + - * / % ^ ** (power, right-associative), unary minus/plus, parentheses.
 * Functions: abs acos acosh asin asinh atan atan2 atanh ceil cos cosh deg2rad exp expm1 floor
 * fmod is_finite is_infinite is_nan log (natural, or log(x, base)) log10 log1p max min pi pow
 * rad2deg round (round(x) or round(x, decimals)) sin sinh sqrt tan tanh.
 */

export class FormulaError extends Error {}

const MAX_LENGTH = 1000;
const MAX_DEPTH = 64;

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number }> = {
  abs: { arity: [1, 1], fn: Math.abs },
  acos: { arity: [1, 1], fn: Math.acos },
  acosh: { arity: [1, 1], fn: Math.acosh },
  asin: { arity: [1, 1], fn: Math.asin },
  asinh: { arity: [1, 1], fn: Math.asinh },
  atan: { arity: [1, 1], fn: Math.atan },
  atan2: { arity: [2, 2], fn: Math.atan2 },
  atanh: { arity: [1, 1], fn: Math.atanh },
  ceil: { arity: [1, 1], fn: Math.ceil },
  cos: { arity: [1, 1], fn: Math.cos },
  cosh: { arity: [1, 1], fn: Math.cosh },
  deg2rad: { arity: [1, 1], fn: (x) => (x * Math.PI) / 180 },
  exp: { arity: [1, 1], fn: Math.exp },
  expm1: { arity: [1, 1], fn: Math.expm1 },
  floor: { arity: [1, 1], fn: Math.floor },
  fmod: { arity: [2, 2], fn: (a, b) => a % b },
  is_finite: { arity: [1, 1], fn: (x) => (Number.isFinite(x) ? 1 : 0) },
  is_infinite: { arity: [1, 1], fn: (x) => (x === Infinity || x === -Infinity ? 1 : 0) },
  is_nan: { arity: [1, 1], fn: (x) => (Number.isNaN(x) ? 1 : 0) },
  log: { arity: [1, 2], fn: (x, base) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base)) },
  log10: { arity: [1, 1], fn: Math.log10 },
  log1p: { arity: [1, 1], fn: Math.log1p },
  max: { arity: [1, 50], fn: Math.max },
  min: { arity: [1, 50], fn: Math.min },
  pi: { arity: [0, 0], fn: () => Math.PI },
  pow: { arity: [2, 2], fn: Math.pow },
  rad2deg: { arity: [1, 1], fn: (x) => (x * 180) / Math.PI },
  round: { arity: [1, 2], fn: (x, d) => roundTo(x, d ?? 0) },
  sin: { arity: [1, 1], fn: Math.sin },
  sinh: { arity: [1, 1], fn: Math.sinh },
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  tan: { arity: [1, 1], fn: Math.tan },
  tanh: { arity: [1, 1], fn: Math.tanh },
};

/** Rounds half away from zero to `decimals` places (like PHP's round, which Moodle uses). */
export function roundTo(x: number, decimals: number) {
  const d = Math.max(-10, Math.min(15, Math.trunc(decimals)));
  const f = 10 ** d;
  // Pre-round to 15 significant digits so 1.005 × 100 (= 100.49999…) rounds up, as PHP does.
  return (Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(15)))) / f;
}

type Token = { t: "num"; v: number } | { t: "var"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  if (src.length > MAX_LENGTH) throw new FormulaError("Formula is too long");
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if (c === "{") {
      const end = src.indexOf("}", i);
      const name = end < 0 ? "" : src.slice(i + 1, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new FormulaError(`Invalid variable at position ${i + 1}`);
      out.push({ t: "var", v: name });
      i = end + 1;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    if (src.startsWith("**", i)) {
      out.push({ t: "op", v: "^" });
      i += 2;
      continue;
    }
    if ("+-*/%^(),".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected "${c}" at position ${i + 1}`);
  }
  return out;
}

/** Evaluates `formula` with the given variable values. Throws FormulaError on syntax errors or unknown names. */
export function evaluate(formula: string, vars: Record<string, number>): number {
  const tokens = tokenize(formula);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"`);
    pos++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new FormulaError("Formula is nested too deeply");
  };

  // expr := term (('+'|'-') term)*
  const expr = (): number => {
    enter();
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = tokens[pos++]!.v;
      const rhs = term();
      v = op === "+" ? v + rhs : v - rhs;
    }
    depth--;
    return v;
  };
  // term := unary (('*'|'/'|'%') unary)*
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = tokens[pos++]!.v;
      const rhs = unary();
      v = op === "*" ? v * rhs : op === "/" ? v / rhs : v % rhs;
    }
    return v;
  };
  // unary := ('-'|'+') unary | power   (so -2^2 = -4, as in PHP/Moodle)
  const unary = (): number => {
    if (isOp("-") || isOp("+")) {
      const negate = tokens[pos++]!.v === "-";
      const v = unary();
      return negate ? -v : v;
    }
    return power();
  };
  // power := atom ('^' unary)?   right-associative
  const power = (): number => {
    const base = atom();
    if (isOp("^")) {
      pos++;
      enter();
      const e = unary();
      depth--;
      return Math.pow(base, e);
    }
    return base;
  };
  const atom = (): number => {
    const tok = tokens[pos++];
    if (!tok) throw new FormulaError("Unexpected end of formula");
    if (tok.t === "num") return tok.v;
    if (tok.t === "var") {
      if (!(tok.v in vars)) throw new FormulaError(`Unknown variable {${tok.v}}`);
      return vars[tok.v]!;
    }
    if (tok.t === "op" && tok.v === "(") {
      const v = expr();
      expectOp(")");
      return v;
    }
    if (tok.t === "id") {
      const f = FUNCTIONS[tok.v];
      if (!f) throw new FormulaError(`Unknown function ${tok.v}`);
      expectOp("(");
      const args: number[] = [];
      if (!isOp(")")) {
        args.push(expr());
        while (isOp(",")) {
          pos++;
          args.push(expr());
        }
      }
      expectOp(")");
      if (args.length < f.arity[0] || args.length > f.arity[1]) throw new FormulaError(`Wrong number of arguments for ${tok.v}()`);
      return f.fn(...args);
    }
    throw new FormulaError(`Unexpected "${tok.v}"`);
  };

  const result = expr();
  if (pos < tokens.length) throw new FormulaError(`Unexpected "${tokens[pos]!.v}"`);
  return result;
}

/** Variable names used in a formula or text ({name} placeholders). */
export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g)].map((m) => m[1]!))];
}

/** Checks a formula's syntax against a set of variable names (evaluated with 1s). Returns an error message or null. */
export function checkFormula(formula: string, names: string[]): string | null {
  try {
    evaluate(formula, Object.fromEntries(names.map((n) => [n, 1])));
    return null;
  } catch (err) {
    return err instanceof FormulaError ? err.message : "Invalid formula";
  }
}
