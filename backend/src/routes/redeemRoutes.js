import { Router } from 'express';
import { requireSession } from '../middleware/sessionAuth.js';
import { getActivationAccess, redeemActivationCode } from '../data/activationStore.js';

function formatAccess(access) {
  return {
    isActive: access.isActive,
    expiresAt: access.expiresAt,
    remainingMs: access.remainingMs,
    remainingDays: access.remainingMs ? Math.ceil(access.remainingMs / (24 * 60 * 60 * 1000)) : 0
  };
}

export function createRedeemRouter() {
  const router = Router();

  router.use(requireSession);

  router.get('/redeem/status', (req, res) => {
    res.json({
      status: 'ok',
      access: formatAccess(getActivationAccess(req.session.openId))
    });
  });

  router.post('/redeem', (req, res, next) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const result = redeemActivationCode(req.session.openId, code);

      return res.json({
        status: 'ok',
        message: `激活成功，已解锁 ${result.validDays} 天高级版。`,
        code: {
          code: result.code,
          validDays: result.validDays
        },
        access: formatAccess({
          isActive: result.entitlement?.isActive === true,
          expiresAt: result.entitlement?.expiresAt || '',
          remainingMs: result.entitlement?.expiresAt
            ? Math.max(0, new Date(result.entitlement.expiresAt).getTime() - Date.now())
            : 0
        })
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
