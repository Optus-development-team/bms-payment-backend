import { NestFactory } from '@nestjs/core';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

let cachedServer: ((req: VercelRequest, res: VercelResponse) => void) | null = null;

const bootstrapServer = async () => {
  if (cachedServer) {
    return cachedServer;
  }

  const app = await NestFactory.create(AppModule, { bodyParser: true });
  configureApp(app);
  await app.init();

  cachedServer = app.getHttpAdapter().getInstance();
  return cachedServer;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const server = await bootstrapServer();
  return server?.(req, res);
}
