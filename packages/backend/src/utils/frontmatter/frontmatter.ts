import YAML from 'yaml';

export function getFrontmatter(content: string) {
  try {
    if (!/^---\r?\n/.test(content)) {
      return null;
    }

    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\s*$/m;

    const match = content.match(frontmatterRegex);

    if (!match) {
      return null;
    }

    // Only `key: value` pairs are frontmatter. A note that opens with a horizontal rule around plain text is just text.
    const parsed: unknown = YAML.parse(match[1] ?? '');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error('Error extracting frontmatter:', error);
    return null;
  }
}
