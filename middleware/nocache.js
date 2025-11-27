// backend/middleware/nocache.js
// Middleware simple para deshabilitar cache en responses HTTP.
export function nocache(_req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Vary", "Authorization");
  next();
}

export default nocache;
