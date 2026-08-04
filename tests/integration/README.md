# Integration tests

The integration suite targets the asynchronous gateway contract:

1. `POST /api/v1/interaction` returns `202 { session_id }`.
2. Pipeline events are delivered through the session timeline SSE stream.
3. The client waits for the assistant history entry correlated by
   `client_message_id`.

Start the canonical stack with the test database overlay from the repository
root:

```sh
docker compose -f docker-compose.yml -f tests/integration/docker-compose.test.yml up -d
cd tests/integration
npm test
```

The suite does not start Docker automatically. Set `GATEWAY_URL`,
`MEMORY_URL`, and `RESPONSE_URL` when using a non-default stack.
