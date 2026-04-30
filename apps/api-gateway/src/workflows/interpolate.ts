/**
 * Parameter interpolation for node params.
 *
 * Node params may contain `{{jexl.expression}}` placeholders. At dispatch
 * time we walk the params object and replace any string that contains such a
 * placeholder with the evaluated value. The evaluator sees a context that
 * merges:
 *   • upstream outputs keyed by upstream node id  (e.g. {{nodes.foo.out}})
 *   • inputs the executor received                (e.g. {{in}}, {{in.q}})
 *   • run-level context                            (e.g. {{context.active_project_id}})
 *   • run.input                                    (e.g. {{input.q}})
 *
 * JEXL is sandboxed — no access to globals, `Function`, etc. — so user-
 * defined transform expressions can't execute arbitrary JS.
 */

// jexl v2 exports a pre-constructed Jexl instance as default.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jexl: {
  evalSync: (expr: string, ctx: Record<string, any>) => any;
  addTransform: (name: string, fn: (value: any, ...args: any[]) => any) => void;
} = require('jexl');

// JEXL reserves `in` as a binary operator, so `inputs.in` won't parse. We
// never expose a top-level `in` key; users reference the default port via
// `value` (shortcut) or `inputs["in"]` (bracketed). Transforms below give
// people the common missing helpers without opening a full stdlib.
jexl.addTransform('length', (v: any) => {
  if (v == null) return 0;
  if (Array.isArray(v) || typeof v === 'string') return v.length;
  if (typeof v === 'object') return Object.keys(v).length;
  return 0;
});
jexl.addTransform('json', (v: any) => {
  try { return JSON.stringify(v); } catch { return String(v); }
});
jexl.addTransform('keys', (v: any) => (v && typeof v === 'object' ? Object.keys(v) : []));
jexl.addTransform('lower', (v: any) => String(v).toLowerCase());
jexl.addTransform('upper', (v: any) => String(v).toUpperCase());

const MUSTACHE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Build the expression context shared across interpolate() and transform/branch nodes.
 *
 *  Available identifiers inside `{{…}}` and in JEXL expressions:
 *    • value              — convenience alias for the default "in" port.
 *    • inputs             — full map keyed by to_port; use bracket syntax for "in"
 *                           (e.g. `inputs["in"]`) because JEXL reserves the bareword.
 *    • nodes.<id>.<port>  — outputs from any already-executed upstream node.
 *    • input              — the run's original input payload.
 *    • context            — the run's context (active_project_id, trace_id, …).
 *
 *  Transforms registered on jexl: `| length`, `| json`, `| keys`, `| lower`, `| upper`.
 */
export function buildJexlContext(params: {
  inputs: Record<string, any>;
  nodes: Record<string, Record<string, any>>;
  run_input: any;
  run_context: Record<string, any>;
}) {
  return {
    value: params.inputs?.in,
    inputs: params.inputs,
    nodes: params.nodes,
    input: params.run_input,
    context: params.run_context,
  };
}

/**
 * Replace {{…}} placeholders in a string. If the whole string is a single
 * placeholder, preserve the evaluated value's type (numbers, objects, etc.)
 * — otherwise concatenate as strings.
 */
function interpolateString(s: string, ctx: Record<string, any>): any {
  const matches = [...s.matchAll(MUSTACHE_RE)];
  if (matches.length === 0) return s;
  // Whole-string placeholder → preserve type
  const whole = s.trim().match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (whole) {
    try { return jexl.evalSync(whole[1], ctx); }
    catch { return undefined; }
  }
  return s.replace(MUSTACHE_RE, (_full, expr: string) => {
    try {
      const v = jexl.evalSync(expr.trim(), ctx);
      return v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
    } catch {
      return '';
    }
  });
}

/** Recursively interpolate any string leaves of a value. Arrays + objects
 *  are cloned; primitives are passed through; strings are expanded. */
export function interpolateDeep<T>(value: T, ctx: Record<string, any>): T {
  if (value == null) return value;
  if (typeof value === 'string') return interpolateString(value, ctx) as any;
  if (Array.isArray(value)) return value.map(v => interpolateDeep(v, ctx)) as any;
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      out[k] = interpolateDeep(v, ctx);
    }
    return out as any;
  }
  return value;
}

/** Evaluate a JEXL expression and return a boolean coercion. */
export function evalBool(expr: string, ctx: Record<string, any>): boolean {
  try {
    const v = jexl.evalSync(expr, ctx);
    return Boolean(v);
  } catch {
    return false;
  }
}

/** Evaluate a JEXL expression and return the raw value. */
export function evalExpr(expr: string, ctx: Record<string, any>): any {
  try { return jexl.evalSync(expr, ctx); }
  catch { return undefined; }
}
