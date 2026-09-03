#!/usr/bin/env tsx
/**
 * Compare benchmark results against checked-in baseline.
 * Usage: pnpm run benchmark:gate [--results path/to/results.json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const BASELINE = join(ROOT, 'e2e/results/benchmarks/baseline.json');

const REGRESSION_THRESHOLD = 0.15; // 15% worse than baseline fails gate

type BenchmarkEntry = {
  appId: string;
  installMs?: number;
  healthMs?: number;
  memoryMb?: number;
  cpuPercent?: number;
};

type BenchmarkFile = {
  version: number;
  capturedAt: string;
  entries: BenchmarkEntry[];
};

function loadJson(path: string): BenchmarkFile {
  return JSON.parse(readFileSync(path, 'utf8')) as BenchmarkFile;
}

function compareMetric(name: string, baseline: number | undefined, actual: number | undefined): string[] {
  const errors: string[] = [];
  if (baseline === undefined || actual === undefined) return errors;
  if (baseline <= 0) return errors;
  const ratio = (actual - baseline) / baseline;
  if (ratio > REGRESSION_THRESHOLD) {
    errors.push(`${name}: ${actual} vs baseline ${baseline} (+${(ratio * 100).toFixed(1)}%)`);
  }
  return errors;
}

const resultsArg = process.argv.indexOf('--results');
const resultsPath = resultsArg >= 0 ? process.argv[resultsArg + 1] : join(ROOT, 'e2e/results/benchmarks/latest.json');

if (!existsSync(BASELINE)) {
  console.error(`Missing baseline: ${BASELINE}`);
  console.error('Create baseline.json with representative hub metrics before enabling gate in CI.');
  process.exit(1);
}

if (!existsSync(resultsPath)) {
  console.log(`No results at ${resultsPath} — gate passes (nothing to compare).`);
  console.log('Run: pnpm exec tsx scripts/benchmark-app.ts <app-id> to produce results.');
  process.exit(0);
}

const baseline = loadJson(BASELINE);
const latest = loadJson(resultsPath);
const errors: string[] = [];

for (const entry of latest.entries) {
  const base = baseline.entries.find((e) => e.appId === entry.appId);
  if (!base) {
    console.log(`No baseline for app ${entry.appId} — skipping`);
    continue;
  }
  errors.push(...compareMetric(`${entry.appId}/installMs`, base.installMs, entry.installMs));
  errors.push(...compareMetric(`${entry.appId}/healthMs`, base.healthMs, entry.healthMs));
  errors.push(...compareMetric(`${entry.appId}/memoryMb`, base.memoryMb, entry.memoryMb));
  errors.push(...compareMetric(`${entry.appId}/cpuPercent`, base.cpuPercent, entry.cpuPercent));
}

if (errors.length > 0) {
  console.error('Benchmark regression detected:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('Benchmark gate passed.');
