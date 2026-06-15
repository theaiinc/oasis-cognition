/**
 * Global teardown for integration tests.
 * - Cleans up Neo4j test nodes
 * - Logs completion
 */
import axios from 'axios';

const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';

export default async function teardown(): Promise<void> {
  console.log('[teardown] Cleaning up test data...');
  try {
    // Best-effort cleanup of test session data
    await axios.post(`${MEMORY_URL}/internal/memory/cleanup`, {
      tag_prefix: 'test_',
    }).catch(() => { /* endpoint may not exist */ });
  } catch {
    // Non-fatal
  }
  console.log('[teardown] Done.');
}
