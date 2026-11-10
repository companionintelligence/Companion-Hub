import { describe, expect, it } from 'vitest';
import { getFrontmatter } from '../frontmatter';

describe('getFrontmatter', () => {
  it('reads the key: value pairs between the fences', () => {
    expect(getFrontmatter('---\nname: X\nversion: 1.0.0\n---\n\n# Hello\n')).toEqual({ name: 'X', version: '1.0.0' });
  });

  it('reads a note saved with Windows line endings', () => {
    expect(getFrontmatter('---\r\nname: X\r\n---\r\n')).toEqual({ name: 'X' });
  });

  it('is null for a note that opens with a horizontal rule around plain text', () => {
    expect(getFrontmatter('---\nCheck backups weekly.\n---\nThe rest')).toBeNull();
  });

  it('is null when the fenced block is a YAML list', () => {
    expect(getFrontmatter('---\n- one\n- two\n---\n')).toBeNull();
  });

  it('is null for a note with no frontmatter', () => {
    expect(getFrontmatter('# Hello')).toBeNull();
  });
});
