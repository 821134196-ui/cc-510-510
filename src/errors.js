export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code, msg) => new ApiError(400, code, msg);
export const unauthorized = (msg = '未登录或登录已过期') => new ApiError(401, 'UNAUTHORIZED', msg);
export const forbidden = (code, msg) => new ApiError(403, code, msg);
export const notFound = (code, msg) => new ApiError(404, code, msg);
export const conflict = (code, msg) => new ApiError(409, code, msg);
