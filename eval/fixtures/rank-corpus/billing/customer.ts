// List every payment a customer has made, most recent first.
export function listPayments(customer: string) {
  return [customer];
}

// Look up the billing address on file for a customer.
export function customerAddress(customer: string) {
  return customer;
}

// Apply a discount coupon to the customer's next order total.
export function applyDiscount(customer: string, code: string) {
  return code.length;
}
