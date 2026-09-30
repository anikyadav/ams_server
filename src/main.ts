import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import type { Environment } from './config/environment';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Environment, true>);
  setupApp(app, config.get('CORS_ORIGIN', { infer: true }));
  app.enableShutdownHooks();
  await app.listen(config.get('PORT', { infer: true }));
}
void bootstrap();
