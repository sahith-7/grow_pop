import { z } from 'zod';

// Zod 4 (D95) words its default messages for developers ("Invalid input: expected string, received undefined"). Field
// errors are shown to shop staff, so the common cases get plain words. Anything not listed keeps Zod's own message.
z.config({
  customError: (iss) => {
    if (iss.code === 'invalid_type' && iss.input === undefined) return 'Required';
    if (iss.code === 'invalid_type' && iss.input === null) return 'Required';
    if (iss.code === 'invalid_type') return iss.expected === 'number' ? 'Enter a number' : 'Invalid value';
    if (iss.code === 'unrecognized_keys') return `Unknown field${iss.keys.length > 1 ? 's' : ''}: ${iss.keys.join(', ')}`;
    return undefined;
  },
});
