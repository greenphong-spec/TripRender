// Minimal non-validating XML parser. Element and attribute names are reduced
// to their local name (namespace prefixes dropped), which is all GPX/KML need.

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);
const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(src: string): XNode {
  const stack: XNode[] = [];
  let root: XNode | null = null;
  let i = 0;
  const n = src.length;

  const fail = (msg: string): never => {
    throw new Error(`Invalid XML: ${msg} (at offset ${i})`);
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i && stack.length) stack[stack.length - 1].text += decode(src.slice(i, textEnd));
    if (lt < 0) break;
    i = lt;

    if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i);
      if (e < 0) fail('unterminated processing instruction');
      i = e + 2;
    } else if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i);
      if (e < 0) fail('unterminated comment');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i);
      if (e < 0) fail('unterminated CDATA');
      if (stack.length) stack[stack.length - 1].text += src.slice(i + 9, e);
      i = e + 3;
    } else if (src.startsWith('<!', i)) {
      const e = src.indexOf('>', i);
      if (e < 0) fail('unterminated declaration');
      i = e + 1;
    } else if (src.startsWith('</', i)) {
      const e = src.indexOf('>', i);
      if (e < 0) fail('unterminated end tag');
      const name = local(src.slice(i + 2, e).trim());
      const open = stack.pop();
      if (!open || open.name !== name) fail(`unexpected </${name}>`);
      i = e + 1;
    } else {
      // Start tag: find the closing '>' outside quoted attribute values.
      let j = i + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) fail('unterminated start tag');
      let body = src.slice(i + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^[^\s]+/.exec(body);
      if (!m) fail('empty tag name');
      const node: XNode = { name: local(m![0]), attrs: {}, children: [], text: '' };
      ATTR_RE.lastIndex = m![0].length;
      let a: RegExpExecArray | null;
      while ((a = ATTR_RE.exec(body))) {
        const key = a[1];
        if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
        node.attrs[local(key)] = decode(a[2] ?? a[3] ?? '');
      }
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (!root) root = node;
      else fail('more than one root element');
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  if (!root) fail('no root element');
  if (stack.length) fail(`<${stack[stack.length - 1].name}> is not closed`);
  return root!;
}

export function child(n: XNode, name: string): XNode | undefined {
  return n.children.find((c) => c.name === name);
}

export function childText(n: XNode, name: string): string | undefined {
  const c = child(n, name);
  return c ? c.text.trim() : undefined;
}

export function* descendants(n: XNode, name: string): Generator<XNode> {
  for (const c of n.children) {
    if (c.name === name) yield c;
    yield* descendants(c, name);
  }
}

export function firstDescendant(n: XNode, name: string): XNode | undefined {
  for (const d of descendants(n, name)) return d;
  return undefined;
}
