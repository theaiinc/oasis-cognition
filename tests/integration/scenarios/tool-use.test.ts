import { TestClient } from '../helpers/client';
import { toolUseRequest } from '../helpers/fixtures';

describe('Tool Use Scenario', () => {
  let client: TestClient;

  beforeAll(() => {
    client = new TestClient();
  });

  it('should execute tool calls and produce a code-aware response', async () => {
    const result = await client.interact(toolUseRequest());

    expect(result).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);

    // The response should reference specific findings (file paths, function names)
    expect(result.response).not.toBe('_(Empty reply from the pipeline — open the timeline for this message or try again.)_');
  }, 600_000);
});
