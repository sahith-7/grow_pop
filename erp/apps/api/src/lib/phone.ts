// Customer phone numbers (v2, D104). A counter bill needs the customer's mobile number or a Walk-in mark, so a cashier in a
// hurry may type a made-up number instead. These checks refuse the usual made-up ones; they can't prove a number is real
// (only an OTP could, which costs an SMS per bill).

/** The last 10 digits of a number written as 98765 43210, +91 98765 43210, 091..., for comparing two numbers. */
export const national = (phone: string) => phone.replace(/\D/g, '').slice(-10);

/** Why this can't be a customer's number, or null. `phone` already passed the digits-only format check. */
export function phoneProblem(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  let n = digits;
  let prefixed = false;
  if (phone.startsWith('+91') && digits.length === 12) { n = digits.slice(2); prefixed = true; }
  else if (!phone.startsWith('+') && digits.length === 12 && digits.startsWith('91')) { n = digits.slice(2); prefixed = true; }
  else if (digits.length === 11 && digits.startsWith('0')) n = digits.slice(1);       // 0 + STD code + number, or 0 + mobile
  else if (phone.startsWith('+')) return digits.length >= 8 && !madeUp(digits.slice(-8)) ? null : 'This does not look like a real phone number';
  if (n.length !== 10) return 'An Indian mobile number has 10 digits';
  if (madeUp(n)) return 'This looks like a made-up number. Ask for the customer’s number, or bill as Walk-in.';
  if ((digits.length === 10 || prefixed) && !/^[6-9]/.test(n)) return 'A mobile number starts with 6, 7, 8 or 9. For a landline, type 0 before the area code.';
  return null;
}

/** 0000000000, 9999999999, 1234567890, 9876543210 and other straight runs. */
function madeUp(n: string) {
  if (/^(\d)\1+$/.test(n)) return true;
  const steps = [...n].slice(1).map((d, i) => (Number(d) - Number(n[i]) + 10) % 10);
  return steps.every((s) => s === 1) || steps.every((s) => s === 9);
}
