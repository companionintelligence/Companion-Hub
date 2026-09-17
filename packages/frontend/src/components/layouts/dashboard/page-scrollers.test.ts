import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Dashboard pages scroll in <main> or in their own pane, marked
 * `data-page-scroller`. <main> spans the window and pads its content into the
 * page column (`dashboard-column`), so a pane starts inside that padding. It
 * needs `page-scroller-edge-*` to reach the window edge with its scrollbar, and
 * no element between it and <main> may clip overflow: a clipping wrapper leaves
 * the scrollbar laid out at the window edge but not drawn, and it can't be
 * dragged. Nothing in the rendered DOM shows that, so this reads the source.
 */

const SRC = resolve(__dirname, '../../..');

// Any overflow but `visible` clips horizontally, except `overflow-y-clip`.
const CLIPS_X = /(?:^|[\s'"`])(?:overflow(?:-x)?-(?:hidden|clip|auto|scroll)|overflow-y-(?:hidden|auto|scroll))(?=[\s'"`]|$)/;

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith('.tsx') && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

function classNameText(element: ts.JsxOpeningLikeElement) {
  const attribute = element.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText() === 'className');
  return attribute && ts.isJsxAttribute(attribute) ? (attribute.initializer?.getText() ?? '') : '';
}

type Scroller = { where: string; edge: boolean; clippedBy: string[] };

function pageScrollers() {
  const scrollers: Scroller[] = [];

  for (const file of tsxFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('data-page-scroller')) continue;

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const marked =
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText() === 'data-page-scroller');

      if (marked) {
        const clippedBy: string[] = [];
        const start = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent;
        for (let ancestor: ts.Node | undefined = start; ancestor; ancestor = ancestor.parent) {
          if (ts.isJsxElement(ancestor) && CLIPS_X.test(classNameText(ancestor.openingElement))) {
            clippedBy.push(ancestor.openingElement.tagName.getText());
          }
        }
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        scrollers.push({ where: `${relative(SRC, file)}:${line}`, edge: /page-scroller-edge-\d/.test(classNameText(node)), clippedBy });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return scrollers;
}

describe('dashboard page scrollers', () => {
  const scrollers = pageScrollers();

  it('finds the page scrollers', () => {
    // Home, the store pane, Settings, and the custom app and port expose pages.
    expect(scrollers.length).toBeGreaterThanOrEqual(7);
  });

  it('stretches every page scroller to the window edge', () => {
    expect(scrollers.filter((scroller) => !scroller.edge).map((scroller) => scroller.where)).toEqual([]);
  });

  it('keeps clipping wrappers off every page scroller', () => {
    const clipped = scrollers.filter((scroller) => scroller.clippedBy.length > 0);
    expect(clipped.map((scroller) => `${scroller.where} inside ${scroller.clippedBy.join(' < ')}`)).toEqual([]);
  });
});
