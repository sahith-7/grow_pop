// Errors the API sends to clients. server.ts formats an AppError as { code, message, fieldErrors, correlationId }.
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in again');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this');
export const notFound = (what = 'Not found') => new AppError(404, 'NOT_FOUND', what);
export const invalid = (field: string, message: string) => new AppError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', { [field]: [message] });
