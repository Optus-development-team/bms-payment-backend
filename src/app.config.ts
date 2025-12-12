import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const configureApp = (app: INestApplication): void => {
  const allowedOrigins = [
    'https://unchopped-juliette-apostatically.ngrok-free.dev',
    'https://optsms-backend.vercel.app',
  ];
  const localNetworkPattern =
    /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin) || localNetworkPattern.test(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Origin',
      'x-internal-api-key',
      'X-PAYMENT',
      'X-PAYMENT-REQUIRED',
      'Authorization',
    ],
    optionsSuccessStatus: 204,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('BMS Payment Backend')
    .setDescription(
      'Automation worker responsible for Ecofuturo bank interactions and x402 cryptocurrency payments on Avalanche Fuji.',
    )
    .setVersion('1.0.0')
    .addTag('Fiat Automation')
    .addTag(
      'x402 Payments',
      'HTTP 402 Payment Required protocol for cryptocurrency payments',
    )
    .addServer('http://localhost:3000', 'Local development')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-internal-api-key',
        in: 'header',
      },
      'internal-api-key',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-PAYMENT',
        in: 'header',
        description:
          'Base64-encoded x402 payment payload with EIP-3009 authorization',
      },
      'x402-payment',
    )
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument, {
    customSiteTitle: 'BMS Payment Backend API',
    customCssUrl:
      'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css',
    customfavIcon:
      'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/favicon-32x32.png',
    customJs: [
      'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js',
      'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js',
    ],
  });
};
