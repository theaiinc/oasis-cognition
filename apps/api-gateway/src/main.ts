import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.use(json({ limit: '2mb' }));  // Allow large payloads (screen share images)
  app.setGlobalPrefix('api/v1');

  const port = process.env.PORT || 8000;
  await app.listen(port);
  console.log(`Oasis Cognition API Gateway running on port ${port}`);
}
bootstrap();
