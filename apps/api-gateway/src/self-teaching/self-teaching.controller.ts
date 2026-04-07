import { Body, Controller, Post } from '@nestjs/common';
import { SelfTeachingService } from './self-teaching.service';

class StartSelfTeachingRequest {
  topic!: string;
}

class SelfTeachingIdRequest {
  self_teaching_id!: string;
}

class AdjustSelfTeachingRequest extends SelfTeachingIdRequest {
  user_comment!: string;
}

class ApproveSelfTeachingRequest extends SelfTeachingIdRequest {
  /** When set, apply only this teaching_paths[].path_id bundle */
  selected_teaching_path_id?: string;
  /** When true, concatenate rule_actions from every teaching_paths entry (memory may dedupe) */
  apply_all_teaching_paths?: boolean;
}

@Controller('self-teaching')
export class SelfTeachingController {
  constructor(private readonly selfTeaching: SelfTeachingService) {}

  @Post('start')
  async start(@Body() req: StartSelfTeachingRequest) {
    return this.selfTeaching.start(req.topic);
  }

  @Post('approve')
  async approve(@Body() req: ApproveSelfTeachingRequest) {
    return this.selfTeaching.approve(req.self_teaching_id, {
      selected_teaching_path_id: req.selected_teaching_path_id,
      apply_all_teaching_paths: req.apply_all_teaching_paths,
    });
  }

  @Post('adjust')
  async adjust(@Body() req: AdjustSelfTeachingRequest) {
    return this.selfTeaching.adjust(req.self_teaching_id, req.user_comment);
  }

  @Post('reject')
  async reject(@Body() req: SelfTeachingIdRequest) {
    return this.selfTeaching.reject(req.self_teaching_id);
  }
}

