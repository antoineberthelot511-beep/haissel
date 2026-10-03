function errorMiddleware(err, req, res, next) {
  console.error('Request error:', err);

  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'An internal server error occurred.'
        : err.message,
    },
  });
}

module.exports = {
  errorMiddleware,
};
