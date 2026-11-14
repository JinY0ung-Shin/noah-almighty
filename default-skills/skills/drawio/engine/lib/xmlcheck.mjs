// A small XML well-formedness scan. Node ships no XML parser and this tool
// takes no dependency, so this covers what breaks a hand-written .drawio file
// in practice — an unclosed or mismatched tag, an attribute without its
// quotes, `<` or a bare `&` inside a value — and reports the first one with
// its line. It is not a validating parser.

const NAME = /^[A-Za-z_:][\w:.-]*/;
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/;

function lineOf(xml, index) {
  let line = 1;
  for (let i = 0; i < index && i < xml.length; i++) if (xml.charCodeAt(i) === 10) line += 1;
  return line;
}

function bareAmpersand(text) {
  for (let i = text.indexOf("&"); i !== -1; i = text.indexOf("&", i + 1)) {
    if (!ENTITY.test(text.slice(i, i + 12))) return i;
  }
  return -1;
}

/** The first well-formedness error of `xml` as `{ message, line }`, or null. */
export function wellFormedError(xml) {
  const fail = (message, index) => ({ message, line: lineOf(xml, index) });
  const stack = [];
  let roots = 0;
  const first = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let i = first;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    const amp = bareAmpersand(text);
    if (amp !== -1) return fail("a bare `&` in text (write `&amp;`)", i + amp);
    if (stack.length === 0 && text.trim() !== "") return fail("text outside the root element", i + text.search(/\S/));
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) return fail("an XML comment that never ends", lt);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      if (lt !== first && /^<\?xml[\s?]/.test(xml.slice(lt, lt + 6))) {
        return fail("the XML declaration is not the first thing in the file (nothing, not even a blank line, may come before `<?xml`)", lt);
      }
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) return fail("a processing instruction that never ends", lt);
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) return fail("a CDATA section that never ends", lt);
      i = end + 3;
      continue;
    }
    if (xml[lt + 1] === "/") {
      const gt = xml.indexOf(">", lt);
      if (gt === -1) return fail("a closing tag that never ends", lt);
      const name = xml.slice(lt + 2, gt).trim();
      const open = stack.pop();
      if (open === undefined) return fail(`</${name}> closes nothing`, lt);
      if (open.name !== name) return fail(`</${name}> closes <${open.name}> (opened on line ${lineOf(xml, open.index)})`, lt);
      i = gt + 1;
      continue;
    }
    const nameMatch = NAME.exec(xml.slice(lt + 1, lt + 200));
    if (!nameMatch) return fail("a `<` that starts no tag (write `&lt;` inside a value)", lt);
    const name = nameMatch[0];
    let k = lt + 1 + name.length;
    let selfClosing = false;
    const seen = new Set();
    for (;;) {
      while (k < xml.length && /\s/.test(xml[k])) k += 1;
      if (k >= xml.length) return fail(`<${name}> never ends`, lt);
      if (xml[k] === ">") {
        k += 1;
        break;
      }
      if (xml[k] === "/" && xml[k + 1] === ">") {
        selfClosing = true;
        k += 2;
        break;
      }
      const attr = NAME.exec(xml.slice(k, k + 200));
      if (!attr) return fail(`unexpected \`${xml[k]}\` inside <${name}>`, k);
      if (seen.has(attr[0])) return fail(`<${name}> has the attribute ${attr[0]} twice (the viewer draws nothing)`, k);
      seen.add(attr[0]);
      k += attr[0].length;
      while (k < xml.length && /\s/.test(xml[k])) k += 1;
      if (xml[k] !== "=") return fail(`attribute ${attr[0]} of <${name}> has no value`, k);
      k += 1;
      while (k < xml.length && /\s/.test(xml[k])) k += 1;
      const quote = xml[k];
      if (quote !== '"' && quote !== "'") return fail(`the value of ${attr[0]} in <${name}> is not quoted`, k);
      const end = xml.indexOf(quote, k + 1);
      if (end === -1) return fail(`the value of ${attr[0]} in <${name}> never ends`, k);
      const value = xml.slice(k + 1, end);
      const bad = value.indexOf("<");
      if (bad !== -1) return fail(`\`<\` inside the value of ${attr[0]} (write \`&lt;\`; an HTML label is escaped: \`&lt;b&gt;\`)`, k + 1 + bad);
      const badAmp = bareAmpersand(value);
      if (badAmp !== -1) return fail(`a bare \`&\` inside the value of ${attr[0]} (write \`&amp;\`)`, k + 1 + badAmp);
      k = end + 1;
    }
    if (stack.length === 0) {
      roots += 1;
      if (roots > 1) return fail(`a second root element <${name}>`, lt);
    }
    if (!selfClosing) stack.push({ name, index: lt });
    i = k;
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    return fail(`<${open.name}> is never closed`, open.index);
  }
  if (roots === 0) return { message: "no XML element", line: 1 };
  return null;
}

/**
 * The same document with every attribute value in the one form the cell
 * scanners of this tool and of the vendored passes can read: in double quotes,
 * with no raw `>` inside.
 *
 * Both other forms are legal XML. A raw `>` is what an HTML label such as
 * `A&lt;br>B` leaves behind; the scanners read a tag up to its first `>`, so
 * such a cell would be cut short and silently dropped from the model. A
 * single-quoted value is invisible to them, and one that holds `style="…"`
 * (an HTML label) would have that inner text rewritten as if it were the
 * cell's style. Call it on well-formed XML only; draw.io itself writes this
 * form.
 */
export function canonicalAttributes(xml) {
  let out = "";
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, lt);
    const special = [
      ["<!--", "-->"],
      ["<?", "?>"],
      ["<![CDATA[", "]]>"],
    ].find(([open]) => xml.startsWith(open, lt));
    if (special) {
      const end = xml.indexOf(special[1], lt + special[0].length);
      const stop = end === -1 ? xml.length : end + special[1].length;
      out += xml.slice(lt, stop);
      i = stop;
      continue;
    }
    let k = lt + 1;
    let from = lt;
    for (; k < xml.length; k++) {
      const ch = xml[k];
      if (ch === ">") break;
      if (ch !== '"' && ch !== "'") continue;
      const end = xml.indexOf(ch, k + 1);
      if (end === -1) {
        k = xml.length;
        break;
      }
      let value = xml.slice(k + 1, end).replace(/>/g, "&gt;");
      if (ch === "'") value = value.replace(/"/g, "&quot;");
      out += `${xml.slice(from, k)}"${value}"`;
      from = end + 1;
      k = end;
    }
    out += xml.slice(from, k + 1);
    i = k + 1;
  }
  return out;
}

/** The name of the document's root element, or null. */
export function rootName(xml) {
  const body = withoutComments(xml).replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[^>]*>/i, "");
  return /<([A-Za-z_:][\w:.-]*)/.exec(body)?.[1] ?? null;
}

/** The document without its comments (a commented-out `<mxCell>` is not a cell). */
export function withoutComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}
