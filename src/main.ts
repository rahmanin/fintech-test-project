import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { EnvConfig } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Business endpoints live under /api/v1; /health and /docs stay at the root.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  // whitelist + forbidNonWhitelisted: unknown fields are an error, not silently
  // dropped, so a client typo ("ammount") cannot pass validation as an
  // "optional" field. transform: DTO classes are instantiated so their
  // validators and types apply.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const swagger = new DocumentBuilder()
    .setTitle('Program Capacity & Invoice Reservation')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const config = app.get(ConfigService<EnvConfig, true>);
  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
