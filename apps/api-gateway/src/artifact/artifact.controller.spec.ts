import axios from 'axios';
import { HttpException } from '@nestjs/common';
import { ProjectsController } from './artifact.controller';

describe('ProjectsController.create', () => {
  const controller = new ProjectsController();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a blank project name before proxying', async () => {
    await expect(controller.create({ name: '   ' })).rejects.toBeInstanceOf(HttpException);
    await expect(controller.create({ name: '   ' })).rejects.toMatchObject({ status: 400 });
    expect(jest.spyOn(axios, 'post')).not.toHaveBeenCalled();
  });

  it('trims the name and omits an empty optional description', async () => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { project: { project_id: 'p1' } } } as never);

    await controller.create({ name: '  Notes  ', description: '   ' });

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/internal/memory/projects'),
      { name: 'Notes' },
    );
  });
});
