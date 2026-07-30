import { TestClient } from '../helpers/client';

describe('Streaming Scenario', () => {
  let client: TestClient;

  beforeAll(() => {
    client = new TestClient();
  });

  it('should handle multiple messages in sequence', async () => {
    // Send several messages in sequence — the streaming pipeline should handle
    // each one correctly without breaking
    const messages = [
      'Hello',
      'What is 2+2?',
      'Can you tell me a fun fact?',
    ];

    for (const msg of messages) {
      const result = await client.interact(msg);
      expect(result).toBeDefined();
      expect(typeof result.response).toBe('string');
      expect(result.response.length).toBeGreaterThan(0);
    }
  }, 600_000);

  it('should paginate history correctly', async () => {
    // With the messages sent above, verify pagination
    const page0 = await client.getHistory(0, 2);
    expect(page0.messages.length).toBeGreaterThanOrEqual(1);

    const total = page0.total;
    if (total > 2) {
      const page1 = await client.getHistory(1, 2);
      expect(page1.messages.length).toBeGreaterThanOrEqual(1);
      expect(page1.has_more).toBe(total > 4);
    }
  });
});
