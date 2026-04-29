import crypto from 'node:crypto';
import { env } from '../config/env.js';

function normalizeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function sanitizeProfile(profile = {}) {
  return {
    nickName: normalizeString(profile.nickName),
    avatarUrl: normalizeString(profile.avatarUrl)
  };
}

function buildMockIdentity(code, mockOpenId) {
  const seed = normalizeString(mockOpenId || code, 'wechat-dev-user');
  const hash = crypto.createHash('sha256').update(seed).digest('hex');

  return {
    mode: 'dev-mock',
    openId: `dev_${hash.slice(0, 24)}`,
    unionId: '',
    sessionKey: `mock_${hash.slice(0, 32)}`
  };
}

export function hasWechatConfig() {
  return Boolean(env.wechatAppId && env.wechatAppSecret);
}

export async function resolveWechatIdentity({ code, mockOpenId }) {
  const loginCode = normalizeString(code);

  if (hasWechatConfig()) {
    if (!loginCode) {
      const error = new Error('`code` is required for WeChat login.');
      error.statusCode = 400;
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.wechatLoginTimeoutMs);

    try {
      const searchParams = new URLSearchParams({
        appid: env.wechatAppId,
        secret: env.wechatAppSecret,
        js_code: loginCode,
        grant_type: 'authorization_code'
      });

      const response = await fetch(`${env.wechatApiBaseUrl}/sns/jscode2session?${searchParams}`, {
        signal: controller.signal
      });
      const payload = await response.json();

      if (!response.ok || payload.errcode) {
        const error = new Error(payload.errmsg || `WeChat login failed with status ${response.status}.`);
        error.statusCode = 502;
        throw error;
      }

      return {
        mode: 'wechat',
        openId: payload.openid,
        unionId: payload.unionid || '',
        sessionKey: payload.session_key || ''
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!env.wechatAllowDevLogin) {
    const error = new Error('WeChat login is not configured on the server.');
    error.statusCode = 503;
    throw error;
  }

  return buildMockIdentity(loginCode, mockOpenId);
}

export function buildWechatUser(identity, profile) {
  return {
    source: identity.mode,
    openId: identity.openId,
    unionId: identity.unionId || '',
    profile: sanitizeProfile(profile)
  };
}
