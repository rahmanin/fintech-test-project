import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorFilter } from './common/api-error.filter';

/**
 * Application-level wiring shared by main.ts and the e2e tests, so tests run
 * against exactly the pipes, filters and prefixes production uses.
 */
export function configureApp(app: INestApplication): void {
  // Business endpoints live under /api/v1; /health and /docs stay at the root.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  // whitelist + forbidNonWhitelisted: unknown fields are an error, not silently
  // dropped, so a client typo ("ammount") cannot pass validation as an
  // "optional" field. transform: DTO classes are instantiated so their
  // validators and types apply.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ApiErrorFilter());

  const swagger = new DocumentBuilder()
    .setTitle('Program Capacity & Invoice Reservation')
    .setDescription(
      'Reserve and release invoice amounts against a financing program limit. ' +
        'Obtain a token from POST /api/v1/auth/token, then click Authorize.',
    )
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
}
