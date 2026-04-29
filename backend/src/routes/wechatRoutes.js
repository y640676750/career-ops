import { Router } from 'express';
import { buildWechatUser, resolveWechatIdentity } from '../services/wechatAuth.js';
import { createSession, deleteSession } from '../data/sessionStore.js';
import { requireSession } from '../middleware/sessionAuth.js';

function validateLoginPayload(body = {}) {
  return {
    code: typeof body.code === 'string' ? body.code.trim() : '',
    mockOpenId: typeof body.mockOpenId === 'string' ? body.mockOpenId.trim() : '',
    profile: body.profile && typeof body.profile === 'object' ? body.profile : {}
  };
}

export function createWechatRouter() {
  const router = Router();

  router.post('/login', async (req, res, next) => {
    try {
      const payload = validateLoginPayload(req.body);
      const identity = await resolveWechatIdentity(payload);
      if (identity.mode === 'wechat') {
        console.log(`[wechat] Real login resolved openId=${identity.openId} unionId=${identity.unionId || '-'}`);
      }
      const user = buildWechatUser(identity, payload.profile);
      const session = createSession({
        openId: identity.openId,
        unionId: identity.unionId,
        sessionKey: identity.sessionKey,
        user
      });

      return res.status(201).json({
        status: 'ok',
        mode: identity.mode,
        token: session.token,
        expiresAt: session.expiresAt,
        user: session.user
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', requireSession, (req, res) => {
    res.json({
      status: 'ok',
      user: req.session.user,
      expiresAt: req.session.expiresAt
    });
  });

  router.post('/logout', requireSession, (req, res) => {
    deleteSession(req.session.token);
    res.json({
      status: 'ok',
      message: 'Session cleared.'
    });
  });

  return router;
}
