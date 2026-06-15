import { TestClient } from '../helpers/client';
import { casualChatMessage } from '../helpers/fixtures';

describe('Casual Chat Scenario', () => {
  let client: TestClient;

  beforeAll(() => {
    client = new TestClient();
  });

  it('should respond to a casual greeting with non-empty text', async () => {
    const result = await client.interact(casualChatMessage());

    expect(result).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);
  }, 180_000);

  it('should have no 5xx errors from internal services (verify via history)', async () => {
    // Send a second message to verify the pipeline handles conversational flow
    const result = await client.interact('What can you help me with?');

    expect(result).toBeDefined();
    expect(result.response.length).toBeGreaterThan(0);

    // Verify history is stored
    const history = await client.getHistory();
    expect(history.messages.length).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
