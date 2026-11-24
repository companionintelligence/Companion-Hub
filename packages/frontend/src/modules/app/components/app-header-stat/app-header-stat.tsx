import type React from 'react';

/** A version as the app page header shows it: `1.0.0` reads `v1.0.0`, a tag such as `release` stays as it is. */
export const versionLabel = (version: string) => (/^\d/.test(version) ? `v${version}` : version);

/** One fact in an app page header, a value and what it is, in the rounded pill the store app page uses. */
export const AppHeaderStat = ({ value, label, testId }: { value: React.ReactNode; label: string; testId?: string }) => (
  <div data-testid={testId} className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 sm:px-3 sm:py-1.5">
    <span className="text-foreground">{value}</span>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);
