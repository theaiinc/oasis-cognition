import { HttpStatus } from '@nestjs/common';
import { AcceptedMessages, InteractionController } from './interaction.controller';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(execute = jest.fn().mockResolvedValue(undefined)) {
  const events = { latestStreamId: jest.fn().mockResolvedValue('123-0'), publish: jest.fn().mockResolvedValue(undefined) };
  const service = { execute };
  const controller = new InteractionController(service as any, events as any);
  const response = { status: jest.fn() } as any;
  return { controller, service, events, response };
}

describe('InteractionController', () => {
  it('returns an accepted session with a replay cursor and starts the pipeline in the background', async () => {
    const { controller, service, response } = setup();
    const request = { session_id: 'session-1', user_message: 'hello', context: { client_message_id: 'message-1' } };
    await expect(controller.createInteraction(request, {} as any, response)).resolves.toEqual({
      session_id: 'session-1', client_message_id: 'message-1', event_cursor: '123-0',
    });
    expect(response.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
    expect(service.execute).toHaveBeenCalledWith(request, expect.any(Function));
  });

  it('gives a session and message id when the caller sent none, and rejects empty input', async () => {
    const { controller, service, response } = setup();
    const res = await controller.createInteraction({ user_message: 'hi' } as any, {} as any, response);
    expect(res.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.client_message_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(service.execute.mock.calls[0][0]).toMatchObject({ session_id: res.session_id, context: { client_message_id: res.client_message_id } });
    await expect(controller.createInteraction({ user_message: ' ' } as any, {} as any, response)).rejects.toThrow('nonempty');
  });

  it('runs a resent message once and hands the resend the first cursor', async () => {
    const { controller, service, events, response } = setup();
    const send = () => controller.createInteraction(
      { session_id: 'phone', user_message: 'hello', context: { client_message_id: 'queued-1' } }, {} as any, response,
    );
    const [first, again] = await Promise.all([send(), send()]);
    expect(first).toEqual({ session_id: 'phone', client_message_id: 'queued-1', event_cursor: '123-0' });
    expect(again).toEqual({ session_id: 'phone', client_message_id: 'queued-1', event_cursor: '123-0', duplicate: true });
    events.latestStreamId.mockResolvedValue('200-0');
    await expect(send()).resolves.toMatchObject({ event_cursor: '123-0', duplicate: true });
    await flush();
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it('treats the same id in another chat, and messages without an id, as new', async () => {
    const { controller, service, response } = setup();
    await controller.createInteraction({ session_id: 'a', user_message: 'x', context: { client_message_id: 'same' } }, {} as any, response);
    await controller.createInteraction({ session_id: 'b', user_message: 'x', context: { client_message_id: 'same' } }, {} as any, response);
    await controller.createInteraction({ session_id: 'a', user_message: 'x' }, {} as any, response);
    await controller.createInteraction({ session_id: 'a', user_message: 'x' }, {} as any, response);
    expect(service.execute).toHaveBeenCalledTimes(4);
  });
});

describe('AcceptedMessages', () => {
  it('forgets ids after the TTL and past the cap', async () => {
    let now = 0;
    const seen = new AcceptedMessages(1000, 2, () => now);
    seen.remember('s', 'm1', Promise.resolve('1-0'));
    await expect(seen.get('s', 'm1')).resolves.toBe('1-0');
    now = 1001;
    expect(seen.get('s', 'm1')).toBeNull();
    seen.remember('s', 'a', Promise.resolve('1-0'));
    seen.remember('s', 'b', Promise.resolve('2-0'));
    seen.remember('s', 'c', Promise.resolve('3-0'));
    expect(seen.get('s', 'a')).toBeNull();
    await expect(seen.get('s', 'c')).resolves.toBe('3-0');
  });
});
