import { render } from '@/tests/test-utils';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const renderMarkdown = (content: string) => render(<Markdown content={content} className="" />).container;

describe('Markdown', () => {
  describe('what a description is allowed to use', () => {
    it('renders headings, emphasis and lists', () => {
      const root = renderMarkdown('# Title\n\nSome **bold** and _italic_ text.\n\n- one\n- two');

      expect(root.querySelector('h1')?.textContent).toBe('Title');
      expect(root.querySelector('strong')?.textContent).toBe('bold');
      expect(root.querySelectorAll('li')).toHaveLength(2);
    });

    it('renders a GitHub-style table', () => {
      const root = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');

      expect(root.querySelector('table')).not.toBeNull();
      expect(root.querySelectorAll('td')).toHaveLength(2);
    });

    it('renders embedded HTML that is safe', () => {
      const root = renderMarkdown(
        '<details><summary>More</summary><p>Hidden <em>detail</em></p></details>\n\n<img src="https://example.com/a.png" alt="screenshot">',
      );

      expect(root.querySelector('details > summary')?.textContent).toBe('More');
      expect(root.querySelector('details em')?.textContent).toBe('detail');
      expect(root.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
    });

    it('opens links in a new tab without handing the page its opener', () => {
      const link = renderMarkdown('[docs](https://example.com/docs)').querySelector('a');

      expect(link?.getAttribute('href')).toBe('https://example.com/docs');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });

  describe('what it must never render live', () => {
    it.each([
      ['a script', '<script>window.pwned = true</script>', 'script'],
      ['an iframe', '<iframe srcdoc="<script>alert(1)</script>"></iframe>', 'iframe'],
      ['an iframe pointing elsewhere', '<iframe src="https://evil.example"></iframe>', 'iframe'],
      ['a form', '<form action="https://evil.example"><input name="password"></form>', 'form'],
      ['a style block', '<style>body{display:none}</style>', 'style'],
      ['an object', '<object data="https://evil.example/x.swf"></object>', 'object'],
      ['an embed', '<embed src="https://evil.example/x">', 'embed'],
      ['a button', '<button>Click</button>', 'button'],
    ])('drops %s', (_name, markup, selector) => {
      expect(renderMarkdown(`before\n\n${markup}\n\nafter`).querySelector(selector)).toBeNull();
    });

    it('leaves no input a visitor could type a password into', () => {
      const root = renderMarkdown(
        '<input type="password" name="p">\n\n<form action="https://evil.example"><input name="password"></form>\n\n- [ ] a task',
      );

      // GFM task lists render a checkbox, which the sanitiser keeps only disabled.
      expect(root.querySelector('input:not([disabled])')).toBeNull();
      expect(root.querySelector('input[type="password"]')).toBeNull();
      expect(root.querySelector('input[type="text"]')).toBeNull();
    });

    it('strips event handler attributes but keeps the element', () => {
      const root = renderMarkdown(
        '<img src="https://example.com/a.png" onerror="window.pwned = true" alt="x">\n\n<p onclick="window.pwned = true">text</p>',
      );

      expect(root.querySelector('img')?.hasAttribute('onerror')).toBe(false);
      expect(root.querySelector('p[onclick]')).toBeNull();
      expect(root.textContent).toContain('text');
    });

    it('strips inline styles, which can lay a fake page over the real one', () => {
      const root = renderMarkdown('<div style="position:fixed;inset:0;background:white;z-index:9999">Sign in again</div>');

      expect(root.querySelector('[style]')).toBeNull();
    });

    it.each([
      ['javascript:alert(1)'],
      ['JaVaScRiPt:alert(1)'],
      ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
      ['vbscript:msgbox(1)'],
    ])('does not keep a link to %s', (href) => {
      const root = renderMarkdown(`<a href="${href}">click</a>\n\n[md](${href})`);

      for (const anchor of root.querySelectorAll('a')) {
        expect(anchor.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data|vbscript):/i);
      }
    });

    it('does not let a description name an element after one of the Hub’s own', () => {
      // Without a prefix, `id="root"` would shadow the element a page script looks up by id.
      const root = renderMarkdown('<p id="root">x</p>');

      expect(root.querySelector('#root')).toBeNull();
    });
  });
});
