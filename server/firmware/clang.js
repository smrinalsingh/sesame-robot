// A tiny C/Arduino-subset -> JavaScript transpiler.
//
// It exists so the simulator runs the *same* movement code that gets flashed
// to the robot (firmware/movement-sequences.h and the dispatch in loop()),
// instead of a hand-maintained copy. It understands what that code actually
// uses: enums, const arrays, extern declarations, prototypes with default
// arguments, functions, local declarations, for/while/if, casts and Arduino
// helpers. Anything it doesn't understand raises a FirmwareSyntaxError with
// the file and line, so the simulator reports it instead of silently drifting.

export class FirmwareSyntaxError extends Error {
  constructor(msg, file, line) {
    super(`${file}:${line}: ${msg}`);
    this.file = file;
    this.line = line;
  }
}

const TYPE_WORDS = new Set([
  'void', 'int', 'long', 'short', 'unsigned', 'signed', 'char', 'bool', 'boolean', 'float', 'double',
  'String', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'size_t', 'byte', 'word', 'auto', 'FaceAnimMode', 'ServoName',
]);
const QUALIFIERS = new Set(['const', 'static', 'inline', 'volatile', 'constexpr', 'extern', 'PROGMEM']);
const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '->', '::', '<<', '>>', '|=', '&=', '^='];

export function tokenize(src, file = '<src>') {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end;
      continue;
    }
    if (c === '#') { // preprocessor line (with backslash continuations)
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') throw new FirmwareSyntaxError('unterminated string', file, line); j++; }
      toks.push({ t: 'str', v: src.slice(i, j + 1), line, quote: c });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = src.slice(i, i + 40).match(/^(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)([uUlLfF]*)/);
      toks.push({ t: 'num', v: m[1], line });
      i += m[0].length;
      continue;
    }
    const two = src.substr(i, 2);
    if (TWO_CHAR_OPS.includes(two)) { toks.push({ t: 'op', v: two, line }); i += 2; continue; }
    toks.push({ t: 'op', v: c, line });
    i++;
  }
  return toks;
}

const isOp = (tok, v) => tok && tok.t === 'op' && tok.v === v;
const isTypeish = (tok) => tok && tok.t === 'id' && (TYPE_WORDS.has(tok.v) || QUALIFIERS.has(tok.v));

// Index of the token that closes the bracket opened at `start`.
export function matchBracket(toks, start, file) {
  const open = toks[start].v;
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let k = start; k < toks.length; k++) {
    if (toks[k].t !== 'op') continue;
    if (toks[k].v === open) depth++;
    else if (toks[k].v === close) { depth--; if (depth === 0) return k; }
  }
  throw new FirmwareSyntaxError(`unbalanced '${open}'`, file, toks[start].line);
}

// Split tokens [a, b) on top-level commas.
function splitCommas(toks, a, b) {
  const parts = [];
  let depth = 0;
  let cur = [];
  for (let k = a; k < b; k++) {
    const t = toks[k];
    if (t.t === 'op' && '([{'.includes(t.v)) depth++;
    if (t.t === 'op' && ')]}'.includes(t.v)) depth--;
    if (depth === 0 && isOp(t, ',')) { parts.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function parseParams(toks, file) {
  // toks: tokens between the parentheses of a function signature.
  if (toks.length === 0 || (toks.length === 1 && toks[0].v === 'void')) return [];
  const all = toks;
  const params = [];
  for (const p of splitCommas(all, 0, all.length)) {
    const eq = p.findIndex((t) => isOp(t, '='));
    const decl = eq >= 0 ? p.slice(0, eq) : p;
    const ids = decl.filter((t) => t.t === 'id');
    if (!ids.length) throw new FirmwareSyntaxError('cannot read parameter', file, p[0]?.line ?? 0);
    params.push({ name: ids[ids.length - 1].v, def: eq >= 0 ? p.slice(eq + 1) : null });
  }
  return params;
}

/**
 * Turn a run of statement tokens into JavaScript.
 * ctx = { file, asyncFns:Set, globals:Set, consts:Set }
 */
export function emitStatements(toks, ctx) {
  const out = [];
  let lastLine = toks[0]?.line ?? 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (t.line > lastLine) { out.push('\n'); lastLine = t.line; }

    if (t.t === 'id') {
      // Cast: ( type ) expr  -> drop
      if (isOp(prev, '(') && TYPE_WORDS.has(t.v)) {
        let j = k;
        while (isTypeish(toks[j]) || isOp(toks[j], '*')) j++;
        if (isOp(toks[j], ')') && toks[j + 1] && (toks[j + 1].t !== 'op' || '(!-~'.includes(toks[j + 1].v))) {
          out.pop(); // the '('
          k = j; // skip through ')'
          continue;
        }
      }
      // Declaration: [qualifiers] type [*|&] name  -> let name
      if (isTypeish(t) && !isOp(next, '(') && !isOp(prev, '.')) {
        let j = k;
        while (isTypeish(toks[j]) || isOp(toks[j], '*') || isOp(toks[j], '&')) j++;
        if (toks[j] && toks[j].t === 'id' && !isOp(toks[j + 1], '(')) {
          if (isOp(toks[j + 1], '[')) throw new FirmwareSyntaxError('local arrays are not supported by the simulator', ctx.file, t.line);
          out.push('let ');
          k = j - 1;
          continue;
        }
        if (TYPE_WORDS.has(t.v) && t.v !== 'String') throw new FirmwareSyntaxError(`unexpected type '${t.v}'`, ctx.file, t.line);
      }
      if (t.v === 'F' && isOp(next, '(')) continue; // F("text") -> ("text")
      if (t.v === 'nullptr' || t.v === 'NULL') { out.push('null'); continue; }
      if (t.v === 'goto') throw new FirmwareSyntaxError('goto is not supported', ctx.file, t.line);
      if (isOp(prev, '.')) { out.push(t.v); continue; }
      if (ctx.asyncFns.has(t.v) && isOp(next, '(')) { out.push(`(await ${t.v}`); continue; }
      if (ctx.globals.has(t.v) && !isOp(next, '(')) { out.push(`G.${t.v}`); continue; }
      out.push(t.v);
      continue;
    }
    if (t.t === 'num') { out.push(t.v); continue; }
    if (t.t === 'str') { out.push(t.v); continue; }
    if (t.t === 'op') {
      if (t.v === '::') throw new FirmwareSyntaxError("'::' is not supported", ctx.file, t.line);
      if (t.v === '->') { out.push('.'); continue; }
      out.push(t.v);
      // close an `(await fn(...)` wrapper when its argument list ends
      if (t.v === ')' && ctx._awaitClose.has(k)) { out.push(')'); }
      continue;
    }
  }
  return out.join(' ');
}

// Pre-compute where each awaited call's argument list closes, so the emitted
// `(await f(args))` is parenthesised correctly (needed for `!f()` and `x = f()`).
function prepareAwaitClosers(toks, ctx) {
  ctx._awaitClose = new Set();
  for (let k = 0; k < toks.length - 1; k++) {
    const t = toks[k];
    if (t.t === 'id' && ctx.asyncFns.has(t.v) && isOp(toks[k + 1], '(') && !isOp(toks[k - 1], '.')) {
      ctx._awaitClose.add(matchBracket(toks, k + 1, ctx.file));
    }
  }
}

export function emitBlock(toks, ctx) {
  prepareAwaitClosers(toks, ctx);
  return emitStatements(toks, ctx);
}

/**
 * Parse a header made of top-level declarations (movement-sequences.h).
 * Returns { enums, consts, externVars, externFns, functions } where each
 * function is { name, params, bodyToks, line }.
 */
export function parseTopLevel(src, file) {
  const toks = tokenize(src, file);
  const res = { enums: [], consts: [], externVars: new Set(), externFns: new Set(), protoDefaults: new Map(), functions: [] };
  let k = 0;
  while (k < toks.length) {
    const t = toks[k];
    const start = k;
    if (isOp(t, ';')) { k++; continue; }

    if (t.t === 'id' && t.v === 'enum') {
      const open = toks.findIndex((x, i) => i > k && isOp(x, '{'));
      const close = matchBracket(toks, open, file);
      let val = -1;
      for (const part of splitCommas(toks, open + 1, close)) {
        if (!part.length) continue;
        const name = part[0].v;
        const eq = part.findIndex((x) => isOp(x, '='));
        val = eq >= 0 ? Number(part.slice(eq + 1).map((x) => x.v).join('')) : val + 1;
        res.enums.push({ name, value: val });
      }
      k = close + 1;
      if (isOp(toks[k], ';')) k++;
      continue;
    }

    if (t.t === 'id' && t.v === 'extern') {
      let j = k;
      while (j < toks.length && !isOp(toks[j], ';')) j++;
      const decl = toks.slice(k, j);
      const paren = decl.findIndex((x) => isOp(x, '('));
      if (paren > 0) res.externFns.add(decl[paren - 1].v);
      else {
        for (const part of splitCommas(decl, 0, decl.length)) {
          const ids = part.filter((x) => x.t === 'id' && !QUALIFIERS.has(x.v) && !TYPE_WORDS.has(x.v));
          if (ids.length) res.externVars.add(ids[ids.length - 1].v);
        }
      }
      k = j + 1;
      continue;
    }

    // Declarations / prototypes / definitions all start with qualifiers+type.
    if (!isTypeish(t)) throw new FirmwareSyntaxError(`unexpected '${t.v}' at top level`, file, t.line);
    let j = k;
    while (isTypeish(toks[j]) || isOp(toks[j], '*') || isOp(toks[j], '&')) j++;
    const nameTok = toks[j];
    if (!nameTok || nameTok.t !== 'id') throw new FirmwareSyntaxError('expected a name', file, t.line);

    if (isOp(toks[j + 1], '(')) {
      const pclose = matchBracket(toks, j + 1, file);
      const params = parseParams(toks.slice(j + 2, pclose), file);
      if (isOp(toks[pclose + 1], ';')) { // prototype: remember default args
        if (params.some((p) => p.def)) res.protoDefaults.set(nameTok.v, params);
        k = pclose + 2;
        continue;
      }
      if (!isOp(toks[pclose + 1], '{')) throw new FirmwareSyntaxError(`expected '{' after ${nameTok.v}(...)`, file, nameTok.line);
      const bclose = matchBracket(toks, pclose + 1, file);
      res.functions.push({ name: nameTok.v, params, bodyToks: toks.slice(pclose + 2, bclose), line: nameTok.line });
      k = bclose + 1;
      continue;
    }

    // Global variable / array: type name [ [] ] [= init] ;
    let e = j + 1;
    while (e < toks.length && !isOp(toks[e], ';')) e++;
    const decl = toks.slice(j, e);
    const eq = decl.findIndex((x) => isOp(x, '='));
    const init = eq >= 0 ? decl.slice(eq + 1) : null;
    res.consts.push({ name: nameTok.v, isArray: isOp(decl[1], '['), init, line: nameTok.line });
    k = e + 1;
    if (k === start) k++;
  }
  return res;
}

// Initializer tokens -> JS expression ({a,b} -> [a,b]).
export function emitInit(init) {
  return init.map((x) => (isOp(x, '{') ? '[' : isOp(x, '}') ? ']' : x.v)).join(' ');
}

export function emitFunction(fn, ctx) {
  const defaults = ctx.protoDefaults.get(fn.name);
  const params = fn.params.map((p, i) => {
    const def = p.def || defaults?.[i]?.def;
    return def ? `${p.name} = ${def.map((x) => x.v).join(' ')}` : p.name;
  });
  const body = emitBlock(fn.bodyToks, ctx);
  return `async function ${fn.name}(${params.join(', ')}) { /* ${ctx.file}:${fn.line} */\n${body}\n}`;
}
