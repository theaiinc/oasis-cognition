import { HttpStatus } from '@nestjs/common';

import { InteractionController } from './interaction.controller';

describe('InteractionController', () => {
  it('returns an accepted session and starts the pipeline in the background', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const controller = new InteractionController({ execute } as any);
    const response = {
      status: jest.fn(),
      json: jest.fn(),
    } as any;
    const request = { session_id: 'session-1', user_message: 'hello' };

    await expect(controller.createInteraction(request, {} as any, response)).resolves.toEqual({ session_id: 'session-1' });

    expect(response.status).toHaveBeenCalledWith(HttpStatus.ACCEPTED);
    expect(execute).toHaveBeenCalledWith(request, expect.any(Function));
  });
});
