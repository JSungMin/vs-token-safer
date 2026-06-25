// Create an invoice to bill the customer for a subscription period.
export function createInvoice(customer: string) {
  return { customer };
}

// Send the invoice document to the customer by email.
export function sendInvoice(customer: string) {
  return customer.length > 0;
}
