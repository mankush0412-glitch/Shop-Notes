const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const { getMongo } = require('./lib/db');
const { ensureIndexes } = require('./lib/indexes');
const { MongoRateLimitStore } = require('./lib/rate-limit-store');
const storage = require('./lib/storage');

// On Vercel the CDN serves public/**, so Express only handles /api and /config.js.
// Locally (npm start) Express also serves public/ so the whole site works on one port.
const IS_VERCEL = Boolean(process.env.VERCEL);
const FRONTEND_DIR = path.resolve(__dirname, '..', 'public');
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'next_level_notes';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const CRON_SECRET = process.env.CRON_SECRET || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ADMIN_MAX_LOGIN_ATTEMPTS = clampInt(process.env.ADMIN_MAX_LOGIN_ATTEMPTS, 5, 3, 20);
const ADMIN_LOCK_MINUTES = clampInt(process.env.ADMIN_LOCK_MINUTES, 15, 1, 1440);
const API_RATE_LIMIT_PER_MINUTE = clampInt(process.env.API_RATE_LIMIT_PER_MINUTE, 180, 30, 5000);
const AUTH_RATE_LIMIT_PER_15_MIN = clampInt(process.env.AUTH_RATE_LIMIT_PER_15_MIN, 20, 5, 500);
const ORDER_RATE_LIMIT_PER_10_MIN = clampInt(process.env.ORDER_RATE_LIMIT_PER_10_MIN, 10, 2, 200);
const ADMIN_READ_PAGE_SIZE = clampInt(process.env.ADMIN_READ_PAGE_SIZE, 50, 10, 100);
const PRODUCT_IMAGE_MAX_MB = clampInt(process.env.PRODUCT_IMAGE_MAX_MB, 2, 1, 4); // Vercel Functions accept ~4.5 MB bodies
const PRODUCT_FILE_MAX_MB = clampInt(process.env.PRODUCT_FILE_MAX_MB, 100, 1, 1024);
const DOWNLOAD_RATE_LIMIT_PER_HOUR = clampInt(process.env.DOWNLOAD_RATE_LIMIT_PER_HOUR, 60, 5, 1000);
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map(v => v.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (!MONGODB_URI) throw new Error('MONGODB_URI is required');
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required');
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
if (FRONTEND_ORIGINS.length === 0) throw new Error('FRONTEND_ORIGINS is required and must contain your exact storefront origin');
// Preview deployments run on their own *.vercel.app host; allow exactly that host (never in production).
if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    if (host) FRONTEND_ORIGINS.push(`https://${host}`);
  }
}

const app = express();
let db;
let startupPromise = null;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const DEFAULT_PRODUCTS = [
  {id:'p1', title:'Class 12 Physics — Full Notes', subject:'Physics', type:'handwritten', price:149, description:'Chapter-wise handwritten notes covering the entire CBSE Class 12 Physics syllabus.', image:'', file:'#'},
  {id:'p2', title:'Organic Chemistry Crash Guide', subject:'Chemistry', type:'guide', price:199, description:'A compact revision guide for organic chemistry reactions and mechanisms.', image:'', file:'#'},
  {id:'p3', title:'Data Structures E-book', subject:'Computer Science', type:'ebook', price:249, description:'Beginner-friendly e-book on arrays, trees, graphs and common interview problems.', image:'', file:'#'},
  {id:'p4', title:'UPSC Essay Answer Templates', subject:'UPSC', type:'template', price:99, description:'Ready-to-adapt structures for scoring well in the essay paper.', image:'', file:'#'}
];

// Vercel's edge is the single trusted proxy hop: it overwrites X-Forwarded-For with the
// real visitor IP, so req.ip is reliable. Do NOT put another proxy (e.g. Cloudflare's
// orange cloud) in front of Vercel, or every visitor would share one IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
      "style-src": ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      "font-src": ["'self'", 'https://fonts.gstatic.com', 'data:'],
      "img-src": ["'self'", 'data:', 'https:'],
      "connect-src": ["'self'", 'https://accounts.google.com', 'https://*.googleapis.com', 'https://vercel.com', 'https://*.vercel.com', 'https://*.vercel-storage.com'],
      "frame-src": ['https://accounts.google.com'],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  }
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
  next();
});

// Keep request bodies deliberately small. This stops giant-text/body attacks
// before route code, bcrypt, or MongoDB ever see the payload.
app.use(express.json({ limit: '32kb', strict: true, inflate: false }));
app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50, inflate: false }));

// Reject object keys commonly used for prototype pollution / NoSQL operator injection.
app.use((req, res, next) => {
  if (req.body && hasUnsafeStructure(req.body)) {
    return res.status(400).json({ error: 'Invalid request structure' });
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    // Requests from the same page normally need no CORS header. CLI/server calls
    // often have no Origin, so they are allowed; browser origins must match exactly.
    if (!origin || FRONTEND_ORIGINS.includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }
    return callback(httpError(403, 'Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON mutation endpoints only accept JSON. This also makes cookie-authenticated
// admin mutations require a CORS preflight from any different origin.
// Database is connected lazily (cached across warm invocations) before any /api handler runs.
function ensureStartup() {
  return (async () => {
    try {
      await ensureIndexes(db);
      if (process.env.SEED_DEFAULT_PRODUCTS !== 'false') {
        const count = await db.collection('products').countDocuments({}, { maxTimeMS:3000 });
        if (count === 0) {
          const now = new Date();
          await db.collection('products').insertMany(DEFAULT_PRODUCTS.map(p => ({ ...p, active:true, createdAt:now, updatedAt:now })));
        }
      }
      await db.collection('admin_config').updateOne(
        { _id:'primary', tokenVersion:{ $exists:false } },
        { $set:{ tokenVersion:1 } }
      );
    } catch (err) {
      console.warn('Startup tasks skipped:', err.message);
    }
  })();
}
async function ensureDb(req, res, next) {
  if (req.path === '/health') return next();
  try {
    const client = await getMongo();
    db = client.db(DB_NAME);
    if (!startupPromise) startupPromise = ensureStartup();
    await startupPromise;
    next();
  } catch (err) {
    console.error('Database connection failed:', err.message);
    res.status(503).json({ error:'Service temporarily unavailable. Please try again.' });
  }
}
app.use('/api', ensureDb);

// JSON mutation endpoints only accept JSON (multipart is allowed only for the small image upload).
// This also makes cookie-authenticated admin mutations require a CORS preflight from any other origin.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const isProductImageUpload = req.path === '/admin/product-image' && req.method === 'POST';
  if (['POST', 'PUT', 'PATCH'].includes(req.method) &&
      !(isProductImageUpload && req.is('multipart/form-data')) &&
      !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json (multipart is only allowed for image upload)' });
  }
  next();
});

const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_RATE_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
const authLimiter = rateLimit({
  store: new MongoRateLimitStore('auth', () => db),
  windowMs: 15 * 60 * 1000,
  limit: AUTH_RATE_LIMIT_PER_15_MIN,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'Too many authentication requests. Try again later.' }
});
const adminLoginNetworkLimiter = rateLimit({
  store: new MongoRateLimitStore('adminlogin', () => db),
  windowMs: 15 * 60 * 1000,
  limit: Math.max(10, ADMIN_MAX_LOGIN_ATTEMPTS * 2),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many admin login requests from this network. Try again later.' }
});
const orderLimiter = rateLimit({
  store: new MongoRateLimitStore('order', () => db),
  windowMs: 10 * 60 * 1000,
  limit: ORDER_RATE_LIMIT_PER_10_MIN,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many order attempts. Please wait before trying again.' }
});
const quoteLimiter = rateLimit({
  store: new MongoRateLimitStore('quote', () => db),
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many checkout refreshes. Please wait a little and try again.' }
});
const adminWriteLimiter = rateLimit({
  store: new MongoRateLimitStore('adminwrite', () => db),
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many admin changes. Please slow down.' }
});
const downloadLimiter = rateLimit({
  store: new MongoRateLimitStore('download', () => db),
  windowMs: 60 * 60 * 1000,
  limit: DOWNLOAD_RATE_LIMIT_PER_HOUR,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many download requests. Please try again later.' }
});
app.use('/api', globalApiLimiter);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function hasUnsafeStructure(value, depth = 0) {
  if (depth > 8) return true;
  if (Array.isArray(value)) {
    if (value.length > 100) return true;
    return value.some(v => hasUnsafeStructure(v, depth + 1));
  }
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length > 100) return true;
  return keys.some(key =>
    key.startsWith('$') || key.includes('.') || ['__proto__', 'prototype', 'constructor'].includes(key) ||
    hasUnsafeStructure(value[key], depth + 1)
  );
}
function textField(value, name, max, { required = false, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw httpError(400, `${name} is required`);
    return '';
  }
  if (!['string', 'number'].includes(typeof value)) throw httpError(400, `Invalid ${name}`);
  const text = String(value).trim();
  if (required && !text) throw httpError(400, `${name} is required`);
  if (text.length < min && text) throw httpError(400, `${name} is too short`);
  if (text.length > max) throw httpError(400, `${name} is too long (max ${max} characters)`);
  if (/\u0000/.test(JSON.stringify(text)) || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw httpError(400, `Invalid characters in ${name}`);
  }
  return text;
}
function cleanEmail(value) {
  const email = textField(value, 'email', 254, { required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Valid email is required');
  return email;
}
function productIdField(value) {
  const id = textField(value, 'product id', 100, { required: true });
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw httpError(400, 'Invalid product id');
  return id;
}
function utrField(value) {
  const utr = textField(value, 'UTR', 80, { required: true, min: 6 });
  if (!/^[A-Za-z0-9._-]+$/.test(utr)) throw httpError(400, 'UTR may contain only letters, numbers, dot, underscore and hyphen');
  return utr;
}
function priceField(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 1000000) throw httpError(400, 'Price must be between ₹0 and ₹10,00,000');
  return Math.round(price * 100) / 100;
}
function safeDownloadUrl(value) {
  const text = textField(value, 'download link', 2000);
  if (!text || text === '#') return text;
  let url;
  try { url = new URL(text); } catch { throw httpError(400, 'Download link must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw httpError(400, 'Download link must use HTTPS');
  return url.href;
}
function safeProductImage(value) {
  const text = textField(value, 'product image', 2000);
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw httpError(400, 'Product image must be a valid HTTPS image URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw httpError(400, 'Product image URL must use HTTPS');
  return url.href;
}
function productImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return 'png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 16 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = buffer.subarray(8, Math.min(buffer.length, 64)).toString('ascii');
    if (brands.includes('avif') || brands.includes('avis')) return 'avif';
  }
  return '';
}
async function removeProductImage(image) {
  await storage.deleteProductImage(image);
}
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRODUCT_IMAGE_MAX_MB * 1024 * 1024, files: 1, fields: 2 }
});

function booleanField(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
function safeOriginalZipName(value) {
  let name = path.basename(String(value || 'product.zip'))
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  if (!name) name = 'product.zip';
  if (!/\.zip$/i.test(name)) name += '.zip';
  if (name.length > 180) {
    const stem = name.replace(/\.zip$/i, '').slice(0, 176);
    name = `${stem}.zip`;
  }
  return name;
}
function privateAssetIdField(value) {
  const id = String(value || '');
  if (!/^pf_[a-f0-9]{32}$/i.test(id)) throw httpError(404, 'File unavailable');
  return id;
}
const PRIVATE_BLOB_PATH_RE = /^files\/[A-Za-z0-9_-]{16,64}(?:-[A-Za-z0-9]{8,64})?\.zip$/;
function privateUploadRefField(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'Invalid uploaded file reference');
  const pathname = textField(value.pathname, 'uploaded file path', 200, { required:true });
  if (!PRIVATE_BLOB_PATH_RE.test(pathname)) throw httpError(400, 'Invalid uploaded file reference');
  const originalName = safeOriginalZipName(textField(value.originalName, 'file name', 200));
  return { pathname, originalName };
}
async function createPrivateFileAsset(upload) {
  if (!upload?.pathname) return null;
  const duplicate = await db.collection('product_files').findOne({ blobPathname:upload.pathname }, { projection:{ _id:1 }, maxTimeMS:3000 });
  if (duplicate) throw httpError(409, 'This uploaded file is already attached to a product');
  const result = await storage.getPrivateBlob(upload.pathname);
  if (!result) throw httpError(400, 'Uploaded file was not found in storage. Please upload it again.');
  const blobInfo = result.blob || {};
  const size = Number(blobInfo.size || 0);
  const reject = async (status, message) => {
    await result.stream.cancel().catch(() => {});
    await storage.deletePrivateBlob(blobInfo.url || upload.pathname);
    throw httpError(status, message);
  };
  if (size < 22) return reject(400, 'Invalid ZIP');
  if (size > PRODUCT_FILE_MAX_MB * 1024 * 1024) return reject(413, `File too large (max ${PRODUCT_FILE_MAX_MB} MB)`);
  const head = await storage.readFirstBytes(result.stream, 4);
  const sig = head.length === 4 ? head.readUInt32LE(0) : 0;
  if (![0x04034b50, 0x06054b50].includes(sig)) {
    await storage.deletePrivateBlob(blobInfo.url || upload.pathname);
    throw httpError(400, 'Invalid ZIP');
  }
  const asset = {
    _id: `pf_${crypto.randomBytes(16).toString('hex')}`,
    blobPathname: blobInfo.pathname || upload.pathname,
    blobUrl: blobInfo.url || '',
    originalName: upload.originalName,
    size,
    etag: blobInfo.etag || '',
    contentType: blobInfo.contentType || 'application/zip',
    createdAt: new Date()
  };
  try {
    await db.collection('product_files').insertOne(asset);
  } catch (err) {
    await storage.deletePrivateBlob(asset.blobUrl || asset.blobPathname);
    throw err;
  }
  return asset;
}
async function deletePrivateFileAsset(assetId) {
  let id;
  try { id = privateAssetIdField(assetId); } catch { return; }
  const asset = await db.collection('product_files').findOne({ _id:id }, { maxTimeMS:3000 });
  if (!asset) return;
  await storage.deletePrivateBlob(asset.blobUrl || asset.blobPathname);
  await db.collection('product_files').deleteOne({ _id:id });
}
async function privateFileIsReferenced(assetId) {
  const id = privateAssetIdField(assetId);
  const [productRef, orderRef, quoteRef] = await Promise.all([
    db.collection('products').findOne({ privateFileId:id }, { projection:{ _id:1 }, maxTimeMS:3000 }),
    db.collection('orders').findOne({ 'items.privateFileId':id }, { projection:{ _id:1 }, maxTimeMS:3000 }),
    db.collection('checkout_quotes').findOne({ 'items.privateFileId':id }, { projection:{ _id:1 }, maxTimeMS:3000 })
  ]);
  return Boolean(productRef || orderRef || quoteRef);
}
async function cleanupPrivateFileIfUnused(assetId) {
  if (!assetId) return;
  try {
    if (!(await privateFileIsReferenced(assetId))) await deletePrivateFileAsset(assetId);
  } catch (err) {
    console.warn('Private file cleanup skipped:', err.message);
  }
}
async function cleanupOrphanPrivateFiles() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const assets = await db.collection('product_files')
    .find({ createdAt:{ $lt:cutoff } })
    .sort({ createdAt:1 })
    .limit(100)
    .maxTimeMS(5000)
    .toArray();
  for (const asset of assets) await cleanupPrivateFileIfUnused(asset._id);
  return assets.length;
}
// Blobs uploaded by the browser but never attached to a product (admin closed the tab, save failed...).
async function cleanupUntrackedBlobs() {
  if (!storage.filesConfigured()) return 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const blobs = await storage.listPrivateBlobs('files/');
  let removed = 0;
  for (const b of blobs) {
    if (new Date(b.uploadedAt).getTime() > cutoff) continue;
    const tracked = await db.collection('product_files').findOne({ blobPathname:b.pathname }, { projection:{ _id:1 }, maxTimeMS:3000 });
    if (tracked) continue;
    await storage.deletePrivateBlob(b.url || b.pathname);
    removed++;
  }
  return removed;
}

function validUpiId(value) {
  const upi = textField(value, 'UPI ID', 150, { required: true });
  if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(upi)) throw httpError(400, 'Invalid UPI ID');
  return upi;
}
function supportContactField(value) {
  return textField(value, 'support contact', 160);
}
function safeSupportUrl(value) {
  const text = textField(value, 'support link', 500);
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw httpError(400, 'Support link must be a valid URL'); }
  const allowed = new Set(['https:', 'mailto:', 'tel:']);
  if (!allowed.has(url.protocol)) throw httpError(400, 'Support link must use HTTPS, mailto or tel');
  if (url.protocol === 'https:' && (url.username || url.password)) throw httpError(400, 'Invalid support link');
  return url.href;
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function adminLoginKey(req) {
  // req.ip is set by Vercel's edge (trust proxy = 1). Never trust client-supplied IP headers.
  const source = String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
  return crypto.createHmac('sha256', JWT_SECRET).update(source).digest('hex');
}
function newUserToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function newProductId() {
  return 'p_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}
function newQuoteId() { return 'Q-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(6).toString('hex').toUpperCase(); }
function newOrderId() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
  return `NLN-${ymd}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  }
  return out;
}
function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function setAdminCookie(req, res, token) {
  res.cookie('nln_admin', token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'strict',
    path: '/api/admin',
    maxAge: 12 * 60 * 60 * 1000
  });
}
function clearAdminCookie(req, res) {
  res.clearCookie('nln_admin', {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'strict',
    path: '/api/admin'
  });
}
function signAdminToken(tokenVersion = 1) {
  return jwt.sign(
    { role: 'admin', ver: Number(tokenVersion || 1) },
    JWT_SECRET,
    { expiresIn: '12h', issuer: 'next-level-notes', audience: 'next-level-notes-admin' }
  );
}
async function authenticateAdmin(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = parseCookies(req).nln_admin || bearer;
  if (!token) throw new Error('Admin authentication required');
  const payload = jwt.verify(token, JWT_SECRET, { issuer: 'next-level-notes', audience: 'next-level-notes-admin' });
  if (payload.role !== 'admin') throw new Error('Not admin');
  const admin = await db.collection('admin_config').findOne({ _id: 'primary' }, { projection: { tokenVersion: 1 } });
  if (!admin || Number(payload.ver || 1) !== Number(admin.tokenVersion || 1)) throw new Error('Expired admin session');
  return payload;
}
async function requireAdmin(req, res, next) {
  try {
    req.admin = await authenticateAdmin(req);
    next();
  } catch {
    clearAdminCookie(req, res);
    res.status(401).json({ error: 'Admin authentication required' });
  }
}
async function requireUser(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || token.length > 200) return res.status(401).json({ error: 'User session required' });
    const user = await db.collection('users').findOne({ tokenHash: hashToken(token) }, { maxTimeMS: 3000 });
    if (!user) return res.status(401).json({ error: 'Invalid user session' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
function publicProduct(p) {
  return { id:p.id, title:p.title, subject:p.subject, type:p.type, price:p.price, description:p.description, image:p.image || '' };
}
function hasLegacyDownload(item) {
  try {
    const value = safeDownloadUrl(item?.file || '');
    return Boolean(value && value !== '#');
  } catch {
    return false;
  }
}
function adminProduct(p) {
  return {
    ...publicProduct(p),
    file: hasLegacyDownload(p) ? p.file : '',
    active: p.active !== false,
    hasPrivateFile: Boolean(p.privateFileId),
    privateFileName: p.privateFileName || '',
    privateFileSize: Number(p.privateFileSize || 0)
  };
}
function sanitizeOrderForUser(order) {
  const canDownload = ['paid','delivered'].includes(order.status);
  return {
    id: order.id,
    items: (order.items || []).map(it => ({
      productId: it.productId,
      title: it.title,
      qty: it.qty,
      price: it.price,
      downloadAvailable: Boolean(canDownload && (it.privateFileId || hasLegacyDownload(it)))
    })),
    total: order.total,
    utr: order.utr,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt
  };
}
function sanitizeOrderForAdmin(order) {
  return {
    id: order.id,
    buyerName: order.buyerName,
    buyerEmail: order.buyerEmail,
    items: (order.items || []).map(it => ({
      productId: it.productId,
      title: it.title,
      qty: it.qty,
      price: it.price,
      hasDownload: Boolean(it.privateFileId || hasLegacyDownload(it))
    })),
    total: order.total,
    utr: order.utr,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt
  };
}
function pagination(req, defaultLimit = ADMIN_READ_PAGE_SIZE) {
  const page = clampInt(req.query.page, 1, 1, 1000000);
  const limit = clampInt(req.query.limit, defaultLimit, 10, 100);
  return { page, limit, skip: (page - 1) * limit };
}

async function resolveCartItems(submittedItems) {
  if (!Array.isArray(submittedItems) || !submittedItems.length || submittedItems.length > 30) {
    throw httpError(400, 'Cart is empty or too large');
  }
  const normalized = submittedItems.map(it => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw httpError(400, 'Invalid cart item');
    const productId = productIdField(it.productId);
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw httpError(400, 'Invalid item quantity');
    return { productId, qty };
  });
  const ids = [...new Set(normalized.map(it => it.productId))];
  const products = await db.collection('products')
    .find({ id:{ $in:ids }, active:{ $ne:false } })
    .maxTimeMS(3000)
    .toArray();
  const byId = new Map(products.map(p => [p.id,p]));
  if (products.length !== ids.length) throw httpError(400, 'One or more products are unavailable. Refresh the store and try again.');
  return normalized.map(it => {
    const p = byId.get(it.productId);
    return {
      productId:p.id,
      title:textField(p.title, 'product title', 160, { required:true }),
      qty:it.qty,
      price:priceField(p.price),
      file:safeDownloadUrl(p.file || ''),
      ...(p.privateFileId ? {
        privateFileId: privateAssetIdField(p.privateFileId),
        privateFileName: safeOriginalZipName(p.privateFileName || 'product.zip')
      } : {})
    };
  });
}
function orderTotal(items) {
  const total = Math.round(items.reduce((sum,it) => sum + it.price * it.qty, 0) * 100) / 100;
  if (total > 5000000) throw httpError(400, 'Order total is too large');
  return total;
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'next-level-notes-api' }));

app.get('/api/products', async (req, res, next) => {
  try {
    const products = await db.collection('products')
      .find({ active: { $ne: false } })
      .sort({ createdAt: 1 })
      .limit(1000)
      .maxTimeMS(3000)
      .toArray();
    res.json({ products: products.map(publicProduct) });
  } catch (err) { next(err); }
});

app.get('/api/settings/public', async (req, res, next) => {
  try {
    const settings = await db.collection('settings').findOne({ _id: 'store' }, { maxTimeMS: 3000 });
    res.json({ upiId: settings?.upiId || '', supportContact: settings?.supportContact || '', supportUrl: settings?.supportUrl || '' });
  } catch (err) { next(err); }
});

app.post('/api/checkout/quote', quoteLimiter, requireUser, async (req, res, next) => {
  try {
    const items = await resolveCartItems(req.body.items);
    const total = orderTotal(items);
    const settings = await db.collection('settings').findOne({ _id:'store' }, { maxTimeMS:3000 });
    const upiId = settings?.upiId ? validUpiId(settings.upiId) : '';
    if (!upiId) throw httpError(503, 'UPI payment is not configured yet');
    const params = new URLSearchParams({
      pa: upiId,
      pn: 'Next Level notes',
      am: total.toFixed(2),
      cu: 'INR',
      tn: 'Next Level notes order payment'
    });
    const upiUri = `upi://pay?${params.toString()}`;
    const quoteId = newQuoteId();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
    await db.collection('checkout_quotes').insertOne({
      _id:quoteId, userId:req.user._id, items, total, used:false, createdAt, expiresAt
    });
    const qrDataUrl = await QRCode.toDataURL(upiUri, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320
    });
    res.json({ quoteId, expiresAt, total, upiId, upiUri, qrDataUrl });
  } catch (err) { next(err); }
});

app.post('/api/auth/google', authLimiter, async (req, res, next) => {
  try {
    if (!googleClient || !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes('YOUR_GOOGLE_CLIENT_ID')) {
      return res.status(503).json({ error: 'Google sign-in is not configured on the backend' });
    }
    const credential = textField(req.body.credential, 'Google credential', 6000, { required: true });
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload?.email || payload.email_verified === false) return res.status(401).json({ error: 'Invalid Google identity' });

    const now = new Date();
    let user = await db.collection('users').findOne({ googleSub: payload.sub }, { maxTimeMS: 3000 });
    const rawToken = newUserToken();
    const update = {
      name: textField(payload.name || payload.email.split('@')[0], 'Google name', 80, { required: true }),
      email: cleanEmail(payload.email),
      provider:'google',
      googleSub: textField(payload.sub, 'Google user id', 255, { required: true }),
      tokenHash: hashToken(rawToken),
      lastSeenAt: now
    };
    if (user) {
      await db.collection('users').updateOne({ _id:user._id }, { $set:update });
      user = { ...user, ...update };
    } else {
      const doc = { ...update, createdAt:now };
      const result = await db.collection('users').insertOne(doc);
      user = { ...doc, _id:result.insertedId };
    }
    res.json({ user:{ id:String(user._id), name:user.name, email:user.email, provider:'google' }, userToken:rawToken });
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('token') || msg.includes('audience') || msg.includes('issuer')) return res.status(401).json({ error:'Google sign-in verification failed' });
    next(err);
  }
});

app.post('/api/orders', orderLimiter, requireUser, async (req, res, next) => {
  try {
    const utr = utrField(req.body.utr);
    const quoteId = textField(req.body.quoteId, 'checkout quote', 80, { required:true });
    if (!/^Q-[A-Z0-9-]+$/.test(quoteId)) throw httpError(400, 'Invalid checkout quote');

    const duplicateUtr = await db.collection('orders').findOne({ utr }, { projection:{ _id:1 }, maxTimeMS:3000 });
    if (duplicateUtr) throw httpError(409, 'This UTR has already been used for an order');

    const now = new Date();
    const quote = await db.collection('checkout_quotes').findOneAndUpdate(
      { _id:quoteId, userId:req.user._id, used:false, expiresAt:{ $gt:now } },
      { $set:{ used:true, usedAt:now } },
      { returnDocument:'before' }
    );
    if (!quote) throw httpError(409, 'Checkout quote expired or already used. Reopen checkout to generate a new QR.');
    const items = Array.isArray(quote.items) ? quote.items : [];
    const total = priceField(quote.total);
    const order = {
      id:newOrderId(), userId:req.user._id, buyerName:req.user.name, buyerEmail:req.user.email,
      utr, items, total, status:'pending', createdAt:now, updatedAt:now
    };
    try {
      await db.collection('orders').insertOne(order);
      await db.collection('checkout_quotes').updateOne({ _id:quoteId }, { $set:{ orderId:order.id } });
    } catch (err) {
      await db.collection('checkout_quotes').updateOne({ _id:quoteId, orderId:{ $exists:false } }, { $set:{ used:false }, $unset:{ usedAt:'' } }).catch(() => {});
      throw err;
    }
    res.status(201).json({ order:sanitizeOrderForUser(order) });
  } catch (err) { next(err); }
});

app.get('/api/orders/me', requireUser, async (req, res, next) => {
  try {
    const { page, limit, skip } = pagination(req, 30);
    const filter = { userId:req.user._id };
    const [orders, total] = await Promise.all([
      db.collection('orders').find(filter).sort({ createdAt:-1 }).skip(skip).limit(limit).maxTimeMS(3000).toArray(),
      db.collection('orders').countDocuments(filter, { maxTimeMS:3000 })
    ]);
    res.json({ orders:orders.map(sanitizeOrderForUser), page, limit, total, pages:Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { next(err); }
});

app.get('/api/orders/:orderId/download/:productId', downloadLimiter, requireUser, async (req, res, next) => {
  try {
    const orderId = textField(req.params.orderId, 'order id', 80, { required:true });
    if (!/^NLN-[A-Z0-9-]+$/.test(orderId)) throw httpError(404, 'Order not found');
    const productId = productIdField(req.params.productId);

    const order = await db.collection('orders').findOne(
      { id:orderId, userId:req.user._id },
      { maxTimeMS:3000 }
    );
    if (!order) throw httpError(404, 'Order not found');
    if (!['paid','delivered'].includes(order.status)) throw httpError(403, 'Payment not approved');

    const item = (order.items || []).find(it => it.productId === productId);
    if (!item) throw httpError(404, 'Product not purchased in this order');

    if (item.privateFileId) {
      const assetId = privateAssetIdField(item.privateFileId);
      const asset = await db.collection('product_files').findOne({ _id:assetId }, { maxTimeMS:3000 });
      if (!asset || !asset.blobPathname) throw httpError(404, 'File unavailable');

      const downloadName = safeOriginalZipName(asset.originalName || item.privateFileName || `${item.title || 'product'}.zip`);
      try {
        await storage.sendPrivateBlob(res, asset.blobPathname, downloadName);
      } catch (err) {
        if (res.headersSent) {
          console.warn('Download stream error:', err.message);
          return res.destroy();
        }
        throw err;
      }
      return;
    }

    const legacyUrl = safeDownloadUrl(item.file || '');
    if (legacyUrl && legacyUrl !== '#') {
      return res.json({ legacyExternal:true, externalUrl:legacyUrl });
    }

    throw httpError(404, 'File unavailable');
  } catch (err) { next(err); }
});

app.post('/api/admin/login', adminLoginNetworkLimiter, async (req, res, next) => {
  try {
    const password = textField(req.body.password, 'password', 128, { required: true });
    const now = new Date();
    const key = adminLoginKey(req);
    const attemptsCollection = db.collection('admin_login_attempts');
    let attempt = await attemptsCollection.findOne({ _id:key }, { maxTimeMS:3000 });

    if (attempt?.lockedUntil && attempt.lockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error:`Too many wrong passwords. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
        locked:true,
        retryAfterSeconds
      });
    }
    if (attempt?.lockedUntil && attempt.lockedUntil <= now) {
      await attemptsCollection.deleteOne({ _id:key });
      attempt = null;
    }

    let admin = await db.collection('admin_config').findOne({ _id:'primary' }, { maxTimeMS:3000 });
    if (!admin) {
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      const doc = { _id:'primary', passwordHash, tokenVersion:1, createdAt:now, updatedAt:now };
      await db.collection('admin_config').insertOne(doc);
      admin = doc;
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      const failedAttempts = Number(attempt?.failedAttempts || 0) + 1;
      if (failedAttempts >= ADMIN_MAX_LOGIN_ATTEMPTS) {
        const lockedUntil = new Date(now.getTime() + ADMIN_LOCK_MINUTES * 60 * 1000);
        const retryAfterSeconds = ADMIN_LOCK_MINUTES * 60;
        await attemptsCollection.updateOne(
          { _id:key },
          { $set:{ failedAttempts, lockedUntil, lastFailedAt:now, expiresAt:new Date(lockedUntil.getTime() + 24*60*60*1000) } },
          { upsert:true }
        );
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          error:`Too many wrong passwords. Admin login is locked for ${ADMIN_LOCK_MINUTES} minute(s).`,
          locked:true,
          retryAfterSeconds,
          attemptsRemaining:0
        });
      }

      const attemptsRemaining = ADMIN_MAX_LOGIN_ATTEMPTS - failedAttempts;
      await attemptsCollection.updateOne(
        { _id:key },
        { $set:{ failedAttempts, lastFailedAt:now, lockedUntil:null, expiresAt:new Date(now.getTime() + 24*60*60*1000) } },
        { upsert:true }
      );
      return res.status(401).json({
        error:`Wrong password. ${attemptsRemaining} attempt(s) remaining before temporary lock.`,
        attemptsRemaining
      });
    }

    await attemptsCollection.deleteOne({ _id:key });
    const token = signAdminToken(admin.tokenVersion || 1);
    setAdminCookie(req, res, token);
    res.json({ ok:true });
  } catch (err) { next(err); }
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(req, res);
  res.json({ ok:true });
});

app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
  try {
    const [products, orders, pending, users] = await Promise.all([
      db.collection('products').countDocuments({}, { maxTimeMS:3000 }),
      db.collection('orders').countDocuments({}, { maxTimeMS:3000 }),
      db.collection('orders').countDocuments({ status:'pending' }, { maxTimeMS:3000 }),
      db.collection('users').countDocuments({}, { maxTimeMS:3000 })
    ]);
    res.json({ products, orders, pending, users });
  } catch (err) { next(err); }
});

app.post('/api/admin/product-image', requireAdmin, adminWriteLimiter, productImageUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file?.buffer) throw httpError(400, 'Choose a JPG, PNG, WebP or AVIF image');
    const ext = productImageExtension(req.file.buffer);
    if (!ext) throw httpError(400, 'Only genuine JPG, PNG, WebP and AVIF images are allowed');
    const image = await storage.putProductImage(req.file.buffer, ext);
    res.status(201).json({ image });
  } catch (err) { next(err); }
});

app.delete('/api/admin/product-image', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  try {
    const image = safeProductImage(req.body.image);
    if (image) await removeProductImage(image);
    res.json({ ok:true });
  } catch (err) { next(err); }
});

// Browser -> Vercel Blob direct upload for paid ZIPs (bypasses the 4.5 MB Function body limit).
// NOT behind requireAdmin: Vercel Blob also calls this URL back (signed) when an upload completes.
// Admin auth is enforced inside onBeforeGenerateToken, i.e. before any upload token is issued.
app.post('/api/admin/blob/upload', adminWriteLimiter, async (req, res, next) => {
  try {
    const json = await storage.handleClientUpload({
      body: req.body,
      request: req,
      maxBytes: PRODUCT_FILE_MAX_MB * 1024 * 1024,
      authorize: async () => {
        try { await authenticateAdmin(req); } catch { throw httpError(401, 'Admin authentication required'); }
      },
      pathnameAllowed: pathname => /^files\/[A-Za-z0-9_-]{16,64}\.zip$/.test(String(pathname || ''))
    });
    res.json(json);
  } catch (err) { next(err); }
});

app.get('/api/admin/products', requireAdmin, async (req, res, next) => {
  try {
    const products = await db.collection('products').find({}).sort({ createdAt:1 }).limit(1000).maxTimeMS(3000).toArray();
    res.json({ products:products.map(adminProduct), productFileMaxMb:PRODUCT_FILE_MAX_MB });
  } catch (err) { next(err); }
});

const PRODUCT_TYPES = new Set(['ebook','handwritten','guide','template','website']);
function parseProductBody(body) {
  const title = textField(body.title, 'title', 160, { required:true, min:2 });
  const subject = textField(body.subject, 'subject', 120);
  const type = textField(body.type, 'type', 40) || 'ebook';
  if (!PRODUCT_TYPES.has(type)) throw httpError(400, 'Invalid product type');
  const description = textField(body.description, 'description', 2000);
  const image = safeProductImage(body.image);
  const file = safeDownloadUrl(body.file);
  const price = priceField(body.price);
  return { title, subject, type, description, image, file, price };
}

app.post('/api/admin/products', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  let newAsset = null;
  try {
    const body = req.body || {};
    const fields = parseProductBody(body);
    const upload = privateUploadRefField(body.privateUpload);
    if (upload) newAsset = await createPrivateFileAsset(upload);

    const now = new Date();
    const product = {
      id:newProductId(), ...fields,
      ...(newAsset ? {
        privateFileId:newAsset._id,
        privateFileName:newAsset.originalName,
        privateFileSize:newAsset.size
      } : {}),
      active:true, createdAt:now, updatedAt:now
    };
    await db.collection('products').insertOne(product);
    res.status(201).json({ product:adminProduct(product) });
  } catch (err) {
    if (newAsset) await deletePrivateFileAsset(newAsset._id).catch(() => {});
    next(err);
  }
});

app.put('/api/admin/products/:id', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  let newAsset = null;
  try {
    const id = productIdField(req.params.id);
    const body = req.body || {};
    const fields = parseProductBody(body);
    const upload = privateUploadRefField(body.privateUpload);
    const removePrivateFile = booleanField(body.removePrivateFile);

    const current = await db.collection('products').findOne({ id }, { maxTimeMS:3000 });
    if (!current) throw httpError(404, 'Product not found');

    if (upload) newAsset = await createPrivateFileAsset(upload);

    const setFields = { ...fields, updatedAt:new Date() };
    const unsetFields = {};
    if (newAsset) {
      setFields.privateFileId = newAsset._id;
      setFields.privateFileName = newAsset.originalName;
      setFields.privateFileSize = newAsset.size;
    } else if (removePrivateFile) {
      unsetFields.privateFileId = '';
      unsetFields.privateFileName = '';
      unsetFields.privateFileSize = '';
    }

    const update = { $set:setFields };
    if (Object.keys(unsetFields).length) update.$unset = unsetFields;

    const result = await db.collection('products').findOneAndUpdate(
      { id },
      update,
      { returnDocument:'after' }
    );

    if (current.image && current.image !== fields.image) await removeProductImage(current.image);
    if (current.privateFileId && (newAsset || removePrivateFile)) {
      await cleanupPrivateFileIfUnused(current.privateFileId);
    }
    res.json({ product:adminProduct(result) });
  } catch (err) {
    if (newAsset) await deletePrivateFileAsset(newAsset._id).catch(() => {});
    next(err);
  }
});

app.delete('/api/admin/products/:id', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  try {
    const id = productIdField(req.params.id);
    const product = await db.collection('products').findOne({ id }, { maxTimeMS:3000 });
    if (!product) throw httpError(404, 'Product not found');
    await db.collection('products').deleteOne({ id });
    if (product.image) await removeProductImage(product.image);
    if (product.privateFileId) await cleanupPrivateFileIfUnused(product.privateFileId);
    res.json({ ok:true });
  } catch (err) { next(err); }
});

app.get('/api/admin/orders', requireAdmin, async (req, res, next) => {
  try {
    const status = textField(req.query.status, 'status', 30);
    const allowed = new Set(['all','pending','paid','delivered','rejected']);
    if (status && !allowed.has(status)) throw httpError(400, 'Invalid status filter');
    const filter = status && status !== 'all' ? { status } : {};
    const { page, limit, skip } = pagination(req);
    const [orders, total] = await Promise.all([
      db.collection('orders').find(filter).sort({ createdAt:-1 }).skip(skip).limit(limit).maxTimeMS(3000).toArray(),
      db.collection('orders').countDocuments(filter, { maxTimeMS:3000 })
    ]);
    res.json({ orders:orders.map(sanitizeOrderForAdmin), page, limit, total, pages:Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { next(err); }
});

app.patch('/api/admin/orders/:id/status', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  try {
    const allowed = new Set(['pending','paid','delivered','rejected']);
    const status = textField(req.body.status, 'status', 30, { required:true });
    if (!allowed.has(status)) throw httpError(400, 'Invalid order status');
    const id = textField(req.params.id, 'order id', 80, { required:true });
    if (!/^NLN-[A-Z0-9-]+$/.test(id)) throw httpError(400, 'Invalid order id');
    const order = await db.collection('orders').findOneAndUpdate(
      { id },
      { $set:{ status, updatedAt:new Date() } },
      { returnDocument:'after' }
    );
    if (!order) throw httpError(404, 'Order not found');
    res.json({ order:sanitizeOrderForAdmin(order) });
  } catch (err) { next(err); }
});

app.get('/api/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const { page, limit, skip } = pagination(req);
    const [users, total] = await Promise.all([
      db.collection('users').find({}, { projection:{ tokenHash:0, googleSub:0 } }).sort({ lastSeenAt:-1 }).skip(skip).limit(limit).maxTimeMS(3000).toArray(),
      db.collection('users').countDocuments({}, { maxTimeMS:3000 })
    ]);
    const ids = users.map(u => u._id);
    const counts = ids.length ? await db.collection('orders').aggregate([
      { $match:{ userId:{ $in:ids } } },
      { $group:{ _id:'$userId', count:{ $sum:1 }, spend:{ $sum:'$total' } } }
    ], { maxTimeMS:3000 }).toArray() : [];
    const map = new Map(counts.map(c => [String(c._id),c]));
    res.json({
      users:users.map(u => ({
        id:String(u._id), name:u.name, email:u.email, provider:u.provider,
        createdAt:u.createdAt, lastSeenAt:u.lastSeenAt,
        orderCount:map.get(String(u._id))?.count || 0,
        totalOrdered:map.get(String(u._id))?.spend || 0
      })),
      page, limit, total, pages:Math.max(1, Math.ceil(total / limit))
    });
  } catch (err) { next(err); }
});

app.get('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const settings = await db.collection('settings').findOne({ _id:'store' }, { maxTimeMS:3000 });
    res.json({ upiId:settings?.upiId || '', supportContact:settings?.supportContact || '', supportUrl:settings?.supportUrl || '' });
  } catch (err) { next(err); }
});

app.put('/api/admin/settings', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  try {
    const upiId = validUpiId(req.body.upiId);
    const supportContact = supportContactField(req.body.supportContact);
    const supportUrl = safeSupportUrl(req.body.supportUrl);
    await db.collection('settings').updateOne(
      { _id:'store' },
      { $set:{ upiId, supportContact, supportUrl, updatedAt:new Date() }, $setOnInsert:{ createdAt:new Date() } },
      { upsert:true }
    );
    res.json({ upiId, supportContact, supportUrl });
  } catch (err) { next(err); }
});

app.put('/api/admin/password', requireAdmin, adminWriteLimiter, async (req, res, next) => {
  try {
    const newPassword = textField(req.body.newPassword, 'new password', 128, { required:true, min:12 });
    if (Buffer.byteLength(newPassword, 'utf8') > 72) throw httpError(400, 'Admin password must be 72 bytes or fewer');
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.collection('admin_config').updateOne(
      { _id:'primary' },
      { $set:{ passwordHash, updatedAt:new Date() }, $inc:{ tokenVersion:1 }, $setOnInsert:{ createdAt:new Date() } },
      { upsert:true }
    );
    clearAdminCookie(req, res);
    res.json({ ok:true, reauthRequired:true });
  } catch (err) { next(err); }
});

// Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
app.get('/api/cron/cleanup', async (req, res, next) => {
  try {
    if (!CRON_SECRET) throw httpError(503, 'CRON_SECRET is not configured');
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error:'Unauthorized' });
    }
    const orphanAssets = await cleanupOrphanPrivateFiles();
    const orphanBlobs = await cleanupUntrackedBlobs();
    res.json({ ok:true, orphanAssetsChecked:orphanAssets, orphanBlobsRemoved:orphanBlobs });
  } catch (err) { next(err); }
});

// Admin-only deployment self-check: open /api/admin/diagnostics after logging in at /admin.
app.get('/api/admin/diagnostics', requireAdmin, async (req, res, next) => {
  try {
    await db.command({ ping:1 });
    res.json({
      ok:true,
      environment: process.env.VERCEL_ENV || 'local',
      database: 'connected',
      storage: storage.status(),
      cronSecretConfigured: Boolean(CRON_SECRET),
      googleClientConfigured: Boolean(GOOGLE_CLIENT_ID),
      allowedOrigins: FRONTEND_ORIGINS
    });
  } catch (err) { next(err); }
});

// Browser config is generated from server environment variables so GOOGLE_CLIENT_ID
// only needs to be configured once in backend/.env. Client IDs are public by design;
// secrets such as JWT_SECRET and MongoDB credentials are never exposed here.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.NLN_CONFIG = ${JSON.stringify({ API_BASE_URL:'', GOOGLE_CLIENT_ID })};`);
});

if (!IS_VERCEL) {
  // Local development only. On Vercel the CDN serves public/** and vercel.json rewrites /admin.
  app.get(['/admin', '/admin-login'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
  });
  app.use(express.static(FRONTEND_DIR, {
    index: 'index.html',
    dotfiles: 'ignore',
    maxAge: 0,
    setHeaders(res) { res.setHeader('Cache-Control', 'no-store'); }
  }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    }
    next();
  });
}

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Product image is too large (max ${PRODUCT_IMAGE_MAX_MB} MB)` });
    }
    return res.status(400).json({ error: 'Invalid image upload' });
  }
  const status = Number(err?.status || err?.statusCode || 0);
  if (err?.type === 'entity.too.large' || status === 413) return res.status(413).json({ error:'Request body is too large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error:'Invalid JSON body' });
  if (err?.code === 11000) return res.status(409).json({ error:'That value is already in use' });
  if (String(err?.message || '').includes('CORS')) return res.status(403).json({ error:'Origin not allowed' });
  if (status >= 400 && status < 500) return res.status(status).json({ error:String(err.message || 'Bad request').slice(0,200) });
  console.error('Unhandled request error:', err);
  res.status(500).json({ error:'Server error' });
});

// The Express app is exported: Vercel (index.js) and local.js decide how to run it.
module.exports = app;
