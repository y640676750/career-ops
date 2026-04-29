import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(backendRoot, '..');

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '0.0.0.0',
  port: 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  httpJsonLimit: process.env.HTTP_JSON_LIMIT || '512kb',
  maxHtmlChars: parsePositiveInteger(process.env.MAX_HTML_CHARS, 200000),
  maxUploadBytes: parsePositiveInteger(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
  maxResumeTextChars: parsePositiveInteger(process.env.MAX_RESUME_TEXT_CHARS, 60000),
  maxBatchJobs: parsePositiveInteger(process.env.MAX_BATCH_JOBS, 10),
  serverRequestTimeoutMs: parsePositiveInteger(process.env.SERVER_REQUEST_TIMEOUT_MS, 180000),
  pdfRenderTimeoutMs: parsePositiveInteger(process.env.PDF_RENDER_TIMEOUT_MS, 45000),
  pdfKeepCompletedJobs: parsePositiveInteger(process.env.PDF_KEEP_COMPLETED_JOBS, 50),
  pdfKeepFailedJobs: parsePositiveInteger(process.env.PDF_KEEP_FAILED_JOBS, 20),
  resumeKeepCompletedJobs: parsePositiveInteger(process.env.RESUME_KEEP_COMPLETED_JOBS, 50),
  resumeKeepFailedJobs: parsePositiveInteger(process.env.RESUME_KEEP_FAILED_JOBS, 20),
  resumeJobTimeoutMs: parsePositiveInteger(process.env.RESUME_JOB_TIMEOUT_MS, 180000),
  redisUrl: process.env.REDIS_URL || '',
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '',
  appDbPath: process.env.APP_DB_PATH || path.join(backendRoot, 'storage', 'app.db'),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  deepseekTimeoutMs: parsePositiveInteger(process.env.DEEPSEEK_TIMEOUT_MS, 90000),
  visionApiKey: process.env.VISION_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  visionBaseUrl: (process.env.VISION_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  visionModel: process.env.VISION_MODEL || '',
  visionFallbackModels: parseCsv(process.env.VISION_FALLBACK_MODELS),
  visionTimeoutMs: parsePositiveInteger(process.env.VISION_TIMEOUT_MS, 180000),
  maxJdImageBytes: parsePositiveInteger(process.env.MAX_JD_IMAGE_BYTES, 3 * 1024 * 1024),
  wechatApiBaseUrl: (process.env.WECHAT_API_BASE_URL || 'https://api.weixin.qq.com').replace(/\/+$/, ''),
  wechatAppId: process.env.WECHAT_APP_ID || '',
  wechatAppSecret: process.env.WECHAT_APP_SECRET || '',
  wechatLoginTimeoutMs: parsePositiveInteger(process.env.WECHAT_LOGIN_TIMEOUT_MS, 15000),
  wechatAllowDevLogin: parseBoolean(process.env.WECHAT_ALLOW_DEV_LOGIN, true),
  billingAllowMockPay: parseBoolean(process.env.BILLING_ALLOW_MOCK_PAY, true),
  sessionTtlHours: parsePositiveInteger(process.env.SESSION_TTL_HOURS, 168),
  backendRoot,
  repoRoot,
  templatesDir: path.join(repoRoot, 'templates'),
  fontsDir: path.join(repoRoot, 'fonts'),
  storageRoot: path.join(backendRoot, 'storage'),
  uploadTempDir: path.join(os.tmpdir(), 'career-ops-uploads'),
  pdfOutputDir: path.join(backendRoot, 'storage', 'pdf')
});
