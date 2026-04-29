import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { env } from '../config/env.js';
import { ensurePdfOutputDir, createPdfTarget } from '../utils/fileStore.js';
import { runGarbageCollectionIfAvailable, safeCloseBrowser, safeClosePage } from '../utils/memory.js';
import { resolveRenderableHtml } from './templateRenderer.js';

export const LOW_MEMORY_PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--single-process',
  '--no-zygote'
];

function getRuntimeLaunchArgs() {
  if (process.platform === 'win32') {
    return LOW_MEMORY_PUPPETEER_ARGS.filter((arg) => arg !== '--single-process');
  }

  return LOW_MEMORY_PUPPETEER_ARGS;
}

function normalizePaperFormat(formatValue) {
  if (typeof formatValue !== 'string') {
    return 'A4';
  }

  const normalized = formatValue.trim().toLowerCase();
  if (normalized === 'letter') {
    return 'Letter';
  }

  if (normalized === 'legal') {
    return 'Legal';
  }

  return 'A4';
}

function normalizePdfOptions(pdfOptions = {}) {
  return {
    format: normalizePaperFormat(pdfOptions.format),
    printBackground: true,
    preferCSSPageSize: true,
    margin: pdfOptions.margin || {
      top: '6mm',
      right: '6mm',
      bottom: '6mm',
      left: '6mm'
    }
  };
}

export async function renderHtmlToPdfSerial(payload) {
  return renderHtmlToPdf(payload);
}

export async function renderHtmlToPdf({ fileName, pdfOptions = {}, ...htmlPayload }) {
  await ensurePdfOutputDir();

  const html = await resolveRenderableHtml(htmlPayload);
  if (html.length > env.maxHtmlChars) {
    const error = new Error(`HTML payload exceeds ${env.maxHtmlChars} characters.`);
    error.statusCode = 413;
    throw error;
  }

  const target = createPdfTarget(fileName);
  let browser = null;
  let page = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: env.puppeteerExecutablePath || undefined,
      args: getRuntimeLaunchArgs(),
      protocolTimeout: env.pdfRenderTimeoutMs
    });

    page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(env.pdfRenderTimeoutMs);
    page.setDefaultTimeout(env.pdfRenderTimeoutMs);
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: env.pdfRenderTimeoutMs
    });
    await page.emulateMediaType('screen');
    await page.pdf({
      path: target.absolutePath,
      ...normalizePdfOptions(pdfOptions)
    });

    const fileStats = await fs.stat(target.absolutePath);

    return {
      fileName: target.fileName,
      absolutePath: target.absolutePath,
      bytes: fileStats.size,
      createdAt: new Date().toISOString()
    };
  } finally {
    await safeClosePage(page);
    page = null;

    await safeCloseBrowser(browser);
    browser = null;

    runGarbageCollectionIfAvailable();
  }
}
