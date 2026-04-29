import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';

const SAFE_TEMPLATE_NAME = /^[a-zA-Z0-9-_]+$/;
const DEFAULT_TEMPLATE_DATA = Object.freeze({
  LANG: 'en',
  PAGE_WIDTH: '8.27in'
});
const BODY_FONT_STACK = [
  "'DM Sans'",
  "'PingFang SC'",
  "'Hiragino Sans GB'",
  "'Microsoft YaHei'",
  "'Noto Sans CJK SC'",
  "'Noto Sans SC'",
  "'WenQuanYi Micro Hei'",
  "'Segoe UI'",
  'sans-serif'
].join(', ');
const DISPLAY_FONT_STACK = [
  "'Space Grotesk'",
  "'PingFang SC'",
  "'Hiragino Sans GB'",
  "'Microsoft YaHei'",
  "'Noto Sans CJK SC'",
  "'Noto Sans SC'",
  "'WenQuanYi Micro Hei'",
  "'Segoe UI'",
  'sans-serif'
].join(', ');

function ensureSafeTemplateName(templateName) {
  if (!SAFE_TEMPLATE_NAME.test(templateName)) {
    const error = new Error('Invalid template name.');
    error.statusCode = 400;
    throw error;
  }
}

export function injectProjectFontUrls(html) {
  const fontsBaseUrl = pathToFileURL(`${env.fontsDir}${path.sep}`).href;
  return html.replace(/url\((['"]?)(?:\.\/)?fonts\/([^'")]+)\1\)/g, (_match, _quote, fileName) => {
    return `url('${fontsBaseUrl}${fileName}')`;
  });
}

export function injectCjkFontFallbacks(html) {
  const fallbackStyle = `
<style id="career-ops-cjk-font-fallback">
  body,
  body * {
    font-family: ${BODY_FONT_STACK} !important;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  h1,
  h2,
  h3,
  .section-title,
  .job-company,
  .project-title,
  .skill-category,
  .edu-title,
  .cert-title {
    font-family: ${DISPLAY_FONT_STACK} !important;
  }
<\/style>`;

  return html.includes('</head>')
    ? html.replace('</head>', `${fallbackStyle}\n</head>`)
    : `${fallbackStyle}\n${html}`;
}

export async function renderProjectTemplate(templateName = 'cv-template', templateData = {}) {
  ensureSafeTemplateName(templateName);

  const templatePath = path.join(env.templatesDir, `${templateName}.html`);
  const template = await fs.readFile(templatePath, 'utf8');
  const mergedData = {
    ...DEFAULT_TEMPLATE_DATA,
    ...(templateData || {})
  };

  const renderedHtml = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = mergedData[key];
    return value === undefined || value === null ? '' : String(value);
  });

  return injectCjkFontFallbacks(injectProjectFontUrls(renderedHtml));
}

export async function resolveRenderableHtml(payload) {
  if (typeof payload.html === 'string' && payload.html.trim()) {
    return injectCjkFontFallbacks(injectProjectFontUrls(payload.html.trim()));
  }

  if (payload.templateData && typeof payload.templateData === 'object') {
    return renderProjectTemplate(payload.templateName || 'cv-template', payload.templateData);
  }

  const error = new Error('Either `html` or `templateData` is required.');
  error.statusCode = 400;
  throw error;
}
