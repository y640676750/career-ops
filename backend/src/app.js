import express from 'express';
import cors from 'cors';
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
    const payload = {
      status: 'ok',
      message: 'Career Ops WeChat API is running.',
      docs: {
        ping: '/ping',
        wechatLogin: 'POST /api/v1/wechat/login',
        billingCatalog: 'GET /api/v1/billing/catalog',
        redeemStatus: 'GET /api/v1/redeem/status',
        redeemCode: 'POST /api/v1/redeem',
        resumeTemplates: 'GET /api/v1/resume/templates',
        resumeParse: 'POST /api/v1/resume/files/parse',
        resumeParseStatus: 'GET /api/v1/resume/files/parse/:jobId',
        customizeResume: 'POST /api/v1/resume/customize',
        customizeResumeAsync: 'POST /api/v1/resume/customize/async',
        customizeResumeBatch: 'POST /api/v1/resume/customize/batch',
        pdfRender: 'POST /api/v1/pdf/render'
      }
    };

    if (req.accepts('html')) {
      return res.type('html').send(`
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Career Ops API</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        background: linear-gradient(180deg, #f5f7fb 0%, #eef3ff 100%);
        color: #122033;
      }
      main {
        max-width: 720px;
        margin: 48px auto;
        padding: 32px 24px;
      }
      .card {
        background: #fff;
        border-radius: 18px;
        padding: 28px;
        box-shadow: 0 18px 50px rgba(18, 32, 51, 0.08);
      }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0 0 16px; line-height: 1.7; }
      ul {
        margin: 20px 0 0;
        padding-left: 20px;
        line-height: 1.8;
      }
      code {
        padding: 2px 6px;
        border-radius: 6px;
        background: #f2f5fb;
        font-family: Consolas, "SFMono-Regular", monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <h1>Career Ops API</h1>
        <p>服务已经启动。这个域名是微信小程序后端 API，不是前台页面。</p>
        <p>你可以先访问 <code>/ping</code> 做健康检查，再用 Postman 或 curl 测试下面这些接口。</p>
        <ul>
          <li><code>GET /ping</code></li>
          <li><code>POST /api/v1/wechat/login</code></li>
          <li><code>GET /api/v1/redeem/status</code></li>
          <li><code>POST /api/v1/redeem</code></li>
          <li><code>GET /api/v1/resume/templates</code></li>
          <li><code>POST /api/v1/resume/files/parse</code></li>
          <li><code>GET /api/v1/resume/files/parse/:jobId</code></li>
          <li><code>POST /api/v1/resume/customize</code></li>
          <li><code>POST /api/v1/resume/customize/async</code></li>
          <li><code>POST /api/v1/resume/customize/batch</code></li>
          <li><code>POST /api/v1/pdf/render</code></li>
        </ul>
      </section>
    </main>
  </body>
</html>`);
    }

    return res.json(payload);
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
