import { Router } from 'express';
import { countCompletedResumeJobsByOwner, countPdfJobsByOwner } from '../data/jobStore.js';
import { countPaidCredits, countPaidStorageMonths, createDraftOrder, getOrderById, listOrdersByOwner, markOrderPaid } from '../data/orderStore.js';
import { requireSession } from '../middleware/sessionAuth.js';
import { env } from '../config/env.js';
import { getBillingProductById, listBillingProducts } from '../services/billingCatalog.js';

function mapOrder(order) {
  if (!order) {
    return null;
  }

  return {
    orderId: order.id,
    productId: order.productId,
    productName: order.productName,
    amountCents: order.amountCents,
    currency: order.currency,
    status: order.status,
    channel: order.channel,
    credits: order.credits,
    storageMonths: order.storageMonths,
    note: order.note,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paidAt: order.paidAt,
    snapshot: order.snapshot
  };
}

function buildOverview(ownerId) {
  const totalCredits = countPaidCredits(ownerId);
  const usedCredits = countCompletedResumeJobsByOwner(ownerId);
  const pdfCount = countPdfJobsByOwner(ownerId);

  return {
    totalCredits,
    usedCredits,
    remainingCredits: Math.max(totalCredits - usedCredits, 0),
    storageMonths: countPaidStorageMonths(ownerId),
    pdfCount
  };
}

export function createBillingRouter() {
  const router = Router();

  router.get('/catalog', (req, res) => {
    res.json({
      status: 'ok',
      products: listBillingProducts(),
      payment: {
        supportsJsapiPay: false,
        mode: env.billingAllowMockPay ? 'mock-ready' : 'manual'
      }
    });
  });

  router.use(requireSession);

  router.get('/overview', (req, res) => {
    const ownerId = req.session.openId;
    res.json({
      status: 'ok',
      overview: buildOverview(ownerId),
      recentOrders: listOrdersByOwner(ownerId, 6).map(mapOrder)
    });
  });

  router.get('/orders', (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10);
    res.json({
      status: 'ok',
      items: listOrdersByOwner(req.session.openId, limit).map(mapOrder)
    });
  });

  router.post('/orders', (req, res) => {
    const productId = typeof req.body?.productId === 'string' ? req.body.productId.trim() : '';
    const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim() : 'wechatpay_jsapi';
    const product = getBillingProductById(productId);

    if (!product) {
      return res.status(404).json({
        status: 'error',
        message: 'Billing product not found.'
      });
    }

    const order = createDraftOrder(req.session.openId, product, { channel });
    return res.status(201).json({
      status: 'ok',
      order: mapOrder(order),
      overview: buildOverview(req.session.openId)
    });
  });

  router.get('/orders/:orderId', (req, res) => {
    const order = getOrderById(req.params.orderId, req.session.openId);
    if (!order) {
      return res.status(404).json({
        status: 'error',
        message: 'Order not found.'
      });
    }

    return res.json({
      status: 'ok',
      order: mapOrder(order)
    });
  });

  router.post('/orders/:orderId/mock-pay', (req, res) => {
    if (!env.billingAllowMockPay) {
      return res.status(403).json({
        status: 'error',
        message: 'Mock payment is disabled.'
      });
    }

    const order = markOrderPaid(req.params.orderId, req.session.openId, 'Mock payment completed');
    if (!order) {
      return res.status(404).json({
        status: 'error',
        message: 'Order not found.'
      });
    }

    return res.json({
      status: 'ok',
      order: mapOrder(order),
      overview: buildOverview(req.session.openId)
    });
  });

  return router;
}
