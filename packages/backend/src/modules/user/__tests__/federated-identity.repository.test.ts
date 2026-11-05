import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm/sql';
import { describe, expect, it, vi } from 'vitest';
import { FederatedIdentityRepository } from '../federated-identity.repository';

const DID = 'did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw';

/** A drizzle `delete().where().returning()` chain that records the WHERE it was given. */
function fakeDb(rows: Array<{ id: number }>) {
  const where = vi.fn();
  const returning = vi.fn().mockResolvedValue(rows);
  where.mockReturnValue({ returning });
  const db = { delete: vi.fn().mockReturnValue({ where }) };

  return { db, where, returning };
}

describe('FederatedIdentityRepository.deleteByUserIssuerSubject', () => {
  it('removes the one binding of this person to this (issuer, subject), and says it did', async () => {
    const { db, where } = fakeDb([{ id: 4 }]);

    await expect(new FederatedIdentityRepository(db as never).deleteByUserIssuerSubject(7, 'did:key', DID)).resolves.toBe(true);

    // The WHERE names all three: a binding that belongs to anyone else matches none of them.
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/"user_id" = \$1 and .*"issuer" = \$2 and .*"subject" = \$3/);
    expect(query.params).toEqual([7, 'did:key', DID]);
  });

  it('says nothing was removed when the person has no such binding', async () => {
    const { db } = fakeDb([]);

    await expect(new FederatedIdentityRepository(db as never).deleteByUserIssuerSubject(7, 'did:key', DID)).resolves.toBe(false);
  });

  it('reads a numeric string id as the number it is', async () => {
    const { db, where } = fakeDb([]);

    await new FederatedIdentityRepository(db as never).deleteByUserIssuerSubject('7' as unknown as number, 'did:key', DID);

    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL).params[0]).toBe(7);
  });
});
