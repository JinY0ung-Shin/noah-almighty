import { describe, expect, it } from "vitest";
import { MAX_AST_DEPTH, MAX_EXPR_CHAIN, MAX_EXPR_NESTING, WidgetIncomplete, WidgetSyntaxError, WidgetTooComplex, exprDepth, matchBracket, parseExpression } from "../src/shared/widget/expr.js";
import {
  Env,
  GLOBAL_NAMES,
  MAX_ALLOC,
  MAX_STEPS,
  WidgetBudgetError,
  dataSize,
  WidgetRuntimeError,
  createRuntime,
  evaluate,
  getMember,
  invokeHandler,
  resetBudget,
  sanitizeData,
  toStr,
} from "../src/shared/widget/interp.js";

// The expression language + sandbox. Cases ported from mirineereum's
// src/lib/genui/__tests__/run.ts (minus the features Noah dropped), plus the
// hardening Noah added: pre-allocation size checks, the allocation budget,
// bounded coercions and the nesting caps.

const ev = (src: string, env = new Env()) => evaluate(parseExpression(src), env, createRuntime());
const runtimeError = (src: string, env?: Env) => expect(() => ev(src, env)).toThrow(WidgetRuntimeError);

describe("widget expressions: literals and operators", () => {
  it("precedence & arithmetic", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ** 3 ** 2")).toBe(512);
    expect(ev("10 - 4 - 3")).toBe(3);
    expect(ev("7 % 4 + 8 / 2")).toBe(7);
    expect(ev("-3 + +'2'")).toBe(-1);
    expect(ev("1 < 2 === true")).toBe(true);
    expect(ev("1 + 2 + '3'")).toBe("33");
    expect(ev("'3' * '4'")).toBe(12);
    expect(ev("0.1 + 0.2 > 0.3")).toBe(true);
    expect(ev("1_000 + 0x10 + 1e2")).toBe(1116);
    expect(ev("5 & 3 | 8")).toBe(9);
    expect(ev("~5 + (8 >> 1) + (1 << 3) + (-8 >>> 28) + (5 ^ 1)")).toBe(~5 + 4 + 8 + 15 + 4);
    expect(ev("void 0")).toBe(undefined);
  });

  it("logical, nullish, ternary", () => {
    expect(ev("null ?? 'd'")).toBe("d");
    expect(ev("0 ?? 'd'")).toBe(0);
    expect(ev("0 || 'd'")).toBe("d");
    expect(ev("1 && 2 || 3")).toBe(2);
    expect(ev("false || null && x")).toBe(null);
    expect(ev("1 > 2 ? 'a' : 2 > 1 ? 'b' : 'c'")).toBe("b");
    expect(ev("true ? false ? 1 : 2 : 3")).toBe(2);
    expect(ev("!0 && !''")).toBe(true);
  });

  it("equality", () => {
    expect(ev("1 == '1'")).toBe(true);
    expect(ev("1 === '1'")).toBe(false);
    expect(ev("null == undefined")).toBe(true);
    expect(ev("null === undefined")).toBe(false);
    expect(ev("NaN !== NaN")).toBe(true);
    expect(ev("'a' != 'b'")).toBe(true);
    expect(ev("[1] == '1'")).toBe(true);
    expect(ev("[1] == [1]")).toBe(false);
    expect(ev("1 <= 1 && 2 >= 3")).toBe(false);
  });

  it("strings & templates", () => {
    expect(ev("`a${1 + 1}b${`n${'x'}`}c`")).toBe("a2bnxc");
    expect(ev("'it\\'s' + \"\\u00e9\" + '\\n'.length")).toBe("it'sé1");
    expect(ev("`${[1,2]}|${null}|${{}.x}`")).toBe("1,2|null|undefined");
    expect(ev("`line1\nline2`")).toBe("line1\nline2");
    expect(ev("`$5 and $`")).toBe("$5 and $");
    expect(ev("'\\x41\\u{1F600}\\t'")).toBe("A\u{1F600}\t");
  });

  it("arrays, objects, spread, computed keys, shorthand", () => {
    expect(ev("[1, ...[2, 3], ...'ab']")).toEqual([1, 2, 3, "a", "b"]);
    expect(ev("({a: 1, ...{b: 2}, ['c' + 1]: 3, 'd-e': 4})")).toEqual({ a: 1, b: 2, c1: 3, "d-e": 4 });
    const env = new Env();
    env.set("x", 5);
    expect(ev("({x, y: x * 2})", env)).toEqual({ x: 5, y: 10 });
    expect(ev("Math.max(...[1, 5, 3])")).toBe(5);
    expect(ev("[,1]")).toEqual([undefined, 1]);
    expect(ev("({m(a) { return a + 1 }}).m(1)")).toBe(2);
    expect(ev("({...'ab'})")).toEqual({ 0: "a", 1: "b" });
  });

  it("member access & optional chaining", () => {
    expect(ev("({a: {b: [10, 20]}}).a.b[1]")).toBe(20);
    expect(ev("null?.a.b.c")).toBe(undefined);
    expect(ev("({a: null}).a?.b")).toBe(undefined);
    expect(ev("({a: {f: () => 3}}).a?.f()")).toBe(3);
    expect(ev("({}).f?.()")).toBe(undefined);
    expect(ev("[1,2]?.[1]")).toBe(2);
    expect(ev("'abc'.length + [1,2,3].length")).toBe(6);
    expect(ev("'abc'[1]")).toBe("b");
    expect(ev("true?.5:1")).toBe(0.5);
    runtimeError("null.a");
    runtimeError("undefined.x");
    runtimeError("(1)()");
    runtimeError("({}).nope()");
  });

  it("arrow functions: params, defaults, destructuring, rest, block bodies", () => {
    expect(ev("[1,2,3].map(x => x * 2)")).toEqual([2, 4, 6]);
    expect(ev("[[1,'a'],[2,'b']].map(([n, s]) => s + n)")).toEqual(["a1", "b2"]);
    expect(ev("[{a:1,b:2}].map(({a, b: c = 9, z = 7}) => a + c + z)")).toEqual([10]);
    expect(ev("((a, b = a * 2, ...rest) => a + b + rest.length)(1, undefined, 3, 4)")).toBe(5);
    expect(ev("(() => { const a = 2; const [b] = [3]; return a * b })()")).toBe(6);
    expect(ev("(n => { if (n > 1) return 'big'; else return 'small' })(2)")).toBe("big");
    expect(ev("(() => { function sq(x) { return x * x } return sq(4) })()")).toBe(16);
    expect(ev("(() => {})()")).toBe(undefined);
    expect(ev("(x => (x, x + 1))(1)")).toBe(2);
    expect(ev("(() => ({a: 1}))()")).toEqual({ a: 1 });
    expect(ev("[1,2,3].reduce((s, v) => s + v, 0)")).toBe(6);
    expect(ev("(({a, ...rest}) => rest)({a: 1, b: 2, c: 3})")).toEqual({ b: 2, c: 3 });
    expect(ev("(([a, , ...r]) => r)([1, 2, 3, 4])")).toEqual([3, 4]);
    expect(ev("(function named(a) { { const b = a; return b + 1 } })(1)")).toBe(2);
  });
});

describe("widget expressions: allowlisted globals and methods", () => {
  it("globals", () => {
    expect(ev("Math.round(Math.PI * 100) / 100")).toBe(3.14);
    expect(ev("Number('12.5') + Number.parseInt('3px')")).toBe(15.5);
    expect(ev("Number.isFinite(1/0)")).toBe(false);
    expect(ev("Number() + Number(null) + Number(true)")).toBe(1);
    expect(ev("String(12).padStart(4, '0')")).toBe("0012");
    expect(ev("String() + String.fromCharCode(72, 105)")).toBe("Hi");
    expect(ev("Boolean('') || parseFloat('2.5')")).toBe(2.5);
    expect(ev("isNaN('x') && isFinite('3') && parseInt('ff', 16) === 255")).toBe(true);
    expect(ev("Array.isArray([]) && !Array.isArray('a')")).toBe(true);
    expect(ev("Array.from({length: 3}, (_, i) => i * i)")).toEqual([0, 1, 4]);
    expect(ev("Array.from('ab').concat(Array.from([1]), Array.of(2, 3), Array.from(5))")).toEqual(["a", "b", 1, 2, 3]);
    expect(ev("Object.entries({a: 1}).map(([k, v]) => k + v)")).toEqual(["a1"]);
    expect(ev("Object.fromEntries([['a', 1]])")).toEqual({ a: 1 });
    expect(ev("Object.keys({x: 1, y: 2}).concat(Object.values({z: 3}), Object.keys('str'))")).toEqual(["x", "y", 3]);
    expect(ev("Object.assign({a: 1}, {b: 2}, null)")).toEqual({ a: 1, b: 2 });
    expect(ev("JSON.stringify({a: [1, 'b']})")).toBe('{"a":[1,"b"]}');
    expect(ev("JSON.stringify({a: 1, b: 2}, ['a'], 2)")).toBe('{\n  "a": 1\n}');
    expect(ev("JSON.stringify(() => 1)")).toBe(undefined);
    expect(ev("JSON.parse('[1,2]')")).toEqual([1, 2]);
    expect(ev("typeof undeclaredThing")).toBe("undefined");
    expect(ev("typeof (() => 1)")).toBe("function");
    expect(ev("'k' in {k: 1}")).toBe(true);
    expect(ev("'length' in [1] && !('x' in {})")).toBe(true);
  });

  it("there is no Math.random, console, Date or host object", () => {
    expect(ev("Math.random")).toBe(undefined);
    expect(GLOBAL_NAMES).not.toContain("console");
    expect(GLOBAL_NAMES).not.toContain("Date");
    for (const name of ["console", "Date", "RegExp", "Intl", "Map", "Set", "Symbol", "Promise", "setTimeout", "fetch", "document"]) {
      runtimeError(name);
    }
  });

  it("number and boolean methods", () => {
    expect(ev("(1234.567).toFixed(1)")).toBe("1234.6");
    expect(ev("(1234567).toLocaleString('en-US')")).toBe("1,234,567");
    expect(ev("(0.5).toLocaleString('en-US', {style: 'percent'})")).toBe("50%");
    expect(ev("(1234.5).toLocaleString('not a locale!!')")).toBe((1234.5).toLocaleString());
    expect(ev("(255).toString(16) + (5).toString() + (1.25).toPrecision(2) + (3).valueOf()")).toBe("ff51.33");
    expect(ev("true.toString() + false.valueOf()")).toBe("truefalse");
  });

  it("string methods", () => {
    expect(ev("' Hi '.trim().toUpperCase().split('').reverse().join('-')")).toBe("I-H");
    expect(ev("'a-b-c'.replaceAll('-', '+').replace('+', '=')")).toBe("a=b+c");
    expect(ev("'abc'.replaceAll('', '-')")).toBe("-a-b-c-");
    expect(ev("'abc'.replace('', '-')")).toBe("-abc");
    expect(ev("'a.b'.replace('.', (m, at) => m + at)")).toBe("a.1b");
    expect(ev("'x'.replace('x', '$&$&')")).toBe("$&$&"); // patterns are not expanded
    expect(ev("'abc'.includes('b') && 'abc'.startsWith('b', 1) && 'abc'.endsWith('b', 2)")).toBe(true);
    expect(ev("'abcabc'.indexOf('c') + 'abcabc'.lastIndexOf('c')")).toBe(7);
    expect(ev("'a,b,c'.split(',', 2)")).toEqual(["a", "b"]);
    expect(ev("'abc'.split()")).toEqual(["abc"]);
    expect(ev("'ab'.repeat(2) + 'x'.padEnd(3, '-') + 'abc'.charAt(1) + 'abc'.at(-1)")).toBe("ababx--bc");
    expect(ev("'abc'.charCodeAt(0) + 'abc'.codePointAt(1)")).toBe(195);
    expect(ev("'abcdef'.substring(1, 3) + 'abcdef'.substr(4, 1) + 'abcdef'.slice(-1)")).toBe("bcef");
    expect(ev("'a'.concat('b', 1) + ' x '.trimStart() + ' y '.trimEnd()")).toBe("ab1x  y");
    expect(ev("'A'.toLowerCase() + 'a'.toLocaleUpperCase() + 'B'.toLocaleLowerCase()")).toBe("aAb");
    expect(ev("'a'.localeCompare('b') < 0 && 'a'.localeCompare('a', 'bad locale ~') === 0")).toBe(true);
    expect(ev("'é'.normalize('NFD').length")).toBe(2);
    runtimeError("'e'.normalize('nope')");
    expect(ev("'x'.toString() + 'y'.valueOf()")).toBe("xy");
  });

  it("array methods", () => {
    expect(ev("[3,1,2].toSorted((a, b) => a - b)")).toEqual([1, 2, 3]);
    expect(ev("[10, 9, 1, undefined].sort()")).toEqual([1, 10, 9, undefined]);
    expect(ev("[[1,[2]],[3]].flat(2)")).toEqual([1, 2, 3]);
    expect(ev("[[1,[2]],[3]].flat()")).toEqual([1, [2], 3]);
    expect(ev("[1,2,3].at(-1) + [1,2,3].indexOf(2) + [1,2].findIndex(x => x === 2)")).toBe(5);
    expect(ev("['a','b'].entries()")).toEqual([[0, "a"], [1, "b"]]);
    expect(ev("['a','b'].keys().concat(['a','b'].values())")).toEqual([0, 1, "a", "b"]);
    expect(ev("[1,2,3].some(x => x > 2) && [1,2,3].every(x => x > 0)")).toBe(true);
    expect(ev("[{n:1},{n:2}].find(o => o.n === 2).n")).toBe(2);
    expect(ev("[1,2,3].findLast(x => x < 3) + [1,2,3].findLastIndex(x => x < 3)")).toBe(3);
    expect(ev("[1,2,3].filter(x => x > 1).concat(4, [5])")).toEqual([2, 3, 4, 5]);
    expect(ev("[1,[2,3]].flatMap(x => x)")).toEqual([1, 2, 3]);
    expect(ev("[1,2,3].slice(1).reverse().join('')")).toBe("32");
    expect(ev("[1,2].toReversed().concat([1,2,3].fill(0, 1), [1,2,3].with(-1, 9))")).toEqual([2, 1, 1, 0, 0, 1, 2, 9]);
    expect(ev("[1,2,1].lastIndexOf(1) + [1,2,1].lastIndexOf(1, 1) + ([1].includes(1) ? 1 : 0)")).toBe(3);
    expect(ev("[1,2,3].reduceRight((s, v) => s + v, '')")).toBe("321");
    expect(ev("(() => { let n = 0; [1,2].forEach(() => 0); return [1, [2]].toString() })()")).toBe("1,2");
    runtimeError("[1].with(5, 0)");
    runtimeError("[1].map(1)");
  });

  it("sort/reverse/fill work on a copy", () => {
    const env = new Env();
    env.set("a", [3, 1, 2]);
    expect(ev("a.sort()", env)).toEqual([1, 2, 3]);
    expect(ev("a.reverse()", env)).toEqual([2, 1, 3]);
    expect(ev("a.fill(0)", env)).toEqual([0, 0, 0]);
    expect(env.lookup("a").value).toEqual([3, 1, 2]);
  });
});

describe("widget expressions: sandbox", () => {
  it("forbidden members are undefined; there is no way to a host function", () => {
    for (const src of [
      "({}).constructor",
      "[].constructor",
      "''.constructor",
      "(1).constructor",
      "(() => 1).constructor",
      "[].map.constructor",
      "Math.constructor",
      "({}).__proto__",
      "({})['__proto__']",
      "({})['constr' + 'uctor']",
      "[].map.call",
      "({}).hasOwnProperty",
      "({}).toString",
      "Object.prototype",
      "String.prototype",
      "(() => 1).name",
      "Math.max.bind",
    ]) {
      expect(ev(src), src).toBe(undefined);
    }
    for (const src of [
      "''.constructor.constructor('return 1')()",
      "globalThis",
      "window",
      "process",
      "Function('return 1')",
      "eval('1')",
      "require",
      "Date.now()",
    ]) {
      runtimeError(src);
    }
    expect(getMember({ constructor: 1 }, "constructor")).toBe(undefined);
  });

  it("the syntax has no assignment, loop, new, this or tagged template", () => {
    for (const src of ["this.x", "new Date()", "a = 1", "a += 1", "a++", "--a", "x => { while (true) {} }", "f`x`", "async () => 1", "class A {}", "1 instanceof Number"]) {
      expect(() => parseExpression(src), src).toThrow(WidgetSyntaxError);
    }
    expect(() => parseExpression("<text>x</text>")).toThrow(WidgetSyntaxError); // no JSX in expressions
    expect(() => parseExpression("/a+/.test('a')")).toThrow(WidgetSyntaxError); // no regex literal
  });

  it("__proto__ keys never change a prototype (5 ways)", () => {
    const literal = ev("({__proto__: {polluted: 1}})") as Record<string, unknown>;
    expect(Object.getPrototypeOf(literal)).toBe(Object.prototype);
    expect(ev("({__proto__: {polluted: 1}}).polluted")).toBe(undefined);
    const spread = ev("({...JSON.parse('{\"__proto__\":{\"x\":1}}')})") as Record<string, unknown>;
    expect(Object.getPrototypeOf(spread)).toBe(Object.prototype);
    expect(ev("Object.assign({}, JSON.parse('{\"__proto__\":{\"x\":1}}')).x")).toBe(undefined);
    expect(ev("Object.fromEntries([['__proto__', {x: 1}]]).x")).toBe(undefined);
    expect(({} as Record<string, unknown>).polluted).toBe(undefined);
    expect(({} as Record<string, unknown>).x).toBe(undefined);
  });

  it("incomplete input and syntax errors are told apart", () => {
    for (const src of ["[1, 2", "'abc", "`a${1", "1 +", "/* never closed"]) expect(() => parseExpression(src), src).toThrow(WidgetIncomplete);
    for (const src of ["1 + )", "1 2", "'a\nb'", "1abc", "#"]) expect(() => parseExpression(src), src).toThrow(WidgetSyntaxError);
  });
});

describe("widget expressions: limits", () => {
  it("step budget, call depth and sizes", () => {
    expect(() => ev("Array.from({length: 9000}, (_, i) => i).map(x => [x, x].map(y => y + 1).reduce((a, b) => a + b, 0))")).toThrow(WidgetBudgetError);
    const env = new Env();
    const rt = createRuntime();
    env.setLazy("f", () => evaluate(parseExpression("n => f(n + 1)"), env, rt));
    expect(() => evaluate(parseExpression("f(0)"), env, rt)).toThrow(WidgetRuntimeError);
    runtimeError("'x'.repeat(1e6)");
    runtimeError("Array.from({length: 1e7})");
    runtimeError("'ab'.padStart(1e9)");
    runtimeError("'ab'.padEnd(1e9)");
    runtimeError("f(...Array.from({length: 10000}), 1)", (() => {
      const e = new Env();
      e.set("f", ev("(...a) => a.length"));
      return e;
    })());
  });

  it("an event refills the budgets and restores the phase; a failing handler is reported, not thrown", () => {
    const rt = createRuntime();
    const fn = evaluate(parseExpression("() => [1, 2, 3].map(x => x * 2).length"), new Env(), rt);
    rt.steps = 0; // the render budget is spent
    expect(() => (fn as () => unknown)()).toThrow(WidgetBudgetError);
    const spent = rt.steps;
    expect(invokeHandler(rt, fn, [])).toEqual({ ok: true, value: 3 });
    expect(rt.phase).toBe("render");
    expect(rt.steps).toBe(spent); // the render window's own budget is untouched
    resetBudget(rt);
    const bad = evaluate(parseExpression("() => null.x"), new Env(), rt);
    const failed = invokeHandler(rt, bad, []);
    expect(failed.ok).toBe(false);
    expect(invokeHandler(rt, () => 1, [])).toEqual({ ok: false, error: "the handler is not a function" });
    resetBudget(rt);
    expect(rt.alloc).toBe(MAX_ALLOC);
  });

  it("a result that cannot fit is refused BEFORE it is built", () => {
    // Each of these would allocate far past the cap if the check ran afterwards.
    const env = new Env();
    env.set("big", new Array(10_000).fill(0));
    env.set("wide", new Array(10_000).fill(new Array(10_000).fill(0))); // 1e8 elements when flattened
    env.set("s", "x".repeat(100_000));
    const before = process.memoryUsage().heapUsed;
    runtimeError("wide.flat()", env);
    runtimeError("wide.flatMap(x => x)", env);
    runtimeError("big.concat(big)", env);
    runtimeError("[...big, ...big]", env);
    runtimeError("big.map(() => s).join('')", env);
    runtimeError("s.concat(s)", env);
    runtimeError("s + s", env);
    runtimeError("`${s}${s}`", env);
    runtimeError("s.replaceAll('x', s)", env);
    runtimeError("s.replaceAll('', 'yy')", env);
    runtimeError("s.split('')", env);
    runtimeError("Array.from(s)", env);
    runtimeError("JSON.stringify(wide)", env);
    runtimeError("JSON.stringify(big, null, 10)", env);
    runtimeError("String(wide)", env);
    runtimeError("wide.toString()", env);
    runtimeError("wide + ''", env);
    runtimeError("JSON.parse('[' + '0,'.repeat(20000) + '0]')", env);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200 * 1024 * 1024);
  });

  it("values that share sub-arrays cannot blow up through a native coercion", () => {
    // 40 doublings: 2^40 leaves if anything walked it natively.
    const env = new Env();
    env.set("dag", ev("Array.from({length: 40}).reduce((acc) => [acc, acc], ['leaf'])"));
    for (const src of [
      "String(dag)",
      "dag + ''",
      "`${dag}`",
      "dag.join('')",
      "[dag, dag].sort()",
      "Math.abs(dag)",
      "-dag",
      "Number(dag)",
      "parseInt(dag)",
      "isNaN(dag)",
      "({})[dag]",
      "'a'.includes(dag)",
      "[1].indexOf(1, dag)",
      "(1).toFixed(dag)",
      "(1).toLocaleString('en-US', {currency: dag})",
      "JSON.stringify(dag)",
      "dag.flat(10)",
      "Object.fromEntries([[dag, 1]])",
    ]) {
      const t0 = Date.now();
      try {
        ev(src, env);
      } catch (err) {
        expect(err, src).toBeInstanceOf(WidgetRuntimeError);
      }
      expect(Date.now() - t0, src).toBeLessThan(2000);
    }
    expect(() => sanitizeData(env.lookup("dag").value)).toThrow(WidgetRuntimeError);
    expect(() => toStr(env.lookup("dag").value)).toThrow(WidgetRuntimeError);
  });

  it("the allocation budget bounds total memory, not just one value", () => {
    // Each inner array is legal on its own (10k); together they would be 1e8 elements.
    expect(() => ev("Array.from({length: 10000}, () => Array.from({length: 10000}))")).toThrow(WidgetBudgetError);
    expect(() => ev("Array.from({length: 10000}, () => 'x'.repeat(100000))")).toThrow(WidgetBudgetError);
    // ...while an ordinary computation stays far inside it.
    const rt = createRuntime();
    evaluate(parseExpression("Array.from({length: 200}, (_, i) => ({ month: i, total: i * 1000 })).map(r => `${r.month}: ${r.total}`).join('\\n')"), new Env(), rt);
    expect(rt.alloc).toBeGreaterThan(MAX_ALLOC * 0.9);
  });

  it("a lazy binding that ran out of budget is evaluated again in the next window", () => {
    const env = new Env();
    const rt = createRuntime();
    env.setLazy("heavy", () => evaluate(parseExpression("Array.from({length: 2000}, (_, i) => i).reduce((a, b) => a + b, 0)"), env, rt));
    rt.steps = 10;
    expect(() => evaluate(parseExpression("heavy"), env, rt)).toThrow(WidgetBudgetError);
    resetBudget(rt);
    expect(evaluate(parseExpression("heavy"), env, rt)).toBe(1999000);
    // a cycle reads undefined instead of recursing
    env.setLazy("a", () => evaluate(parseExpression("b"), env, rt));
    env.setLazy("b", () => evaluate(parseExpression("a"), env, rt));
    expect(evaluate(parseExpression("a"), env, rt)).toBe(undefined);
    // an ordinary failure is cached as undefined
    env.setLazy("broken", () => evaluate(parseExpression("null.x"), env, rt));
    expect(evaluate(parseExpression("broken"), env, rt)).toBe(undefined);
  });

  it("expression nesting is capped with an explicit error (never a stack overflow)", () => {
    const deep = (n: number) => "(".repeat(n) + "1" + ")".repeat(n);
    expect(ev(deep(MAX_EXPR_NESTING - 2))).toBe(1);
    expect(() => parseExpression(deep(MAX_EXPR_NESTING + 5))).toThrow(/nested too deeply/);
    expect(() => parseExpression("!".repeat(5000) + "1")).toThrow(/nested too deeply/);
    expect(() => parseExpression("1" + " ** 1".repeat(5000))).toThrow(/nested too deeply/);
    expect(() => parseExpression("a => ".repeat(5000) + "1")).toThrow(/nested too deeply/);
    expect(() => parseExpression("[".repeat(5000) + "]".repeat(5000))).toThrow(/nested too deeply/);
    expect(() => parseExpression("(" + "{a:".repeat(5000) + "1" + "}".repeat(5000) + ")")).toThrow(/nested too deeply/);
    // a deeply nested template literal cannot recurse through the bracket matcher either
    expect(matchBracket("(" + "`${".repeat(5000) + "1" + "}`".repeat(5000) + ")", 0)).toBe(-1);
  });

  it("the parser charges a shared work budget", () => {
    const budget = { left: 50 };
    expect(() => parseExpression("[" + "1,".repeat(200) + "1]", { budget })).toThrow(WidgetTooComplex);
    const roomy = { left: 100_000 };
    parseExpression("((a) => (b) => (c) => a + b + c)(1)(2)(3)", { budget: roomy });
    expect(roomy.left).toBeLessThan(100_000);
    expect(roomy.left).toBeGreaterThan(99_000);
  });

  it("sanitizeData keeps JSON-like data only", () => {
    const fn = ev("() => 1");
    expect(sanitizeData({ a: [1, "x", true, null, undefined, fn], f: fn, n: { __proto__: 1 } })).toEqual({
      a: [1, "x", true, null, undefined, undefined],
      f: undefined,
      n: {},
    });
    expect(sanitizeData(new Date(0))).toBe(undefined);
    expect(() => sanitizeData(new Array(30_000).fill(0))).toThrow(WidgetRuntimeError);
    expect(toStr(fn)).toBe("[function]");
    expect(toStr({ a: 1 })).toBe("[object Object]");
  });
});

// Regressions from the adversarial review (2026-11-10): a step must cost
// what it really costs. Each case used to run for seconds or allocate
// hundreds of MB inside the step/alloc budgets; now it ends with a budget (or
// size) error, quickly.
describe("widget expressions: a step costs what it does", () => {
  /** Run `src` in `env`; report how it ended, how long it took and what it spent. */
  const spend = (src: string, env = new Env()) => {
    const rt = createRuntime();
    const t0 = performance.now();
    let error: unknown = null;
    let value: unknown;
    try {
      value = evaluate(parseExpression(src), env, rt);
    } catch (err) {
      error = err;
    }
    return { value, error, ms: performance.now() - t0, steps: MAX_STEPS - rt.steps, alloc: MAX_ALLOC - rt.alloc };
  };
  const env = () => {
    const e = new Env();
    e.set("natives", new Array(10_000).fill(ev("Array.isArray")));
    e.set("s", "a".repeat(100_000));
    e.set("big", ["x".repeat(49_990), "y".repeat(49_990)]);
    return e;
  };

  it("a native callback costs a step per call (nested forEach used to be free)", () => {
    // one pass over 10,000 natives: at least a step per call
    const one = spend("natives.forEach(Array.isArray)", env());
    expect(one.error).toBe(null);
    expect(one.steps).toBeGreaterThanOrEqual(10_000);
    // a method taken as a value pays the same way when it is called
    const e = env();
    e.set("f1", ev("natives.forEach", e));
    const nest2 = spend("f1(f1)", e); // 10^8 native calls without the fix
    expect(nest2.error).toBeInstanceOf(WidgetBudgetError);
    expect(nest2.ms).toBeLessThan(1000);
    e.set("f2", ev("natives.fill(f1).forEach", e));
    const nest3 = spend("f2(f1)", e); // 10^12
    expect(nest3.error).toBeInstanceOf(WidgetBudgetError);
    expect(nest3.ms).toBeLessThan(1000);
    // a host function as a callback is counted too (10,000 setter calls from one handler)
    const calls: unknown[] = [];
    const host = new Env();
    host.set("setX", ev("(v) => v")); // stands in for a host setter
    const flood = spend("Array.from({length: 10000}).fill(Array.from({length: 9999}).fill(1)).forEach(setX)", host);
    expect(flood.steps).toBeGreaterThanOrEqual(10_000);
    expect(calls).toEqual([]);
  });

  it("a method pays for the receiver it scans", () => {
    const e = env();
    e.set("few", [1, 2, 3]);
    const short = spend("few.includes(2)", e);
    const long = spend("natives.includes(2)", e);
    expect(long.steps - short.steps).toBeGreaterThanOrEqual(9); // 10,000 elements at 1,024 per step
    const str = spend("s.toUpperCase().length", env());
    expect(str.steps).toBeGreaterThanOrEqual(97); // 100,000 chars at 1,024 per step
  });

  it("the default sort and String(array) are charged for the strings they build", () => {
    const sorted = spend("Array.from({length: 10000}).fill(big).sort().length", env()); // 1 GB of keys without the fix
    expect(sorted.error).toBeInstanceOf(WidgetBudgetError);
    expect(sorted.ms).toBeLessThan(1000);
    for (const src of ["Array.from({length: 10000}).fill(big).map(String).length", "Array.from({length: 10000}).fill(big).map(x => x.toString()).length", "Array.from({length: 10000}).fill(big).map(x => `${x}`).length"]) {
      const r = spend(src, env());
      expect(r.error, src).toBeInstanceOf(WidgetBudgetError);
      expect(r.ms, src).toBeLessThan(1000);
    }
    // sorting long distinct strings pays for the comparisons before making them
    const e = env();
    e.set("rows", Array.from({ length: 10_000 }, (_, i) => "a".repeat(99_990) + String(i).padStart(5, "0")));
    const cmp = spend("rows.sort().length", e);
    expect(cmp.error).toBeInstanceOf(WidgetBudgetError);
    expect(cmp.ms).toBeLessThan(1000);
    // an ordinary sort is nowhere near any limit
    const fine = spend("Array.from({length: 500}, (_, i) => `row ${500 - i}`).sort()[0]");
    expect(fine.value).toBe("row 1");
    expect(fine.steps).toBeLessThan(5000);
  });

  it("spreading or destructuring a string never builds an oversized array", () => {
    const e = env();
    expect(spend("[...s].length", e).error).toBeInstanceOf(WidgetRuntimeError);
    expect(spend("Math.max(...s)", e).error).toBeInstanceOf(WidgetRuntimeError);
    expect(spend("(([...r]) => r.length)(s)", e).error).toBeInstanceOf(WidgetRuntimeError);
    // without a rest element only the items that are read are taken: no per-call 100,000-element array
    const heads = spend("Array.from({length: 5000}).fill(s).map(([a, b]) => a + b).length", e);
    expect(heads.error).toBe(null);
    expect(heads.value).toBe(5000);
    expect(heads.alloc).toBeLessThan(100_000);
    expect(ev("(([a, , c = 'z', d = 'none']) => a + c + d)('h\u{1F600}')")).toBe("hznone");
    expect(ev("(([a, ...rest]) => rest)('abc')")).toEqual(["b", "c"]);
    // an object rest copy is charged
    e.set("o", ev("Object.assign({}, 'x'.repeat(5000))"));
    const rest = spend("Array.from({length: 10000}).fill(o).map(({...r}) => r).length", e);
    expect(rest.error).toBeInstanceOf(WidgetBudgetError);
    // ...and so is a rest parameter
    expect(spend("Array.from({length: 10000}).map(() => ((...a) => a)(...natives)).length", e).error).toBeInstanceOf(WidgetBudgetError);
  });

  it("a search that the engine can make quadratic is paid for before it runs", () => {
    const e = env();
    e.set("tail", "a".repeat(50_000) + "b"); // lastIndexOf: O(n·m), 487 ms per call
    e.set("head", "b" + "a".repeat(50_000));
    for (const src of ["s.lastIndexOf(tail)", "s.indexOf(head)", "s.includes(head)", "s.split(head).length", "s.replace(head, '')", "s.replaceAll(head, '')"]) {
      const r = spend(src, e);
      expect(r.error, src).toBeInstanceOf(WidgetBudgetError);
      expect(r.ms, src).toBeLessThan(200);
    }
    // an array search with a long needle may compare it in full against every element
    e.set("hay", new Array(10_000).fill("a".repeat(99_999) + "b"));
    e.set("needle", "a".repeat(99_999) + "c");
    for (const src of ["hay.includes(needle)", "hay.indexOf(needle)", "hay.lastIndexOf(needle)"]) {
      const r = spend(src, e);
      expect(r.error, src).toBeInstanceOf(WidgetBudgetError);
      expect(r.ms, src).toBeLessThan(200);
    }
    // collation of long strings is charged by length
    const loc = spend("Array.from({length: 10000}).fill(s).map(x => x.localeCompare(s, 'ko', {sensitivity: 'base'})).length", e);
    expect(loc.error).toBeInstanceOf(WidgetBudgetError);
    expect(loc.ms).toBeLessThan(1500);
    // comparing two long strings is a scan
    e.set("s2", "a".repeat(99_999) + "b");
    const eq = spend("Array.from({length: 10000}).map(() => s == s2).length", e);
    expect(eq.error).toBeInstanceOf(WidgetBudgetError);
    // ordinary searches are cheap
    expect(spend("s.includes('needle') || s.indexOf('b') > 0 || s.split(',').length", e).steps).toBeLessThan(1500);
    expect(spend("'the quick brown fox'.includes('quick') && 'a,b'.split(',').length", e).steps).toBeLessThan(20);
    expect(ev("'a,b,c'.split(',').concat('a-b'.replace('-', '+'), 'xyz'.lastIndexOf('z'), 'ab'.localeCompare('b', 'en'))")).toEqual(["a", "b", "c", "a+b", 2, -1]);
  });

  it("coercing an array walks it, and the walk is paid for in steps", () => {
    const e = env();
    e.set("wide", new Array(10).fill(new Array(9999).fill("")));
    for (const src of ["Array.from({length: 9000}).fill(wide).map(x => x == 0).length", "Array.from({length: 10000}).fill(wide).every(isNaN) ? 1 : 0", "Array.from({length: 10000}).fill(wide).forEach(isNaN)"]) {
      const r = spend(src, e);
      expect(r.error, src).toBeInstanceOf(WidgetBudgetError);
      expect(r.ms, src).toBeLessThan(1500);
    }
    const once = spend("wide == 0", e);
    expect(once.steps).toBeGreaterThan(1000); // ~100,000 visits at 64 per step
  });

  it("JSON.stringify never lets a toJSON (or any function) reach the native serializer", () => {
    const e = new Env();
    e.set("dag", ev("Array.from({length: 27}).reduce((acc) => [acc, acc], 'xxxxxxxxxx')"));
    const r = spend("JSON.stringify({toJSON: () => dag, a: 1})", e);
    expect(r.error).toBe(null);
    expect(r.value).toBe('{"a":1}');
    expect(r.ms).toBeLessThan(200);
    expect(ev("JSON.stringify({a: [1, () => 2], f: Math.max, n: {toJSON: Object.keys}})")).toBe('{"a":[1,null],"n":{}}');
    expect(ev("JSON.stringify(JSON.parse('{\"__proto__\": {\"x\": 1}, \"k\": 2}'))")).toBe('{"k":2}');
    expect(spend("JSON.stringify(dag)", e).error).toBeInstanceOf(WidgetRuntimeError);
  });

  it("a string result that grew past the cap is refused (normalize, case mapping)", () => {
    expect(spend("'\\uFDFA'.repeat(100000).normalize('NFKD').length").error).toBeInstanceOf(WidgetRuntimeError); // 18x
    expect(spend("'\\u0390'.repeat(100000).toUpperCase().length").error).toBeInstanceOf(WidgetRuntimeError); // 3x
    expect(ev("'\\uFDFA'.normalize('NFKD').length")).toBe(18);
    expect(ev("'\\u0390'.toUpperCase().length")).toBe(3);
  });

  it("number formatting reuses its formatter and matches the native result", () => {
    expect(ev("(1234.5).toLocaleString('ko-KR', {style: 'currency', currency: 'KRW'})")).toBe((1234.5).toLocaleString("ko-KR", { style: "currency", currency: "KRW" }));
    expect(ev("(0.256).toLocaleString('en-US', {style: 'percent', maximumFractionDigits: 1})")).toBe("25.6%");
    expect(ev("(1234.5).toLocaleString()")).toBe((1234.5).toLocaleString());
    const many = spend("Array.from({length: 4000}).map((x, i) => i.toLocaleString('ko-KR', {style: 'currency', currency: 'KRW'})).length");
    expect(many.error).toBe(null);
    expect(many.ms).toBeLessThan(1000);
    // more distinct (locale, options) pairs than the cache holds still work
    expect(ev("Array.from({length: 80}, (_, i) => (1.5).toLocaleString('en-US', {minimumFractionDigits: i % 20})).length")).toBe(80);
  });

  it("a deep computation ends with a widget error, never a native stack overflow", () => {
    // the parser refuses what the interpreter could not walk
    const terms = (n: number) => Array.from({ length: n }, () => "1").join(" + ");
    expect(() => parseExpression(terms(1700))).toThrow(/too many chained operators \(limit 200\)/);
    expect(() => parseExpression("a" + "?.b".repeat(2000))).toThrow(/too many chained member accesses or calls \(limit 200\)/);
    expect(() => parseExpression("f" + "()".repeat(2000))).toThrow(/too many chained member accesses or calls/);
    expect(ev(terms(MAX_EXPR_CHAIN))).toBe(MAX_EXPR_CHAIN);
    // chains nested in brackets: the AST depth is capped on its own
    const nested = "(".repeat(40) + "1" + " + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1)".repeat(40);
    expect(() => parseExpression(nested)).toThrow(/too deeply nested \(limit 300 levels\)/);
    expect(exprDepth(parseExpression("[[1 + 2]]"))).toBe(4);
    expect(exprDepth(parseExpression("((a, [b = 1, {c = [2]}]) => { const d = [a]; if (d) return [[d]]; })"))).toBeLessThan(10);
    expect(MAX_AST_DEPTH).toBe(300);
    // recursion through a nested literal: 200 calls x 20 levels used to overflow before the call-depth cap
    const e = new Env();
    const rt = createRuntime();
    e.setLazy("f", () => evaluate(parseExpression("(n) => " + "[".repeat(20) + "f(n + 1)" + "]".repeat(20)), e, rt));
    let caught: unknown;
    try {
      evaluate(parseExpression("f(0)"), e, rt);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WidgetRuntimeError);
    expect((caught as Error).message).toBe("the computation is nested too deeply");
    expect(rt.nest).toBe(0); // unwound
    // from an event too
    resetBudget(rt);
    const res = invokeHandler(rt, evaluate(parseExpression("() => f(0)"), e, rt), []);
    expect(res).toEqual({ ok: false, error: "the computation is nested too deeply" });
    expect(rt.nest).toBe(0);
  });

  it("host code that runs after an evaluation is never charged to its runtime", () => {
    const rt = createRuntime();
    expect(() => evaluate(parseExpression("Array.from({length: 10000}).map(x => [x].map(y => y))"), new Env(), rt)).toThrow(WidgetBudgetError);
    expect(rt.steps).toBeLessThan(0);
    // these walk arrays the way the interpreter does; with a stale "active" runtime they threw a budget error
    expect(toStr([1, [2, 3]])).toBe("1,2,3");
    expect(sanitizeData({ a: [1, 2] })).toEqual({ a: [1, 2] });
    expect(invokeHandler(createRuntime(), evaluate(parseExpression("() => [1, 2].join('-')"), new Env(), createRuntime()), [])).toEqual({ ok: true, value: "1-2" });
  });

  it("sanitizeData bounds total characters and drops an own __proto__ key; dataSize measures without serializing", () => {
    const s = "x".repeat(100_000);
    // 20 references to one string: 20 nodes, 2,000,000 characters once serialized
    expect(() => sanitizeData(new Array(20).fill(s))).toThrow(/value is too large/);
    expect(sanitizeData(new Array(9).fill(s))).toHaveLength(9);
    expect(() => sanitizeData({ ["k".repeat(600_000)]: 1, ["j".repeat(600_000)]: 2 })).toThrow(/value is too large/);
    expect(() => sanitizeData(["abc", "def"], 100, 5)).toThrow(/value is too large/);
    const parsed = JSON.parse('{"mark":"bar","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"x":1}}}') as object;
    const clean = sanitizeData(parsed) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(clean)).toEqual(["mark", "constructor"]);
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
    // dataSize: about the JSON length, and it stops counting at the limit
    expect(dataSize({ a: [1, 22, "xyz"], b: true }, 1000)).toBeGreaterThanOrEqual(JSON.stringify({ a: [1, 22, "xyz"], b: true }).length - 4);
    expect(dataSize({ a: [1, 22, "xyz"], b: true }, 1000)).toBeLessThan(40);
    const huge = new Array(5000).fill(s);
    const t0 = performance.now();
    expect(dataSize(huge, 200_000)).toBeGreaterThan(200_000);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(dataSize(ev("Array.from({length: 40}).reduce((a) => [a, a], [0])"), 1000)).toBeGreaterThan(1000);
    expect(dataSize(undefined, 10) + dataSize(null, 10) + dataSize(() => 1, 10)).toBe(12);
  });
});
