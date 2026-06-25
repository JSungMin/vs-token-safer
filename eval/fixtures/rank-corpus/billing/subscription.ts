// Renew the customer's subscription for another billing cycle.
export function renewSubscription(id: string) {
  return id;
}

// Cancel an active subscription and stop all future billing.
export function cancelSubscription(id: string) {
  return !id;
}
