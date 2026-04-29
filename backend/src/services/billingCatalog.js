export const BILLING_PRODUCTS = Object.freeze([
  {
    id: 'starter_3',
    name: 'Starter Pack',
    subtitle: 'For first-time users',
    amountCents: 990,
    currency: 'CNY',
    priceLabel: '9.9 RMB',
    credits: 3,
    storageMonths: 1,
    highlight: '3 resume generations'
  },
  {
    id: 'pro_10',
    name: 'Pro Pack',
    subtitle: 'For active job search',
    amountCents: 1990,
    currency: 'CNY',
    priceLabel: '19.9 RMB',
    credits: 10,
    storageMonths: 6,
    highlight: '10 resume generations'
  },
  {
    id: 'plus_30',
    name: 'Plus Pack',
    subtitle: 'For long search cycles',
    amountCents: 4990,
    currency: 'CNY',
    priceLabel: '49.9 RMB',
    credits: 30,
    storageMonths: 12,
    highlight: '30 resume generations'
  }
]);

export function listBillingProducts() {
  return BILLING_PRODUCTS;
}

export function getBillingProductById(productId) {
  return BILLING_PRODUCTS.find((product) => product.id === productId) || null;
}
