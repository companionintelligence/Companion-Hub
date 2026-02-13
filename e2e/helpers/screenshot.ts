/**
 * Screenshot Helper for E2E Tests
 *
 * Utilities for screenshot capture and comparison
 */

import type { Page } from '@playwright/test';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ScreenshotOptions {
  fullPage?: boolean;
  mask?: string[]; // Selectors to mask (for dynamic content)
  threshold?: number; // Comparison threshold (0-1)
}

export class ScreenshotHelper {
  private baselinePath: string;
  private actualPath: string;
  private diffPath: string;

  constructor(basePath = './e2e/screenshots') {
    this.baselinePath = join(basePath, 'baseline');
    this.actualPath = join(basePath, 'actual');
    this.diffPath = join(basePath, 'diff');

    // Ensure directories exist
    for (const dir of [this.baselinePath, this.actualPath, this.diffPath]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Take screenshot and save to actual folder
   */
  async capture(page: Page, name: string, options: ScreenshotOptions = {}): Promise<Buffer> {
    const path = join(this.actualPath, `${name}.png`);

    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Apply masks if specified
    if (options.mask && options.mask.length > 0) {
      for (const selector of options.mask) {
        const elements = await page.locator(selector).all();
        for (const element of elements) {
          await element.evaluate((el: HTMLElement) => {
            el.style.visibility = 'hidden';
          });
        }
      }
    }

    const screenshot = await page.screenshot({
      path,
      fullPage: options.fullPage ?? true,
    });

    // Restore masked elements
    if (options.mask && options.mask.length > 0) {
      for (const selector of options.mask) {
        const elements = await page.locator(selector).all();
        for (const element of elements) {
          await element.evaluate((el: HTMLElement) => {
            el.style.visibility = 'visible';
          });
        }
      }
    }

    return screenshot;
  }

  /**
   * Take screenshot and save as baseline
   */
  async captureBaseline(page: Page, name: string, options: ScreenshotOptions = {}): Promise<Buffer> {
    const path = join(this.baselinePath, `${name}.png`);

    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    return await page.screenshot({
      path,
      fullPage: options.fullPage ?? true,
    });
  }

  /**
   * Check if baseline exists
   */
  hasBaseline(name: string): boolean {
    return existsSync(join(this.baselinePath, `${name}.png`));
  }

  /**
   * Get baseline path
   */
  getBaselinePath(name: string): string {
    return join(this.baselinePath, `${name}.png`);
  }

  /**
   * Get actual path
   */
  getActualPath(name: string): string {
    return join(this.actualPath, `${name}.png`);
  }

  /**
   * Get diff path
   */
  getDiffPath(name: string): string {
    return join(this.diffPath, `${name}.png`);
  }

  /**
   * Compare screenshots and return match percentage
   * Note: Full implementation would use pixelmatch or similar
   */
  async compare(name: string): Promise<{ match: boolean; percentage: number }> {
    const baselinePath = this.getBaselinePath(name);
    const actualPath = this.getActualPath(name);

    if (!existsSync(baselinePath)) {
      console.warn(`No baseline found for ${name}`);
      return { match: false, percentage: 0 };
    }

    if (!existsSync(actualPath)) {
      console.warn(`No actual screenshot found for ${name}`);
      return { match: false, percentage: 0 };
    }

    // Simple file size comparison as a basic check
    // In production, use pixelmatch or similar
    const baselineSize = readFileSync(baselinePath).length;
    const actualSize = readFileSync(actualPath).length;

    const sizeDiff = Math.abs(baselineSize - actualSize) / baselineSize;
    const percentage = 1 - sizeDiff;
    const match = percentage > 0.95;

    return { match, percentage };
  }
}

// Export singleton
export const screenshots = new ScreenshotHelper();

/**
 * Take a screenshot with timestamp for debugging
 */
export async function debugScreenshot(page: Page, prefix: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `./e2e/screenshots/debug/${prefix}-${timestamp}.png`;

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  await page.screenshot({ path, fullPage: true });
  return path;
}
