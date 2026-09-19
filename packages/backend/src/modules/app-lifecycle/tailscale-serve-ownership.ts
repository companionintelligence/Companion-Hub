import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';

const ownershipPath = () => path.join(DATA_DIR, 'state', 'tailscale-serve-ownership.json');

interface OwnershipFile {
  /** The target the Hub last wrote on each port it published, keyed by port. */
  ports: Record<string, string>;
}

/**
 * The Tailscale Serve listeners this Hub published, and the target it wrote on each.
 *
 * Serve config does not record who created a listener. In host mode the Hub shares tailscaled with
 * everyone on the machine, so it may remove only listeners it can show are its own. On fzzy, a
 * manual `tailscale serve --https=3081` was gone 84 seconds later because the sync treated every
 * listener as the Hub's. The record lives under `DATA_DIR/state` so that a restart does not orphan
 * a stopped app's listener.
 *
 * Every failure falls back to owning less, which leaves a stale listener in place rather than
 * removing someone else's.
 */
export class TailscaleServeOwnership {
  private readonly ports = new Map<number, string>();
  private loading: Promise<void> | null = null;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = ownershipPath()) {}

  /** Reads the record once per process; a missing or unreadable file reads as owning nothing. */
  async load(): Promise<this> {
    this.loading ??= this.read();
    await this.loading;
    return this;
  }

  /** The target the Hub wrote on `port`, if it published that port. */
  targetFor(port: number): string | undefined {
    return this.ports.get(port);
  }

  record(port: number, target: string): void {
    if (this.ports.get(port) === target) return;
    this.ports.set(port, target);
    this.dirty = true;
  }

  release(port: number): void {
    if (this.ports.delete(port)) this.dirty = true;
  }

  /**
   * Writes the record if it changed. Saves run one at a time so that concurrent sync passes cannot
   * finish out of order and leave an older record on disk.
   */
  save(): Promise<void> {
    const run = this.saving.then(() => this.writeIfDirty());
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<void> {
    let parsed: Partial<OwnershipFile>;
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.filePath, 'utf-8')) as Partial<OwnershipFile>;
    } catch {
      return;
    }
    for (const [key, target] of Object.entries(parsed?.ports ?? {})) {
      const port = Number(key);
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && typeof target === 'string' && target) {
        this.ports.set(port, target);
      }
    }
  }

  private async writeIfDirty(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const file: OwnershipFile = { ports: Object.fromEntries(this.ports) };
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}
