import { describe, expect, it } from 'vitest';
import { dataMoveSchema } from '../app-info';

const ok = (from: string, to: string) => dataMoveSchema.safeParse({ from, to }).success;

describe('dataMoveSchema', () => {
  it('takes a rename, a move into a folder inside, and the data folder itself as the source', () => {
    expect(ok('data/postgres', 'data/db')).toBe(true);
    expect(ok('data', 'data/app')).toBe(true);
    expect(ok('data/config/nats_server.conf', 'data/nats/nats_server.conf')).toBe(true);
    expect(ok('.', 'data/app')).toBe(true);
  });

  it('refuses a path that leaves the data folder or cannot be read one way', () => {
    for (const path of ['/etc', '../other-app', 'data/../..', 'data/./x', 'data//x', 'data/', 'C:/x', 'data\\x', '']) {
      expect(ok(path, 'data/app'), path).toBe(false);
      expect(ok('data/app', path), path).toBe(false);
    }
  });

  it("never touches the Hub's app.env, nor moves into the data folder itself", () => {
    expect(ok('app.env', 'data/app.env')).toBe(false);
    expect(ok('data/x', 'app.env')).toBe(false);
    expect(ok('data/x', 'app.env/x')).toBe(false);
    expect(ok('data', '.')).toBe(false);
  });

  it('refuses a move onto itself or out into a folder that holds it', () => {
    expect(ok('data', 'data')).toBe(false);
    expect(ok('data/app', 'data')).toBe(false);
    expect(ok('data/a/b', 'data/a')).toBe(false);
    // A shared prefix that is not a folder is not "inside".
    expect(ok('data/app-old', 'data/app')).toBe(true);
  });
});
