/**
 * Central error handler — must be registered LAST in server.js
 * Usage inside controllers: next(err)  or  next(new AppError('msg', 404))
 */

class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // Multer upload errors (size limit, unexpected field, …)
  if (err.name === 'MulterError') {
    statusCode = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large' : `Upload error: ${err.message}`;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    message = Object.values(err.errors).map((e) => e.message).join(', ');
    statusCode = 422;
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    message = `Invalid ${err.path}: ${err.value}`;
    statusCode = 400;
  }

  if (process.env.NODE_ENV === 'development') {
    console.error('❌ ERROR:', err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = { errorHandler, AppError };
