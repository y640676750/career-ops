const { API_BASE_URL } = require('./config');

function safeParseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    return {};
  }
}

function isSessionInvalidMessage(message) {
  return /session.*(invalid|expired)|token.*(invalid|expired)|登录.*(失效|过期)/i.test(String(message || ''));
}

function markSessionInvalidIfNeeded(error, payload, statusCode) {
  const message = payload && payload.message ? payload.message : error.message;
  if (statusCode === 401 || isSessionInvalidMessage(message)) {
    error.sessionInvalid = true;
    try {
      getApp().clearSession();
    } catch (_error) {
      wx.removeStorageSync('careerOps.sessionToken');
      wx.removeStorageSync('careerOps.user');
      wx.removeStorageSync('careerOps.sessionExpiresAt');
    }
  }

  return error;
}

function normalizeError(payload, fallback, statusCode) {
  const message = payload && payload.message ? payload.message : fallback;
  const error = new Error(message);
  error.statusCode = statusCode || 0;
  return markSessionInvalidIfNeeded(error, payload, statusCode);
}

function isSessionInvalidError(error) {
  return Boolean(error && (error.sessionInvalid || error.statusCode === 401 || isSessionInvalidMessage(error.message)));
}

function buildAuthHeaders(auth, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {});

  if (auth) {
    const token = wx.getStorageSync('careerOps.sessionToken');
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

function request(options) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE_URL + options.url,
      method: options.method || 'GET',
      data: options.data || undefined,
      timeout: options.timeout || 30000,
      header: buildAuthHeaders(options.auth !== false, {
        'Content-Type': 'application/json'
      }),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data || {});
          return;
        }

        reject(normalizeError(res.data, '请求失败', res.statusCode));
      },
      fail(error) {
        reject(new Error(error.errMsg || '网络异常'));
      }
    });
  });
}

function uploadFile(options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    const uploadTask = wx.uploadFile({
      url: API_BASE_URL + options.url,
      filePath: options.filePath,
      name: options.name || 'resumeFile',
      formData: options.formData || {},
      timeout: options.timeout || 60000,
      header: buildAuthHeaders(options.auth !== false),
      success(res) {
        const payload = safeParseJson(res.data);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          finish(resolve, payload);
          return;
        }

        finish(reject, normalizeError(payload, `上传失败（HTTP ${res.statusCode}）`, res.statusCode));
      },
      fail(error) {
        const message = error && error.errMsg
          ? `上传失败：${error.errMsg}`
          : '上传失败，请检查网络或小程序 uploadFile 合法域名配置。';
        finish(reject, new Error(message));
      }
    });

    const timeoutMs = Number(options.timeout || 60000);
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (settled) return;
        if (uploadTask && typeof uploadTask.abort === 'function') {
          uploadTask.abort();
        }
        finish(reject, new Error('上传超时，请检查网络后重试。'));
      }, timeoutMs + 1000);
    }

    if (uploadTask && typeof uploadTask.onProgressUpdate === 'function' && typeof options.onProgress === 'function') {
      uploadTask.onProgressUpdate(options.onProgress);
    }
  });
}

function downloadWithAuth(url, fileName) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('careerOps.sessionToken');
    const header = token ? { Authorization: `Bearer ${token}` } : {};

    wx.downloadFile({
      url,
      header,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.tempFilePath);
          return;
        }

        reject(normalizeError(safeParseJson(res.data), `${fileName || 'PDF'} 下载失败`, res.statusCode));
      },
      fail(error) {
        reject(new Error(error.errMsg || '下载失败'));
      }
    });
  });
}

module.exports = {
  request,
  uploadFile,
  downloadWithAuth,
  isSessionInvalidError
};
