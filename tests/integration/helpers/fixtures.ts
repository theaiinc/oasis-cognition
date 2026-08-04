import { randomUUID } from 'crypto';

/**
 * Test data factories for integration tests.
 */

export function uniqueSessionId(): string {
  return `test-${randomUUID()}`;
}

export function stubProjectConfig() {
  return {
    name: `test-project-${randomUUID().slice(0, 8)}`,
    description: 'Auto-created by integration tests',
    project_path: '/tmp/oasis-test-projects',
  };
}

export function casualChatMessage(): string {
  return 'Hello, how are you?';
}

export function complexQuestion(): string {
  return 'Can you explain the architecture of this application and its key design patterns?';
}

export function toolUseRequest(): string {
  return 'Find all files in the project that contain "async function" and list their paths.';
}
