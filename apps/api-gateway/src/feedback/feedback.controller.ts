import { Controller, Post, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';
import { RedisEventService } from '../events/redis-event.service';

interface FeedbackRequest {
  session_id: string;
  reasoning_node?: string;
  feedback_type?: string;
  comment?: string;
}

const MEMORY_URL = process.env.MEMORY_URL || 'http://localhost:8004';

@Controller('feedback')
export class FeedbackController {
  private readonly logger = new Logger(FeedbackController.name);

  constructor(private readonly events: RedisEventService) {}

  @Post()
  async submitFeedback(@Body() req: FeedbackRequest) {
    this.logger.log(`Feedback: session=${req.session_id}, type=${req.feedback_type || 'correction'}`);

    try {
      const res = await axios.post(`${MEMORY_URL}/internal/memory/feedback`, {
        session_id: req.session_id,
        node_id: req.reasoning_node || '',
        feedback_type: req.feedback_type || 'correction',
        comment: req.comment || '',
      });

      await this.events.publish('FeedbackReceived', req.session_id, {
        feedback_type: req.feedback_type || 'correction',
        comment: req.comment || '',
      });

      return res.data;
    } catch (err: any) {
      throw new HttpException(
        { error: 'Feedback submission failed', detail: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
