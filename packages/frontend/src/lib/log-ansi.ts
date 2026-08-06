import Convert from 'ansi-to-html';

export type LogTheme = 'light' | 'dark';

const LIGHT_TERMINAL = {
  fg: '#0f172a',
  bg: '#f6f8fb',
  colors: {
    0: '#334155',
    1: '#dc2626',
    2: '#16a34a',
    3: '#ca8a04',
    4: '#2563eb',
    5: '#9333ea',
    6: '#0891b2',
    7: '#64748b',
    8: '#475569',
    9: '#ef4444',
    10: '#22c55e',
    11: '#eab308',
    12: '#3b82f6',
    13: '#a855f7',
    14: '#06b6d4',
    15: '#0f172a',
  },
} as const;

const DARK_TERMINAL = {
  fg: '#d7e6e4',
  bg: '#061924',
  colors: {
    0: '#94a3b8',
    1: '#f87171',
    2: '#4ade80',
    3: '#facc15',
    4: '#60a5fa',
    5: '#c084fc',
    6: '#22d3ee',
    7: '#cbd5e1',
    8: '#64748b',
    9: '#fca5a5',
    10: '#86efac',
    11: '#fde047',
    12: '#93c5fd',
    13: '#d8b4fe',
    14: '#67e8f9',
    15: '#f8fafc',
  },
} as const;

const converters = {
  light: new Convert({ ...LIGHT_TERMINAL, escapeXML: true }),
  dark: new Convert({ ...DARK_TERMINAL, escapeXML: true }),
};

export function colorizeLogLine(line: string, theme: LogTheme): string {
  return converters[theme].toHtml(line);
}

export function colorizeLogLines(lines: string[], theme: LogTheme): string[] {
  return lines.map((line) => colorizeLogLine(line, theme));
}
