const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind NPM (one hop)

const API_KEY     = process.env.API_KEY;
const BASE_URL    = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const MAX_SIZE_MB = parseInt(process.env.MAX_SIZE_MB || '50', 10);
const PORT        = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_DIR  = path.resolve(process.env.UPLOAD_DIR || './uploads');
const RATE_LIMIT  = parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10);

const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp',
  '.mp4', '.webm', '.mov', '.m4v',
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const rateLimit = (() => {
  const buckets = new Map();
  const WINDOW_MS = 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now - b.start > WINDOW_MS) buckets.delete(ip);
  }, WINDOW_MS).unref();

  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.start > WINDOW_MS) {
      b = { start: now, count: 0 };
      buckets.set(ip, b);
    }
    b.count++;
    if (b.count > RATE_LIMIT) {
      return res.status(429).type('text/plain').send('Too Many Requests');
    }
    next();
  };
})();

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname || '').toLowerCase();
    const name = crypto.randomBytes(4).toString('hex');
    cb(null, name + ext);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_SIZE_MB * 1024 * 1024,
    files: 1,
    fields: 5,
    parts: 10,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('Unsupported file type'));
    }
    cb(null, true);
  },
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use('/uploads', (_req, res, next) => {
  // Defense-in-depth: even if a risky file slipped past the extension whitelist,
  // CSP prevents inline script / plugin execution when browsing the URL directly.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  );
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}, express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'ignore',
  index: 'index.html',
}));

app.post('/upload', rateLimit, (req, res) => {
  const headerKey = req.headers['x-api-key'];

  if (API_KEY && typeof headerKey === 'string' && !safeEqual(headerKey, API_KEY)) {
    return res.status(401).type('text/plain').send('Unauthorized');
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).type('text/plain').send(`File too large. Max: ${MAX_SIZE_MB}MB`);
      }
      return res.status(400).type('text/plain').send(err.message);
    }

    if (API_KEY) {
      const provided = (typeof headerKey === 'string' && headerKey)
        || (req.body && typeof req.body.api_key === 'string' && req.body.api_key)
        || '';
      if (!safeEqual(provided, API_KEY)) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(401).type('text/plain').send('Unauthorized');
      }
    }

    if (!req.file) {
      return res.status(400).type('text/plain').send('No file provided. Use field name "file".');
    }

    const url = `${BASE_URL}/uploads/${req.file.filename}`;
    res.type('text/plain').send(url);
  });
});

app.listen(PORT, () => {
  console.log(`Pixhatch listening on port ${PORT}`);
  console.log(`BASE_URL     : ${BASE_URL}`);
  console.log(`Upload dir   : ${UPLOAD_DIR}`);
  console.log(`Max file size: ${MAX_SIZE_MB}MB`);
  console.log(`Rate limit   : ${RATE_LIMIT} req/min per IP`);
  console.log(`API key auth : ${API_KEY ? 'enabled' : 'DISABLED — set API_KEY env var!'}`);
});
