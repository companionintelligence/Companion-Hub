import { describe, expect, it } from 'vitest';
import { sseSchema } from '../sse';

describe('sseSchema', () => {
  it('accepts app custom domain status events', () => {
    const result = sseSchema.safeParse({
      topic: 'app',
      data: {
        event: 'custom_domain_status',
        appUrn: 'n8n:ci-marketplace',
        customDomainId: 'cd-1',
        domain: 'n8n.example.com',
        propagationStatus: 'success',
        sslStatus: 'pending',
        monitorStatus: 'pending',
      },
    });

    expect(result.success).toBe(true);
  });
});
