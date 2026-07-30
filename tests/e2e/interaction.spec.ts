import { test, expect } from '@playwright/test';

test('accepts an interaction through the asynchronous timeline contract', async ({ page }) => {
  let interactionRequest: { context?: { client_message_id?: string } } | undefined;

  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = request.url();

    if (url.includes('/events/timeline')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"event_type":"TimelineConnected","session_id":"browser-e2e","payload":{}}\n\n',
      });
      return;
    }

    if (url.endsWith('/api/v1/interaction') && request.method() === 'POST') {
      interactionRequest = JSON.parse(request.postData() || '{}');
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ session_id: 'browser-e2e' }),
      });
      return;
    }

    if (url.includes('/history/messages')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: [], total: 0, has_more: false }) });
      return;
    }

    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
  });

  await page.goto('/');
  await expect(page.locator('textarea[placeholder^="Ask Oasis anything"]')).toBeVisible();

  const input = page.locator('textarea[placeholder^="Ask Oasis anything"]');
  await input.fill('hello from browser e2e');
  await input.press('Enter');

  await expect.poll(() => interactionRequest).toBeTruthy();
  expect(interactionRequest?.context?.client_message_id).toBeTruthy();
});
