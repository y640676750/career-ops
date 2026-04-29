const { request } = require('./request');

function callWxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res.code) {
          resolve(res.code);
          return;
        }

        reject(new Error('没有拿到微信登录 code'));
      },
      fail(error) {
        reject(new Error(error.errMsg || 'wx.login 调用失败'));
      }
    });
  });
}

function callGetUserProfileOptional() {
  return new Promise((resolve) => {
    if (typeof wx.getUserProfile !== 'function') {
      resolve({});
      return;
    }

    wx.getUserProfile({
      desc: '用于登录',
      success(res) {
        resolve(res.userInfo || {});
      },
      fail(error) {
        console.warn('[miniprogram] getUserProfile skipped:', error.errMsg || 'unknown error');
        resolve({});
      }
    });
  });
}

function requirePrivacyAuthIfNeeded() {
  return new Promise((resolve, reject) => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      resolve();
      return;
    }

    wx.requirePrivacyAuthorize({
      success() {
        resolve();
      },
      fail(error) {
        reject(new Error(error.errMsg || '未完成隐私授权'));
      }
    });
  });
}

async function ensureWechatAuthorizedLogin() {
  await requirePrivacyAuthIfNeeded();
  const code = await callWxLogin();
  const userInfo = await callGetUserProfileOptional();

  const session = await request({
    url: '/api/v1/wechat/login',
    method: 'POST',
    data: {
      code,
      profile: userInfo
    },
    auth: false
  });

  const app = getApp();
  app.setSession({
    token: session.token,
    expiresAt: session.expiresAt,
    user: session.user
  });

  return session;
}

function clearSession() {
  getApp().clearSession();
}

function getStoredUser() {
  return getApp().getUser();
}

module.exports = {
  ensureWechatAuthorizedLogin,
  clearSession,
  getStoredUser
};
