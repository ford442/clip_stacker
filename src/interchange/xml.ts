/**
 * The one module that imports `fast-xml-parser` (it runs in the browser and
 * under Node, where `DOMParser` does not exist). Documents are kept in its
 * order-preserving form, wrapped as plain `XmlNode`s, so element order (a
 * spine's clips and transitions) survives both ways.
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text content (concatenated text children), for text-only elements. */
  text?: string;
}

const ATTR = '@_';

type OrderedNode = Record<string, unknown> & { ':@'?: Record<string, unknown> };

export function el(tag: string, attrs: Record<string, string | number | undefined> = {}, children: XmlNode[] = [], text?: string): XmlNode {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) clean[key] = String(value);
  return text === undefined ? { tag, attrs: clean, children } : { tag, attrs: clean, children, text };
}

function toOrdered(node: XmlNode): OrderedNode {
  const body: unknown[] = node.text !== undefined ? [{ '#text': node.text }] : node.children.map(toOrdered);
  const out: OrderedNode = { [node.tag]: body };
  if (Object.keys(node.attrs).length > 0) {
    out[':@'] = Object.fromEntries(Object.entries(node.attrs).map(([k, v]) => [`${ATTR}${k}`, v]));
  }
  return out;
}

/** Serialize with a 4-space indent, an XML declaration and an optional DOCTYPE. */
export function buildXml(root: XmlNode, doctype?: string): string {
  const builder = new XMLBuilder({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    format: true,
    indentBy: '    ',
    suppressEmptyNode: true,
    processEntities: true,
  });
  const body = builder.build([toOrdered(root)]) as string;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${doctype ? `<!DOCTYPE ${doctype}>\n` : ''}${body.trim()}\n`;
}

function fromOrdered(node: OrderedNode): XmlNode | null {
  const tag = Object.keys(node).find((key) => key !== ':@');
  if (!tag || tag === '#text' || tag.startsWith('?') || tag.startsWith('!')) return null;
  const rawAttrs = node[':@'] ?? {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAttrs)) attrs[key.startsWith(ATTR) ? key.slice(ATTR.length) : key] = String(value);
  const body = Array.isArray(node[tag]) ? (node[tag] as OrderedNode[]) : [];
  const children: XmlNode[] = [];
  let text = '';
  for (const child of body) {
    if ('#text' in child) text += String(child['#text']);
    else {
      const parsed = fromOrdered(child);
      if (parsed) children.push(parsed);
    }
  }
  return children.length === 0 && text.trim() !== '' ? { tag, attrs, children, text } : { tag, attrs, children };
}

/** Parse a document; returns its root element, or null when there is none. */
export function parseXml(text: string): XmlNode | null {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  const doc = parser.parse(text) as OrderedNode[];
  for (const node of doc) {
    const parsed = fromOrdered(node);
    if (parsed) return parsed;
  }
  return null;
}

/** Child elements named `tag` (all of them with no tag). */
export function childrenOf(node: XmlNode | null | undefined, tag?: string): XmlNode[] {
  if (!node) return [];
  return tag ? node.children.filter((child) => child.tag === tag) : node.children;
}

export function firstChild(node: XmlNode | null | undefined, tag: string): XmlNode | null {
  return node?.children.find((child) => child.tag === tag) ?? null;
}

/** Depth-first search for the first element named `tag`. */
export function findDeep(node: XmlNode | null | undefined, tag: string): XmlNode | null {
  if (!node) return null;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findDeep(child, tag);
    if (found) return found;
  }
  return null;
}

/** All text under `node` (nested elements included), in document order. */
export function textContent(node: XmlNode | null | undefined): string {
  if (!node) return '';
  return (node.text ?? '') + node.children.map(textContent).join('');
}
