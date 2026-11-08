export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'המשאב') => new AppError(404, 'not_found', `${what} לא נמצא`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const forbidden = (message = 'אין הרשאה לפעולה זו') => new AppError(403, 'forbidden', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
