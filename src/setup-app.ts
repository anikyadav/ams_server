import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

export function setupApp(app: INestApplication, corsOrigin: string) {
  app.enableCors({ origin: corsOrigin });
  const config = new DocumentBuilder()
    .setTitle('Audit Practice API')
    .setDescription(
      'Engagement management MVP. Business endpoints are added in subsequent steps.',
    )
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, cleanupOpenApiDoc(document));
}
