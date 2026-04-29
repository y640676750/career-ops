#!/usr/bin/env node

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOW_MEMORY_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--single-process',
  '--no-zygote'
];

function getRuntimeLaunchArgs() {
  if (process.platform === 'win32') {
    return LOW_MEMORY_BROWSER_ARGS.filter((arg) => arg !== '--single-process');
  }

  return LOW_MEMORY_BROWSER_ARGS;
}

function rewriteFontUrls(html) {
  const fontsBaseUrl = pathToFileURL(resolve(__dirname, 'fonts') + '/').href;
  return html.replace(/url\((['"]?)(?:\.\/)?fonts\/([^'")]+)\1\)/g, (_match, _quote, fileName) => {
    return `url('${fontsBaseUrl}${fileName}')`;
  });
}

function triggerGarbageCollectionIfAvailable() {
  if (typeof global.gc !== 'function') {
    return;
  }

  try {
    global.gc();
  } catch (error) {
    console.warn('[pdf] global.gc() failed:', error.message);
  }
}

async function closePageSafely(page) {
  if (!page) {
    return;
  }

  try {
    if (!page.isClosed()) {
      await page.close();
    }
  } catch (error) {
    console.warn('[pdf] Failed to close page:', error.message);
  }
}

async function closeBrowserSafely(browser) {
  if (!browser) {
    return;
  }

  try {
    const pages = await browser.pages();
    await Promise.allSettled(pages.map((page) => closePageSafely(page)));
  } catch (error) {
    console.warn('[pdf] Failed to close browser pages:', error.message);
  }

  try {
    await browser.close();
  } catch (error) {
    console.warn('[pdf] Failed to close browser:', error.message);
  }
}

async function generatePDF() {
  const args = process.argv.slice(2);
  let inputPath;
  let outputPath;
  let format = 'a4';
  let browser = null;
  let page = null;

  for (const arg of args) {
    if (arg.startsWith('--format=')) {
      format = arg.split('=')[1].toLowerCase();
    } else if (!inputPath) {
      inputPath = arg;
    } else if (!outputPath) {
      outputPath = arg;
    }
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]');
    process.exit(1);
  }

  inputPath = resolve(inputPath);
  outputPath = resolve(outputPath);

  const validFormats = ['a4', 'letter'];
  if (!validFormats.includes(format)) {
    console.error(`Invalid format "${format}". Use: ${validFormats.join(', ')}`);
    process.exit(1);
  }

  console.log(`[pdf] Input: ${inputPath}`);
  console.log(`[pdf] Output: ${outputPath}`);
  console.log(`[pdf] Format: ${format.toUpperCase()}`);

  try {
    const html = rewriteFontUrls(await readFile(inputPath, 'utf-8'));

    browser = await chromium.launch({
      headless: true,
      args: getRuntimeLaunchArgs()
    });

    page = await browser.newPage({
      viewport: { width: 1240, height: 1754 }
    });

    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(45000);

    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      baseURL: pathToFileURL(dirname(inputPath) + '/').href
    });

    await page.emulateMedia({ media: 'screen' });
    await page.pdf({
      path: outputPath,
      format,
      printBackground: true,
      margin: {
        top: '0.6in',
        right: '0.6in',
        bottom: '0.6in',
        left: '0.6in'
      },
      preferCSSPageSize: false
    });

    const fileStats = await stat(outputPath);
    console.log(`[pdf] PDF generated: ${outputPath}`);
    console.log(`[pdf] Size: ${(fileStats.size / 1024).toFixed(1)} KB`);

    return { outputPath, size: fileStats.size };
  } finally {
    await closePageSafely(page);
    page = null;

    await closeBrowserSafely(browser);
    browser = null;

    triggerGarbageCollectionIfAvailable();
  }
}

generatePDF().catch((error) => {
  console.error('[pdf] PDF generation failed:', error.message);
  process.exit(1);
});
