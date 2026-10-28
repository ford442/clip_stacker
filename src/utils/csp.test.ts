import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
  cspMetaPlugin,
  injectCspMeta,
  toMetaContentSecurityPolicy,
} from './csp';

const INDEX_HTML = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const HTACCESS = readFileSync(join(process.cwd(), 'public/.htaccess'), 'utf8');

type HtmlHook = (html: string, ctx: { server?: unknown }) => string;

function transformIndexHtml(html: string, ctx: { server?: unknown }): string {
  return (cspMetaPlugin().transformIndexHtml as HtmlHook)(html, ctx);
}

function metaPolicies(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(
    doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
  ).map((meta) => meta.getAttribute('content') ?? '');
}

function directives(policy: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of policy.split(';')) {
    const directive = part.trim();
    if (!directive) continue;
    const [name, ...sources] = directive.split(/\s+/);
    map.set(name, sources.join(' '));
  }
  return map;
}

describe('CONTENT_SECURITY_POLICY', () => {
  it('allows blob: scripts for FFmpeg WASM dynamic imports', () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src[^;]*\bblob:/);
  });

  it('allows blob: workers for FFmpeg WASM', () => {
    expect(CONTENT_SECURITY_POLICY).toMatch(/worker-src[^;]*\bblob:/);
  });

  it('is what public/.htaccess sends', () => {
    const header = /Header always set Content-Security-Policy "([^"]*)"/.exec(HTACCESS);
    expect(header).not.toBeNull();
    expect(directives(header![1])).toEqual(directives(CONTENT_SECURITY_POLICY));
  });
});

describe('toMetaContentSecurityPolicy', () => {
  it('drops only the directives a <meta> policy ignores', () => {
    const expected = directives(CONTENT_SECURITY_POLICY);
    expected.delete('frame-ancestors');
    expect(directives(toMetaContentSecurityPolicy(CONTENT_SECURITY_POLICY))).toEqual(expected);
    expect(toMetaContentSecurityPolicy("default-src 'self'; report-uri /r; sandbox")).toBe(
      "default-src 'self'",
    );
  });
});

describe('cspMetaPlugin', () => {
  it('writes the production policy into the built index.html', () => {
    const html = transformIndexHtml(INDEX_HTML, {});
    const policies = metaPolicies(html);
    expect(policies).toEqual([toMetaContentSecurityPolicy(CONTENT_SECURITY_POLICY)]);

    const meta = directives(policies[0]);
    expect(meta.get('script-src')).not.toContain('unsafe-inline');
    expect(policies[0]).not.toMatch(/\bws:/);
  });

  it('keeps every production directive except the meta-ignored ones', () => {
    const meta = directives(metaPolicies(transformIndexHtml(INDEX_HTML, {}))[0]);
    for (const [name, sources] of directives(CONTENT_SECURITY_POLICY)) {
      if (name === 'frame-ancestors') continue;
      expect(meta.get(name), name).toBe(sources);
    }
  });

  it('uses the dev-server policy under `vite` serve', () => {
    const html = transformIndexHtml(INDEX_HTML, { server: {} });
    expect(metaPolicies(html)).toEqual([toMetaContentSecurityPolicy(DEV_CONTENT_SECURITY_POLICY)]);
  });

  it('places the policy ahead of every script', () => {
    const html = transformIndexHtml(INDEX_HTML, {});
    const metaAt = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(metaAt).toBeGreaterThan(html.indexOf('<meta charset'));
    expect(metaAt).toBeLessThan(html.indexOf('<script'));
  });

  it('refuses a page that hard-codes its own CSP meta', () => {
    const html = injectCspMeta(INDEX_HTML, CONTENT_SECURITY_POLICY);
    expect(() => injectCspMeta(html, CONTENT_SECURITY_POLICY)).toThrow(/generated from/);
  });
});
