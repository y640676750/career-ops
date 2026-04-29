import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { env } from './config/env.js';
import { createBillingRouter } from './routes/billingRoutes.js';
import { createPdfRouter } from './routes/pdfRoutes.js';
import { createRedeemRouter } from './routes/redeemRoutes.js';
import { createResumeRouter } from './routes/resumeRoutes.js';
import { createWechatRouter } from './routes/wechatRoutes.js';

const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Disposition']
};

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(express.json({ limit: env.httpJsonLimit }));
  app.use(express.urlencoded({ extended: false, limit: env.httpJsonLimit }));

  app.get('/ping', (req, res) => {
    res.json({ status: 'ok', message: 'API runs on port 3000' });
  });

  app.get('/', (req, res) => {
    return res.sendFile(path.join(env.repoRoot, 'frontend', 'index.html'));
  });

  app.use('/api/v1/billing', createBillingRouter());
  app.use('/api/v1', createRedeemRouter());
  app.use('/api/v1/pdf', createPdfRouter());
  app.use('/api/v1/wechat', createWechatRouter());
  app.use('/api/v1/resume', createResumeRouter());

  app.use((req, res) => {
    res.status(404).json({
      status: 'error',
      message: 'Route not found.'
    });
  });

  app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      console.error('[api] Unhandled error:', error);
    }

    res.status(statusCode).json({
      status: 'error',
      message: error.message || 'Internal server error.'
    });
  });

  return app;
}
