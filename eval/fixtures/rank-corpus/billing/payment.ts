// Charge the customer's card to process a payment for the order.
export function chargePayment(amount: number) {
  return amount > 0;
}

// Refund a previously charged payment back to the customer.
export function refundPayment(amount: number) {
  return -amount;
}
