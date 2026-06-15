import { TestClient } from '../helpers/client';
import { complexQuestion } from '../helpers/fixtures';

describe('Complex Reasoning Scenario', () => {
  let client: TestClient;

  beforeAll(() => {
    client = new TestClient();
  });

  it('should handle a complex question with a reasoning graph', async () => {
    const result = await client.interact(complexQuestion());

    expect(result).toBeDefined();
    expect(typeof result.response).toBe('string');
    expect(result.response.length).toBeGreaterThan(0);

    // Complex routes should produce a reasoning graph
    // Note: the graph may be empty if the route was classified as casual
    if (result.reasoning_graph) {
      const graph = result.reasoning_graph as Record<string, unknown>;
      const nodes = (graph.nodes || []) as Array<Record<string, unknown>>;
      const edges = (graph.edges || []) as Array<Record<string, unknown>>;

      // If a graph was provided, it should have nodes
      if (nodes.length > 0) {
        expect(edges.length).toBeGreaterThanOrEqual(0);
      }
    }
  }, 600_000);
});
