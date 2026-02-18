import { test, expect } from '@playwright/test';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;

test.describe('Health API', () => {
  test('GET /api/health should return ok', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/api/health`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('GET /api/health/data should return data integrity info', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/api/health/data`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty('ok');
    expect(body).toHaveProperty('dirs');
    expect(body.dirs).toHaveProperty('data');
    expect(body.dirs).toHaveProperty('appData');
    expect(body.dirs).toHaveProperty('state');
  });
});
