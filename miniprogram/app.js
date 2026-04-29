App({
  globalData: {
    apiBaseUrl: 'https://api.myootdai.com'
  },

  onLaunch() {
    const token = wx.getStorageSync('careerOps.sessionToken');
    const user = wx.getStorageSync('careerOps.user');

    this.globalData.sessionToken = token || '';
    this.globalData.user = user || null;
  },

  setSession(session) {
    this.globalData.sessionToken = session && session.token ? session.token : '';
    this.globalData.user = session && session.user ? session.user : null;

    wx.setStorageSync('careerOps.sessionToken', this.globalData.sessionToken);
    wx.setStorageSync('careerOps.user', this.globalData.user);
    wx.setStorageSync('careerOps.sessionExpiresAt', session && session.expiresAt ? session.expiresAt : '');
  },

  clearSession() {
    this.globalData.sessionToken = '';
    this.globalData.user = null;

    wx.removeStorageSync('careerOps.sessionToken');
    wx.removeStorageSync('careerOps.user');
    wx.removeStorageSync('careerOps.sessionExpiresAt');
  },

  getSessionToken() {
    return this.globalData.sessionToken || wx.getStorageSync('careerOps.sessionToken') || '';
  },

  getUser() {
    return this.globalData.user || wx.getStorageSync('careerOps.user') || null;
  }
});
