import { env } from '../config/env.js';
import { buildAbstractPromptPack, isAbstractModeEnabled } from './abstractResumeMode.js';

function extractJsonPayload(text) {
  const normalized = String(text || '').trim();
  const fencedMatch = normalized.match(/```json\s*([\s\S]*?)```/i) || normalized.match(/```\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }

  return normalized;
}

function getFirstMessageContent(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function buildAuthorizationHeader(baseUrl, apiKey) {
  const normalizedBaseUrl = String(baseUrl || '').toLowerCase();
  if (normalizedBaseUrl.includes('api.clarifai.com')) {
    return `Key ${apiKey}`;
  }

  return `Bearer ${apiKey}`;
}

function parseResponseBody(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    return {
      rawText: String(text || '')
    };
  }
}

function buildUpstreamErrorMessage(body, status) {
  return (
    body?.error?.message ||
    body?.message ||
    body?.status?.description ||
    body?.detail ||
    `Model request failed with ${status}.`
  );
}

function createInvalidJsonError(label, rawContent, cause) {
  const error = new Error(`${label} returned invalid JSON.`);
  error.statusCode = 502;
  error.code = 'MODEL_JSON_INVALID';
  error.rawContent = String(rawContent || '');
  error.cause = cause;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableCompletionError(error) {
  const upstreamStatus = Number(error?.upstreamStatus || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(upstreamStatus)) {
    return true;
  }

  return /abort|timeout|temporarily unavailable|overloaded|try again|fetch failed/i.test(String(error?.message || ''));
}

function isVisionModelFallbackError(error) {
  const upstreamStatus = Number(error?.upstreamStatus || 0);
  return upstreamStatus === 404 || isRetriableCompletionError(error);
}

function uniqueStrings(items) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function getVisionModelCandidates() {
  const candidates = [env.visionModel, ...(env.visionFallbackModels || [])];
  if (String(env.visionBaseUrl || '').includes('generativelanguage.googleapis.com')) {
    candidates.push('gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash');
  }

  return uniqueStrings(candidates);
}

function parseJsonObjectFromContent(rawContent, label = 'Model response') {
  try {
    return JSON.parse(extractJsonPayload(rawContent));
  } catch (error) {
    throw createInvalidJsonError(label, rawContent, error);
  }
}

async function requestOpenAICompatibleCompletion({
  baseUrl,
  apiKey,
  model,
  timeoutMs,
  temperature,
  messages,
  maxTokens,
  parseJson = true,
  responseFormat = null,
  retryCount = 0,
  retryDelayMs = 900
}) {
  let lastError = null;

  for (let attemptIndex = 0; attemptIndex <= retryCount; attemptIndex += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const payload = {
        model,
        temperature,
        messages
      };

      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        payload.max_tokens = maxTokens;
      }

      if (responseFormat && typeof responseFormat === 'object') {
        payload.response_format = responseFormat;
      }

      const response = await fetch(`${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: buildAuthorizationHeader(baseUrl, apiKey)
        },
        body: JSON.stringify(payload)
      });

      const responseText = await response.text();
      const body = parseResponseBody(responseText);

      if (!response.ok) {
        const error = new Error(buildUpstreamErrorMessage(body, response.status));
        error.statusCode = 502;
        error.upstreamStatus = response.status;
        throw error;
      }

      const rawContent = getFirstMessageContent(body);
      if (!rawContent) {
        const error = new Error('Model returned an empty response.');
        error.statusCode = 502;
        throw error;
      }

      if (!parseJson) {
        return rawContent;
      }

      return parseJsonObjectFromContent(rawContent);
    } catch (error) {
      lastError = error;
      if (attemptIndex >= retryCount || !isRetriableCompletionError(error)) {
        throw error;
      }

      await sleep(retryDelayMs * (attemptIndex + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export function hasDeepSeekConfig() {
  return Boolean(env.deepseekApiKey);
}

export function hasVisionConfig() {
  return Boolean(env.visionApiKey && env.visionModel && env.visionBaseUrl);
}

export async function generateResumeCustomizationWithDeepSeek(payload) {
  if (!hasDeepSeekConfig()) {
    throw new Error('DEEPSEEK_API_KEY is not configured.');
  }

  const abstractMode = isAbstractModeEnabled(payload);
  const abstractPack = abstractMode ? buildAbstractPromptPack() : null;

  return requestOpenAICompatibleCompletion({
    baseUrl: env.deepseekBaseUrl,
    apiKey: env.deepseekApiKey,
    model: env.deepseekModel,
    timeoutMs: env.deepseekTimeoutMs,
    temperature: 0.2,
    maxTokens: 2400,
    messages: [
      {
        role: 'system',
        content: abstractMode
          ? [
              'You are an absurdist resume generator for an optional playful mode inside a WeChat mini-program backend.',
              'Return strict JSON only.',
              'Keep the output schema exactly unchanged so it can be rendered by the existing HTML/PDF templates.',
              'The resume must read like a polished professional document on the surface, but the actual content should be surreal, humorous, meme-heavy, and intentionally ridiculous.',
              'Every summary, bullet, project description, certification, and skill block must contain visible humor, absurd contrast, or meme energy.',
              'The joke density should be obvious within the first two lines. Avoid sounding like a normal serious resume unless the seriousness itself becomes the joke.',
              'Do not change field names, nesting, array types, or object keys.',
              `Use this dominant writing style: ${abstractPack.style}.`,
              `Inject or remix several joke honors from this pool: ${abstractPack.awards.join(' / ')}.`,
              `Inject or remix several joke skills or identities from this pool: ${abstractPack.skills.join(' / ')}.`,
              'Keep companyName, roleTitle, and the overall target role direction recognizable, but rewrite summaries, bullets, project descriptions, certifications, and skills into荒诞整活版本.',
              'Keep each bullet and sentence reasonably concise so the existing resume templates remain visually stable.',
              'Use Chinese by default when the request language is zh.',
              'Output this shape:',
              '{"candidate":{"name":"","birthDate":"","email":"","linkedinUrl":"","portfolioUrl":"","location":"","summary":"","competencies":[],"experience":[{"company":"","role":"","location":"","period":"","bullets":[]}],"projects":[{"title":"","badge":"","description":"","tech":""}],"education":[{"title":"","org":"","year":"","description":""}],"certifications":[{"title":"","org":"","year":""}],"skills":[{"category":"","items":[]}]},"keywords":[],"notes":""}'
            ].join(' ')
          : [
              'You are a resume personalization engine for a WeChat mini-program backend.',
              'Return strict JSON only.',
              'Preserve factual integrity. Never invent experience, projects, dates, employers, or credentials.',
              'Rephrase and reorder existing content to better match the target role.',
              'Output this shape:',
              '{"candidate":{"name":"","birthDate":"","email":"","linkedinUrl":"","portfolioUrl":"","location":"","summary":"","competencies":[],"experience":[{"company":"","role":"","location":"","period":"","bullets":[]}],"projects":[{"title":"","badge":"","description":"","tech":""}],"education":[{"title":"","org":"","year":"","description":""}],"certifications":[{"title":"","org":"","year":""}],"skills":[{"category":"","items":[]}]},"keywords":[],"notes":""}'
            ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify(payload)
      }
    ]
  });
}

export async function generateStructuredResumeFromGuidedInput(payload) {
  if (!hasDeepSeekConfig()) {
    throw new Error('DEEPSEEK_API_KEY is not configured.');
  }

  return requestOpenAICompatibleCompletion({
    baseUrl: env.deepseekBaseUrl,
    apiKey: env.deepseekApiKey,
    model: env.deepseekModel,
    timeoutMs: env.deepseekTimeoutMs,
    temperature: 0.3,
    maxTokens: 2200,
    messages: [
      {
        role: 'system',
        content: [
          'You are a Chinese resume editor.',
          'Turn the user\'s plain-language profile into a professional but truthful base resume.',
          'Never invent employers, internships, dates, education, certificates, awards, or measured achievements.',
          'If the user has little or no project experience, create a complete fresh-graduate resume by framing non-fabricated content as coursework, campus practice, personal portfolio, role research, and simulated role exercises.',
          'For fresh graduates, produce at least two role-matched projects and one campus/coursework practice section, but label them clearly as 课程项目、校园实践、个人作品集 or 岗位模拟.',
          'Do not claim real company employment, real internship history, certificates, awards, revenue, user volume, or metrics unless the user supplied them.',
          'Make the resume look complete, confident, and targeted to the desired role while staying honest about the source of each experience.',
          'Return strict JSON only.',
          'Output this shape:',
          '{"candidate":{"name":"","birthDate":"","email":"","linkedinUrl":"","portfolioUrl":"","location":"","summary":"","competencies":[],"experience":[{"company":"","role":"","location":"","period":"","bullets":[]}],"projects":[{"title":"","badge":"","description":"","tech":""}],"education":[{"title":"","org":"","year":"","description":""}],"certifications":[{"title":"","org":"","year":""}],"skills":[{"category":"","items":[]}]},"notes":""}'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify(payload)
      }
    ]
  });
}

export async function extractTargetJobFromVisionImage({ mimeType, base64Data, fileName }) {
  if (!hasVisionConfig()) {
    const error = new Error('VISION_API_KEY, VISION_BASE_URL, and VISION_MODEL must be configured for JD screenshot extraction.');
    error.statusCode = 503;
    throw error;
  }

  const attempts = [
    {
      maxTokens: 900,
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'jd_extraction',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              companyName: { type: 'string', description: 'Company name shown in the screenshot.' },
              roleTitle: { type: 'string', description: 'Role title shown in the screenshot.' },
              description: { type: 'string', description: 'Concise JD summary with the most relevant duties and requirements.' },
              confidence: { type: 'string', description: 'Optional confidence hint.' },
              rawText: { type: 'string', description: 'Keep empty unless a short excerpt is necessary.' }
            },
            required: ['companyName', 'roleTitle', 'description', 'confidence', 'rawText'],
            additionalProperties: false
          }
        }
      },
      systemText: [
        'You extract hiring information from job description screenshots.',
        'Read the screenshot carefully and return strict JSON only with no markdown fences.',
        'Extract companyName, roleTitle, description, confidence, and rawText.',
        'Do not invent missing details. Leave uncertain fields as empty strings.',
        'Keep description under 320 Chinese characters or 500 English characters.',
        'Set rawText to an empty string unless a very short excerpt is absolutely necessary.',
        'Prefer shorter valid JSON over exhaustive OCR.',
        'Output this exact shape:',
        '{"companyName":"","roleTitle":"","description":"","confidence":"","rawText":""}'
      ].join(' '),
      userText: `提取公司名称、岗位名称和最关键的岗位详情。只返回合法 JSON。不要输出 markdown。若正文过长，请只保留最关键的职责、要求和加分项。文件名：${fileName || 'jd-image'}.`
    },
    {
      maxTokens: 520,
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'jd_extraction_short',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              companyName: { type: 'string' },
              roleTitle: { type: 'string' },
              description: { type: 'string' },
              confidence: { type: 'string' },
              rawText: { type: 'string' }
            },
            required: ['companyName', 'roleTitle', 'description', 'confidence', 'rawText'],
            additionalProperties: false
          }
        }
      },
      systemText: [
        'Return a single-line JSON object only.',
        'No markdown fences. No explanations.',
        'Keys must be companyName, roleTitle, description, confidence, rawText.',
        'Keep description extremely concise.',
        'If any field is uncertain, use an empty string.',
        'Output this exact shape:',
        '{"companyName":"","roleTitle":"","description":"","confidence":"","rawText":""}'
      ].join(' '),
      userText: `请从这张招聘截图中识别公司名、岗位名、JD摘要。只返回一行 JSON，不要附加说明。文件名：${fileName || 'jd-image'}.`
    }
  ];

  let lastError = null;
  const modelCandidates = getVisionModelCandidates();

  for (const modelCandidate of modelCandidates) {
    for (const attempt of attempts) {
      try {
        const rawContent = await requestOpenAICompatibleCompletion({
          baseUrl: env.visionBaseUrl,
          apiKey: env.visionApiKey,
          model: modelCandidate,
          timeoutMs: env.visionTimeoutMs,
          temperature: 0,
          maxTokens: attempt.maxTokens,
          parseJson: false,
          responseFormat: attempt.responseFormat,
          retryCount: 2,
          retryDelayMs: 1200,
          messages: [
            {
              role: 'system',
              content: attempt.systemText
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: attempt.userText
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64Data}`
                  }
                }
              ]
            }
          ]
        });

        return parseJsonObjectFromContent(rawContent, 'JD screenshot extraction');
      } catch (error) {
        lastError = error;
        if (error?.code === 'MODEL_JSON_INVALID') {
          continue;
        }

        if (isVisionModelFallbackError(error)) {
          console.warn(`[vision] ${modelCandidate} failed with ${error.upstreamStatus || error.statusCode || 'network'}; trying fallback if available.`);
          break;
        }

        throw error;
      }
    }
  }

  if (lastError && lastError.code !== 'MODEL_JSON_INVALID') {
    const error = new Error('视觉识别服务暂时不可用，请稍后重试，或先手动粘贴岗位 JD。');
    error.statusCode = 503;
    error.code = 'VISION_PROVIDER_UNAVAILABLE';
    error.cause = lastError;
    throw error;
  }

  const error = new Error('岗位截图识别结果不完整，请重新上传更清晰的截图，或改用手动粘贴 JD。');
  error.statusCode = 422;
  error.code = 'VISION_RESULT_INVALID';
  error.cause = lastError;
  throw error;
}
