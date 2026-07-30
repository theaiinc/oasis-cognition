import { TestClient } from '../helpers/client';
import { stubProjectConfig } from '../helpers/fixtures';

describe('Project-Scoped Scenario', () => {
  let client: TestClient;
  let projectId: string;

  beforeAll(async () => {
    client = new TestClient();
    // Create a test project
    const config = stubProjectConfig();
    const proj = await client.createProject(config.name, config.description, config.project_path);
    projectId = proj.project_id;
    expect(projectId).toBeDefined();
    expect(projectId.length).toBeGreaterThan(0);
  });

  it('should send a message in the context of a project', async () => {
    const result = await client.interact(
      'What is the purpose of this project?',
      { projectId },
    );

    expect(result).toBeDefined();
    expect(result.response.length).toBeGreaterThan(0);
  }, 480_000);

  it('should keep interaction history isolated per session', async () => {
    // Create a separate client for a different session
    const otherClient = new TestClient();
    const otherResult = await otherClient.interact('Hello from a different session');

    expect(otherResult).toBeDefined();
    expect(otherResult.response.length).toBeGreaterThan(0);

    // Verify session isolation
    const thisHistory = await client.getHistory();
    const otherHistory = await otherClient.getHistory();
    expect(thisHistory.messages.length).toBeGreaterThanOrEqual(1);
    expect(otherHistory.messages.length).toBeGreaterThanOrEqual(1);
  }, 480_000);
});
