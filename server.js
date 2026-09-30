// server.js
'use strict';

/*
  MasterTech v7 — single-file Node.js server.
  Plain http module. No framework.

  Persistence: JSON file on disk (atomic writes) + optional Cloudflare R2 sync.
  Email out:   Resend (no-op if RESEND_API_KEY unset).
  Auth:        single admin, scrypt password, TOTP 2FA, CSRF, audit log.
  Downloads:   signed time-limited URLs for /media/files/*.
*/

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Optional dependencies — loaded lazily so the server boots without them.
// ---------------------------------------------------------------------------
let sharp = null;
let Resend = null;
let S3Client = null;
let PutObjectCommand = null;
let GetObjectCommand = null;
let ListObjectsV2Command = null;
let DeleteObjectCommand = null;
let authenticator = null;

try { sharp = require('sharp'); } catch { /* optional */ }
try { ({ Resend } = require('resend')); } catch { /* optional */ }
try {
  const aws = require('@aws-sdk/client-s3');
  S3Client = aws.S3Client;
  PutObjectCommand = aws.PutObjectCommand;
  GetObjectCommand = aws.GetObjectCommand;
  ListObjectsV2Command = aws.ListObjectsV2Command;
  DeleteObjectCommand = aws.DeleteObjectCommand;
} catch { /* optional */ }
try { ({ authenticator } = require('otplib')); } catch { /* optional */ }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DB_FILE = process.env.MASTERTECH_DB
  ? path.resolve(process.env.MASTERTECH_DB)
  : path.join(ROOT, 'data', 'mastertech-db.json');

const UPLOAD_DIR = process.env.MASTERTECH_UPLOADS
  ? path.resolve(process.env.MASTERTECH_UPLOADS)
  : path.join(ROOT, 'uploads');

const THUMB_DIR = path.join(UPLOAD_DIR, 'thumbs');

const BASE_URL = (process.env.MASTERTECH_BASE_URL || '').replace(/\/+$/, '');
const CORS_ORIGIN = process.env.MASTERTECH_CORS_ORIGIN || '';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_RETRY_MAX = 5;
const EMAIL_RETRY_INTERVAL_MS = 60_000;

const ADMIN_PASSWORD_ENV = String(process.env.MASTERTECH_ADMIN_PASSWORD || '').trim();
const SESSION_SECRET = String(process.env.MASTERTECH_SESSION_SECRET || '').trim();
const FORCE_ADMIN_RESET = String(process.env.MASTERTECH_ADMIN_FORCE_RESET || '').toLowerCase() === 'true';

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const RESEND_FROM = String(process.env.RESEND_FROM || '').trim();
const EMAIL_ENABLED = Boolean(RESEND_API_KEY && RESEND_FROM && Resend);

const R2_ENDPOINT = String(process.env.S3_ENDPOINT || '').trim();
const R2_BUCKET = String(process.env.S3_BUCKET || '').trim();
const R2_ACCESS_KEY = String(process.env.S3_ACCESS_KEY || '').trim();
const R2_SECRET_KEY = String(process.env.S3_SECRET_KEY || '').trim();
const R2_REGION = String(process.env.S3_REGION || 'auto').trim();
const R2_ENABLED = Boolean(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY && R2_SECRET_KEY && S3Client);

// ---------------------------------------------------------------------------
// Boot-time guards
// ---------------------------------------------------------------------------
if (IS_PRODUCTION && ADMIN_PASSWORD_ENV.length < 12) {
  throw new Error('MASTERTECH_ADMIN_PASSWORD must be at least 12 characters in production.');
}
if (IS_PRODUCTION && SESSION_SECRET.length < 32) {
  throw new Error('MASTERTECH_SESSION_SECRET must be at least 32 characters in production.');
}

// DECISION: in dev, if either secret is missing, we generate one and warn. In
// production, both are required above, so this branch only triggers locally.
const EFFECTIVE_ADMIN_PASSWORD = ADMIN_PASSWORD_ENV || crypto.randomBytes(18).toString('base64url');
const EFFECTIVE_SESSION_SECRET = SESSION_SECRET || crypto.randomBytes(48).toString('base64url');

if (!ADMIN_PASSWORD_ENV) {
  console.warn('==============================================================');
  console.warn('MASTERTECH_ADMIN_PASSWORD is not set.');
  console.warn('Temporary dev admin password for THIS RUN ONLY:');
  console.warn('  ' + EFFECTIVE_ADMIN_PASSWORD);
  console.warn('Set MASTERTECH_ADMIN_PASSWORD before deploying to production.');
  console.warn('==============================================================');
}
if (!SESSION_SECRET) {
  console.warn('MASTERTECH_SESSION_SECRET is not set — using a random one.');
  console.warn('Sessions and download URLs will be invalidated on restart.');
}
if (!EMAIL_ENABLED) {
  console.warn('Resend is not configured — emails will queue but not send.');
}
if (!R2_ENABLED) {
  console.warn('R2 sync is not configured — DB stays on local disk only.');
}

// ---------------------------------------------------------------------------
// Demo seed (Academy intentionally empty)
// ---------------------------------------------------------------------------
const DEMO_LAPTOPS = [
  ['lap01','Dell Latitude 5420','Dell',16,512,650,'Popular','Reliable business laptop for productivity and professional work.'],
  ['lap02','Dell Latitude 7490','Dell',16,256,520,'Value','Professional productivity laptop for work and study.'],
  ['lap03','Dell XPS 13','Dell',16,512,1100,'Premium','Compact premium laptop for developers and professionals.'],
  ['lap04','HP EliteBook 840 G7','HP',16,512,720,'Business','Premium business notebook with a professional design.'],
  ['lap05','HP ProBook 450 G8','HP',8,512,590,'Value','Balanced laptop for school, office and everyday tasks.'],
  ['lap06','HP ZBook Studio','HP',32,1000,1450,'Power','High-performance workstation for demanding creative work.'],
  ['lap07','MacBook Air M2','Apple',8,256,950,'Popular','Lightweight Apple laptop for everyday productivity.'],
  ['lap08','MacBook Air M3','Apple',16,512,1350,'New','Modern Apple laptop with excellent efficiency and performance.'],
  ['lap09','Lenovo ThinkPad T14','Lenovo',16,512,750,'Business','Durable professional laptop built for productivity.'],
  ['lap10','Lenovo IdeaPad 5','Lenovo',8,512,570,'Value','Affordable all-round laptop for work and study.'],
  ['lap11','Lenovo ThinkPad X1 Carbon','Lenovo',32,1000,1250,'Premium','Lightweight high-end business laptop.'],
  ['lap12','Lenovo Legion 5','Lenovo',32,1000,1400,'Performance','Powerful laptop for development, creation and demanding applications.']
].map(([id, name, brand, ram, storage, price, tag, description]) => ({
  id, name, brand, ram, storage, price, tag, description,
  emoji: '▱',
  type: 'laptop',
  category: 'laptop',
  published: true,
  featured: false,
  image: '',
  thumbnailUrl: '',
  fileUrl: '',
  previewUrl: '',
  tags: [],
  sku: '',
  volume: '',
  author: '',
  stock: 0,
  variants: [],
  updatedAt: new Date().toISOString()
}));

const DEMO_DIGITAL = []; // Academy — seeded via Admin only.

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
function initialDb() {
  return {
    catalog: { laptops: DEMO_LAPTOPS, digital: DEMO_DIGITAL },
    settings: {
      phone: '+27 777 234 5788',
      email: 'hello@mastertech.com',
      location: 'Zimbabwe / Remote',
      currency: '$',
      whatsapp: '',
      facebook: '',
      instagram: '',
      linkedin: ''
    },
    orders: [],
    messages: [],
    audit: [],
    users: null,               // reserved for future multi-user
    pendingEmails: [],
    csrfTokens: {},
    meta: { schemaVersion: 7, createdAt: new Date().toISOString() }
  };
}

function repairDb(d) {
  if (!d || typeof d !== 'object') return initialDb();
  if (!d.catalog || typeof d.catalog !== 'object') d.catalog = { laptops: [], digital: [] };
  if (!Array.isArray(d.catalog.laptops)) d.catalog.laptops = [];
  if (!Array.isArray(d.catalog.digital)) d.catalog.digital = [];
  if (!d.settings || typeof d.settings !== 'object') d.settings = {};
  for (const k of ['phone','email','location','whatsapp','facebook','instagram','linkedin']) {
    if (typeof d.settings[k] !== 'string') d.settings[k] = '';
  }
  if (typeof d.settings.currency !== 'string' || !d.settings.currency) d.settings.currency = '$';
  if (!Array.isArray(d.orders)) d.orders = [];
  if (!Array.isArray(d.messages)) d.messages = [];
  if (!Array.isArray(d.audit)) d.audit = [];
  if (!Array.isArray(d.pendingEmails)) d.pendingEmails = [];
  if (!d.csrfTokens || typeof d.csrfTokens !== 'object') d.csrfTokens = {};
  if (!d.meta || typeof d.meta !== 'object') d.meta = { schemaVersion: 7, createdAt: new Date().toISOString() };
  if (typeof d.meta.schemaVersion !== 'number') d.meta.schemaVersion = 7;
  return d;
}

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return repairDb(parsed);
  } catch (err) {
    if (fs.existsSync(DB_FILE)) {
      const backup = DB_FILE + '.corrupt-' + Date.now();
      try { fs.copyFileSync(DB_FILE, backup); console.warn('Corrupt DB backed up to', backup); } catch {}
    }
    const fresh = initialDb();
    saveDbSync(fresh);
    return fresh;
  }
}

let db = loadDb();
let lastWrite = Date.now();

function saveDbSync(d) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB_FILE);
  lastWrite = Date.now();
}

// DECISION: saveDb is intentionally async so that R2 sync does not block the
// response loop. The local write is synchronous (fast, atomic). The R2 push is
// fire-and-forget; failures are logged but never block a request.
function saveDb() {
  saveDbSync(db);
  scheduleR2Sync();
}

let r2SyncPending = false;
function scheduleR2Sync() {
  if (!R2_ENABLED) return;
  if (r2SyncPending) return;
  r2SyncPending = true;
  setImmediate(async () => {
    try {
      await pushDbToR2();
    } catch (err) {
      console.warn('R2 sync failed:', err.message);
    } finally {
      r2SyncPending = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Admin password bootstrap
// ---------------------------------------------------------------------------
if (!db.adminPasswordHash || (FORCE_ADMIN_RESET && ADMIN_PASSWORD_ENV)) {
  db.adminPasswordHash = passwordHash(EFFECTIVE_ADMIN_PASSWORD);
  saveDbSync(db);
  if (FORCE_ADMIN_RESET) {
    console.warn('MASTERTECH_ADMIN_FORCE_RESET applied. Remove this env var after logging in.');
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + '$' + hash;
}

function passwordMatches(password, stored) {
  try {
    const [salt, hex] = String(stored || '').split('$');
    if (!salt || !hex) return false;
    const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(hex, 'hex'));
  } catch { return false; }
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }

function signDownload(fileId, orderId, expiresAt) {
  const payload = `${fileId}|${orderId}|${expiresAt}`;
  return crypto.createHmac('sha256', EFFECTIVE_SESSION_SECRET).update(payload).digest('hex');
}

function verifyDownload(fileId, orderId, expiresAt, sig) {
  if (!expiresAt || Date.now() > Number(expiresAt)) return false;
  const expected = signDownload(fileId, orderId, expiresAt);
  if (expected.length !== String(sig || '').length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
}

// ---------------------------------------------------------------------------
// Session / CSRF stores
// ---------------------------------------------------------------------------
const sessions = new Map();     // token -> { expires, csrf }
const loginAttempts = new Map();
const publicRate = new Map();
const resetTokens = new Map();  // token -> { expires, email }

function auth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const t = h.slice(7);
  const s = sessions.get(t);
  if (!s || s.expires < Date.now()) { sessions.delete(t); return null; }
  return t;
}

function rateLimit(store, key, max, windowMs) {
  const now = Date.now();
  const list = (store.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { store.set(key, list); return false; }
  list.push(now);
  store.set(key, list);
  return true;
}

function ipOf(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', c => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function setCors(res) {
  if (!CORS_ORIGIN) return;
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // DECISION: CSP allows unsafe-inline because index.html has inline <style>
  // and <script>. A future refactor could split these into files and tighten
  // the policy. For now, we prefer "site works" over "perfect CSP".
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data: https:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https://formspree.io https://api.resend.com; " +
    "form-action 'self' https://formspree.io; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'"
  );
}

// ---------------------------------------------------------------------------
// Validation / sanitization
// ---------------------------------------------------------------------------
const HTML_TAG_RE = /<\/?[^>]+>/g;
function stripHtml(s) { return String(s || '').replace(HTML_TAG_RE, ''); }

function safeString(s, max) {
  return stripHtml(String(s ?? '').trim()).slice(0, max);
}

function isSafeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return true;
  if (/^\/media\//i.test(s)) return true;
  try {
    const parsed = new URL(s);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch { return false; }
}

function safeProduct(p) {
  const base = {
    id: safeString(p.id, 80),
    name: safeString(p.name, 160),
    price: Number(p.price),
    emoji: String(p.emoji || '▱').slice(0, 16),
    tag: safeString(p.tag || 'Featured', 60),
    description: safeString(p.description, 2000),
    image: String(p.image || '').trim().slice(0, 2000),
    thumbnailUrl: String(p.thumbnailUrl || '').trim().slice(0, 2000),
    type: p.type === 'laptop' ? 'laptop' : 'digital',
    category: safeString(p.category || 'academy', 50),
    volume: safeString(p.volume, 80),
    author: safeString(p.author, 120),
    sku: safeString(p.sku, 80),
    tags: Array.isArray(p.tags)
      ? p.tags.map(x => safeString(x, 40)).filter(Boolean).slice(0, 20)
      : String(p.tags || '').split(',').map(x => safeString(x, 40)).filter(Boolean).slice(0, 20),
    featured: Boolean(p.featured),
    published: p.published !== false,
    fileUrl: String(p.fileUrl || '').trim().slice(0, 2000),
    previewUrl: String(p.previewUrl || '').trim().slice(0, 2000),
    stock: Math.max(0, Math.floor(Number(p.stock) || 0)),
    variants: Array.isArray(p.variants) ? p.variants.slice(0, 50) : [],
    updatedAt: new Date().toISOString()
  };
  if (base.type === 'laptop') {
    base.brand = safeString(p.brand, 80);
    base.ram = Number(p.ram);
    base.storage = Number(p.storage);
    base.category = 'laptop';
  }
  return base;
}

function validateProduct(p) {
  if (!p.id || !p.name) return 'Product id and name are required';
  if (!/^[A-Za-z0-9_-]+$/.test(p.id)) return 'Product id may only contain letters, numbers, hyphens and underscores';
  if (!Number.isFinite(p.price) || p.price < 0 || p.price > 100000000) return 'Product price is invalid';
  if (p.type === 'laptop') {
    if (!Number.isFinite(p.ram) || p.ram < 0 || p.ram > 1024) return 'Laptop RAM is invalid';
    if (!Number.isFinite(p.storage) || p.storage < 0 || p.storage > 10000000) return 'Laptop storage is invalid';
  }
  if (!isSafeUrl(p.image)) return 'Image URL must be http, https, or /media/';
  if (!isSafeUrl(p.fileUrl)) return 'File URL must be http, https, or /media/';
  if (!isSafeUrl(p.previewUrl)) return 'Preview URL must be http, https, or /media/';
  return null;
}

function cleanCustomer(c) {
  if (!c || typeof c !== 'object') return null;
  const customer = {
    name: safeString(c.name, 120),
    email: String(c.email || '').trim().slice(0, 254),
    phone: safeString(c.phone, 60),
    address: safeString(c.address, 500),
    notes: safeString(c.notes, 2000),
    comment: safeString(c.comment, 2000),
    liked: c.liked === 'Yes' ? 'Yes' : 'No'
  };
  if (!customer.name) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) return null;
  return customer;
}

function allProducts() { return [...db.catalog.laptops, ...db.catalog.digital]; }
function routeProduct(id) { return allProducts().find(p => p.id === id); }

function buildOrderItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    return { error: 'At least one order item is required' };
  }
  let total = 0;
  const clean = [];
  for (const item of items) {
    const id = String(item?.id || '');
    const qty = Number(item?.qty);
    const product = routeProduct(id);
    if (!product) return { error: 'One or more products are no longer available' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: 'Invalid product quantity' };
    if (product.published === false) return { error: 'One or more products are not for sale' };
    // DECISION: stock 0 means "unlimited" for digital goods so existing
    // Academy volumes are not blocked before stock tracking is set up.
    if (product.type === 'laptop' && product.stock > 0 && product.stock < qty) {
      return { error: `Not enough stock for ${product.name}` };
    }
    const price = Number(product.price);
    total += price * qty;
    clean.push({
      id: product.id,
      type: product.type || 'digital',
      name: product.name,
      price,
      emoji: product.emoji || '▱',
      qty
    });
  }
  return { items: clean, total: Number(total.toFixed(2)) };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
function audit(action, target, meta) {
  db.audit.unshift({
    ts: new Date().toISOString(),
    ip: meta?.ip || null,
    action,
    target: target || null,
    meta: meta ? { ...meta, ip: undefined } : null
  });
  if (db.audit.length > 5000) db.audit.length = 5000;
}

// ---------------------------------------------------------------------------
// Email queue
// ---------------------------------------------------------------------------
function queueEmail(to, subject, html, meta) {
  db.pendingEmails.push({
    id: 'EM-' + Date.now().toString(36) + '-' + crypto.randomInt(100, 1000),
    to, subject, html,
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
    meta: meta || null
  });
}

async function processEmailQueue() {
  if (!EMAIL_ENABLED) return;
  const resend = new Resend(RESEND_API_KEY);
  const now = Date.now();
  for (const email of db.pendingEmails.slice()) {
    if (email.sentAt) continue;
    if (email.attempts >= EMAIL_RETRY_MAX) continue;
    const age = now - new Date(email.createdAt).getTime();
    if (age < EMAIL_RETRY_INTERVAL_MS * email.attempts) continue;
    try {
      await resend.emails.send({
        from: RESEND_FROM,
        to: email.to,
        subject: email.subject,
        html: email.html
      });
      email.sentAt = new Date().toISOString();
      email.lastError = null;
    } catch (err) {
      email.attempts += 1;
      email.lastError = err.message;
      console.warn('Email send failed:', email.id, err.message);
    }
  }
  // Trim sent emails older than 7 days.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  db.pendingEmails = db.pendingEmails.filter(e => !e.sentAt || new Date(e.sentAt).getTime() > cutoff);
  saveDb();
}

setInterval(() => { processEmailQueue().catch(err => console.warn('Email loop:', err.message)); }, EMAIL_RETRY_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// R2 sync
// ---------------------------------------------------------------------------
let r2Client = null;
function getR2Client() {
  if (!R2_ENABLED) return null;
  if (r2Client) return r2Client;
  r2Client = new S3Client({
    region: R2_REGION,
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
  });
  return r2Client;
}

async function pushDbToR2() {
  const client = getR2Client();
  if (!client) return;
  const body = fs.readFileSync(DB_FILE);
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: 'mastertech-db.json',
    Body: body,
    ContentType: 'application/json'
  }));
}

async function pullDbFromR2() {
  const client = getR2Client();
  if (!client) return false;
  try {
    const out = await client.send(new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'mastertech-db.json'
    }));
    const chunks = [];
    for await (const chunk of out.Body) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(raw);
    db = repairDb(parsed);
    saveDbSync(db);
    console.log('DB restored from R2.');
    return true;
  } catch (err) {
    console.warn('R2 pull failed:', err.message);
    return false;
  }
}

// Nightly backup at 03:00 UTC.
function scheduleNightlyBackup() {
  if (!R2_ENABLED) return;
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3, 0, 0));
  const delay = next.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      const client = getR2Client();
      const date = new Date().toISOString().slice(0, 10);
      const body = fs.readFileSync(DB_FILE);
      await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: `backups/mastertech-db-${date}.json`,
        Body: body,
        ContentType: 'application/json'
      }));
      console.log(`R2 nightly backup written: backups/mastertech-db-${date}.json`);
    } catch (err) {
      console.warn('R2 nightly backup failed:', err.message);
    }
    scheduleNightlyBackup();
  }, delay).unref();
}
scheduleNightlyBackup();

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp',
  'application/pdf', 'application/zip', 'application/epub+zip'
]);
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/epub+zip': '.epub'
};

function readBase64Upload(body) {
  const data = String(body?.data || '');
  const match = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw Object.assign(new Error('Upload must be a base64 data URL'), { statusCode: 400 });
  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) throw Object.assign(new Error('Unsupported file type'), { statusCode: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('File is too large (25MB maximum)'), { statusCode: 413 });
  return { mime, buffer };
}

function safeName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'file';
}

// ---------------------------------------------------------------------------
// Static / media
// ---------------------------------------------------------------------------
function mediaFile(req, res, pathname) {
  const rawRel = pathname.slice('/media/'.length);
  let rel;
  try { rel = decodeURIComponent(rawRel); }
  catch { return json(res, 400, { error: 'Bad path' }); }
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
    return json(res, 404, { error: 'Not found' });
  }
  const file = path.resolve(UPLOAD_DIR, rel);
  if (!file.startsWith(UPLOAD_DIR + path.sep)) return json(res, 404, { error: 'Not found' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });

  // DECISION: digital files under /media/files/* are NOT served directly.
  // They must be requested via /api/download/:fileId?token=... which checks
  // a signed URL. This prevents buyers from sharing raw file URLs.
  const relNorm = rel.replace(/\\/g, '/');
  if (relNorm.startsWith('files/')) {
    return json(res, 403, { error: 'Use /api/download/:fileId?token=... to access this file' });
  }

  const ext = path.extname(file).toLowerCase();
  const types = {
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.epub': 'application/epub+zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=86400'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function downloadFile(req, res, pathname, query) {
  const fileId = decodeURIComponent(pathname.slice('/api/download/'.length));
  if (!fileId || fileId.includes('/') || fileId.includes('\\') || fileId.includes('..')) {
    return json(res, 400, { error: 'Invalid file id' });
  }
  const token = query.get('token') || '';
  const orderId = query.get('order') || '';
  const expiresAt = query.get('exp') || '';
  const sig = token;
  if (!verifyDownload(fileId, orderId, expiresAt, sig)) {
    return json(res, 403, { error: 'Download link is invalid or has expired' });
  }
  const file = path.resolve(UPLOAD_DIR, 'files', fileId);
  if (!file.startsWith(path.join(UPLOAD_DIR, 'files') + path.sep)) return json(res, 404, { error: 'Not found' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'Not found' });

  const ext = path.extname(file).toLowerCase();
  const types = {
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.epub': 'application/epub+zip'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${path.basename(file)}"`
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-store' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-store' },
  '/sw.js': { file: 'sw.js', type: 'application/javascript; charset=utf-8', cache: 'no-store' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8', cache: 'public, max-age=300' }
};

function sendFile(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const entry = STATIC_FILES[pathname];
  if (!entry) return json(res, 404, { error: 'Not found' });
  const file = path.join(ROOT, entry.file);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': entry.cache,
    'Service-Worker-Allowed': '/'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
}
}

// ---------------------------------------------------------------------------
// Cleanup loop
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [k, times] of loginAttempts) {
    const fresh = times.filter(t => now - t < 15 * 60 * 1000);
    if (fresh.length) loginAttempts.set(k, fresh); else loginAttempts.delete(k);
  }
  for (const [k, times] of publicRate) {
    const fresh = times.filter(t => now - t < 60 * 1000);
    if (fresh.length) publicRate.set(k, fresh); else publicRate.delete(k);
  }
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
  for (const [t, r] of resetTokens) if (r.expires < now) resetTokens.delete(t);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  setCors(res);
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    const ip = ipOf(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if ((p === '/health' || p === '/api/health') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      return json(res, 200, { ok: true, service: 'mastertech' });
    }

    if (p === '/status' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        uptime: Math.floor(process.uptime()),
        dbPath: DB_FILE,
        counts: {
          laptops: db.catalog.laptops.length,
          digital: db.catalog.digital.length,
          orders: db.orders.length,
          messages: db.messages.length,
          audit: db.audit.length,
          pendingEmails: db.pendingEmails.filter(e => !e.sentAt).length
        },
        emailEnabled: EMAIL_ENABLED,
        r2Enabled: R2_ENABLED,
        lastWrite: new Date(lastWrite).toISOString()
      });
    }

    if (p.startsWith('/media/')) return mediaFile(req, res, p);

    if (p.startsWith('/api/download/')) return downloadFile(req, res, p, u.searchParams);

    if (p.startsWith('/api/')) {
      // ------------------------------------------------------------- PUBLIC
      if (req.method === 'GET' && p === '/api/catalog') {
        const publishedLaptops = db.catalog.laptops.filter(x => x.published !== false);
        const publishedDigital = db.catalog.digital.filter(x => x.published !== false);
        return json(res, 200, {
          catalog: { laptops: publishedLaptops, digital: publishedDigital },
          settings: db.settings
        });
      }

      if (req.method === 'GET' && p === '/api/settings') {
        return json(res, 200, { settings: db.settings });
      }

      if (req.method === 'GET' && p === '/api/csrf') {
        const t = newToken();
        db.csrfTokens[t] = { expires: Date.now() + 4 * 60 * 60 * 1000 };
        saveDb();
        return json(res, 200, { token: t });
      }

      if (req.method === 'POST' && p === '/api/orders') {
        if (!rateLimit(publicRate, 'order:' + ip, 10, 60_000)) {
          return json(res, 429, { error: 'Too many requests. Try again in a minute.' });
        }
        const b = await readBody(req);
        const customer = cleanCustomer(b.customer);
        if (!customer) return json(res, 400, { error: 'Valid customer name and email are required' });
        const built = buildOrderItems(b.items);
        if (built.error) return json(res, 400, { error: built.error });

        // Decrement stock for physical goods.
        for (const item of built.items) {
          if (item.type === 'laptop') {
            const product = routeProduct(item.id);
            if (product && product.stock > 0) product.stock -= item.qty;
          }
        }

        const order = {
          orderId: 'MT-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomInt(100, 1000),
          date: new Date().toISOString(),
          status: 'Pending',
          customer,
          items: built.items,
          total: built.total,
          notes: '',
          refunded: false,
          cancelledAt: null,
          emailSent: b.emailSent === true
        };
        db.orders.unshift(order);
        audit('order.create', order.orderId, { ip, emailSent: order.emailSent });
        saveDb();
        queueOrderEmails(order);
        return json(res, 201, { order });
      }

      if (req.method === 'POST' && p === '/api/messages') {
        if (!rateLimit(publicRate, 'msg:' + ip, 10, 60_000)) {
          return json(res, 429, { error: 'Too many requests. Try again in a minute.' });
        }
        const b = await readBody(req);
        const name = safeString(b.name, 120);
        const email = String(b.email || '').trim().slice(0, 254);
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json(res, 400, { error: 'Valid name and email are required' });
        }
        const msg = {
          id: 'MSG-' + Date.now().toString(36) + '-' + crypto.randomInt(100, 1000),
          date: new Date().toISOString(),
          type: safeString(b.type || 'Message', 80),
          name, email,
          phone: safeString(b.phone, 60),
          subject: safeString(b.subject, 200),
          message: safeString(b.message || b.details, 5000)
        };
        db.messages.unshift(msg);
        saveDb();
        return json(res, 201, { message: msg });
      }

      // ------------------------------------------------------------- AUTH
      if (req.method === 'POST' && p === '/api/admin/login') {
        if (!rateLimit(loginAttempts, ip, 8, 15 * 60 * 1000)) {
          return json(res, 429, { error: 'Too many login attempts. Try again later.' });
        }
        const b = await readBody(req);
        if (!passwordMatches(String(b.password || ''), db.adminPasswordHash)) {
          return json(res, 401, { error: 'Invalid admin password' });
        }
        if (db.adminTotpEnabled) {
          const code = String(b.totpCode || '').trim();
          if (!authenticator || !authenticator.check(code, db.adminTotpSecret)) {
            return json(res, 401, { error: 'Invalid 2FA code', requires2FA: true });
          }
        }
        const t = newToken();
        const csrf = newToken();
        sessions.set(t, { expires: Date.now() + SESSION_TTL_MS, csrf });
        return json(res, 200, { token: t, csrf, requires2FA: Boolean(db.adminTotpEnabled) });
      }

      // ------------------------------------------------------------- ADMIN (guarded)
      const t = auth(req);
      if (!t) return json(res, 401, { error: 'Unauthorized' });

      // CSRF: required on all state-changing admin requests.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const csrfHeader = String(req.headers['x-csrf-token'] || '');
        const session = sessions.get(t);
        if (!session || !csrfHeader || csrfHeader !== session.csrf) {
          return json(res, 403, { error: 'CSRF token missing or invalid' });
        }
      }

      if (req.method === 'POST' && p === '/api/admin/logout') {
        sessions.delete(t);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && p === '/api/admin/dashboard') {
        return json(res, 200, {
          catalog: db.catalog,
          settings: db.settings,
          orders: db.orders,
          messages: db.messages,
          audit: db.audit.slice(0, 200),
          feedback: db.orders.filter(o => o.comment || o.liked === 'Yes')
        });
      }

      // ---------- TOTP ----------
      if (req.method === 'POST' && p === '/api/admin/2fa/setup') {
        if (!authenticator) return json(res, 500, { error: '2FA library not installed' });
        const secret = authenticator.generateSecret();
        const otpauth = authenticator.keyuri('admin', 'MasterTech', secret);
        db.adminTotpPendingSecret = secret;
        saveDb();
        audit('2fa.setup.begin', 'admin', { ip });
        return json(res, 200, { otpauth, secret });
      }
      if (req.method === 'POST' && p === '/api/admin/2fa/verify') {
        if (!authenticator) return json(res, 500, { error: '2FA library not installed' });
        const b = await readBody(req);
        const code = String(b.code || '').trim();
        const secret = db.adminTotpPendingSecret;
        if (!secret || !authenticator.check(code, secret)) {
          return json(res, 400, { error: 'Invalid code' });
        }
        db.adminTotpSecret = secret;
        db.adminTotpEnabled = true;
        delete db.adminTotpPendingSecret;
        saveDb();
        audit('2fa.enabled', 'admin', { ip });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/admin/2fa/disable') {
        if (!authenticator) return json(res, 500, { error: '2FA library not installed' });
        const b = await readBody(req);
        if (!passwordMatches(String(b.password || ''), db.adminPasswordHash)) {
          return json(res, 401, { error: 'Password is incorrect' });
        }
        if (db.adminTotpEnabled && !authenticator.check(String(b.code || ''), db.adminTotpSecret)) {
          return json(res, 401, { error: '2FA code is incorrect' });
        }
        delete db.adminTotpSecret;
        delete db.adminTotpEnabled;
        saveDb();
        audit('2fa.disabled', 'admin', { ip });
        return json(res, 200, { ok: true });
      }

      // ---------- Password change ----------
      if (req.method === 'PUT' && p === '/api/admin/password') {
        const b = await readBody(req);
        if (!passwordMatches(String(b.currentPassword || ''), db.adminPasswordHash)) {
          return json(res, 401, { error: 'Current password is incorrect' });
        }
        const next = String(b.newPassword || '');
        if (next.length < 12) return json(res, 400, { error: 'New password must be at least 12 characters' });
        db.adminPasswordHash = passwordHash(next);
        saveDb();
        audit('admin.password.change', 'admin', { ip });
        return json(res, 200, { ok: true });
      }

      // ---------- Password reset ----------
      if (req.method === 'POST' && p === '/api/admin/forgot') {
        const b = await readBody(req);
        const email = String(b.email || '').trim().slice(0, 254);
        const adminEmail = (db.settings.email || '').trim();
        // Always return 200 to prevent email enumeration.
        if (adminEmail && email.toLowerCase() === adminEmail.toLowerCase()) {
          const rt = newToken();
          resetTokens.set(rt, { expires: Date.now() + 60 * 60 * 1000, email: adminEmail });
          const url = (BASE_URL || '') + '/#reset=' + rt;
          queueEmail(adminEmail, 'MasterTech password reset',
            `<p>Reset your MasterTech admin password:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour.</p>`);
          saveDb();
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/admin/reset') {
        const b = await readBody(req);
        const token = String(b.token || '');
        const next = String(b.newPassword || '');
        const rec = resetTokens.get(token);
        if (!rec || rec.expires < Date.now()) return json(res, 400, { error: 'Reset link is invalid or has expired' });
        if (next.length < 12) return json(res, 400, { error: 'Password must be at least 12 characters' });
        db.adminPasswordHash = passwordHash(next);
        resetTokens.delete(token);
        saveDb();
        audit('admin.password.reset', 'admin', { ip });
        return json(res, 200, { ok: true });
      }

      // ---------- Uploads ----------
      if (req.method === 'POST' && p === '/api/admin/upload') {
        const b = await readBody(req);
        const up = readBase64Upload(b);
        const ext = MIME_EXT[up.mime];
        const kind = b.kind === 'cover' ? 'covers' : 'files';
        const dir = path.join(UPLOAD_DIR, kind);
        fs.mkdirSync(dir, { recursive: true });
        const filename = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + ext;
        const target = path.join(dir, filename);
        fs.writeFileSync(target, up.buffer);

        let thumbUrl = '';
        if (sharp && kind === 'covers' && up.mime.startsWith('image/')) {
          try {
            fs.mkdirSync(THUMB_DIR, { recursive: true });
            const thumbName = filename.replace(/\.[^.]+$/, '.webp');
            const thumbPath = path.join(THUMB_DIR, thumbName);
            await sharp(up.buffer).resize(200).webp({ quality: 80 }).toFile(thumbPath);
            thumbUrl = '/media/thumbs/' + thumbName;
          } catch (err) {
            console.warn('Thumbnail generation failed:', err.message);
          }
        }

        audit('upload.create', kind + '/' + filename, { ip, mime: up.mime, size: up.buffer.length });
        saveDb();
        return json(res, 201, {
          url: '/media/' + kind + '/' + filename,
          thumbUrl,
          name: safeName(b.name),
          size: up.buffer.length,
          mime: up.mime
        });
      }

      // ---------- Signed downloads ----------
      if (req.method === 'POST' && p === '/api/admin/sign-download') {
        const b = await readBody(req);
        const fileUrl = String(b.fileUrl || '');
        const orderId = safeString(b.orderId, 80);
        const expiresIn = Math.min(Math.max(Number(b.expiresIn) || DOWNLOAD_TTL_MS, 60_000), 7 * 24 * 60 * 60 * 1000);
        const m = fileUrl.match(/^\/media\/files\/(.+)$/);
        if (!m) return json(res, 400, { error: 'fileUrl must be under /media/files/' });
        const fileId = m[1];
        const expiresAt = Date.now() + expiresIn;
        const sig = signDownload(fileId, orderId, expiresAt);
        const base = BASE_URL || '';
        const url = `${base}/api/download/${encodeURIComponent(fileId)}?order=${encodeURIComponent(orderId)}&exp=${expiresAt}&token=${sig}`;
        audit('download.sign', fileId, { ip, orderId });
        saveDb();
        return json(res, 200, { url, expiresAt });
      }

      // ---------- Products ----------
      if (req.method === 'POST' && p === '/api/admin/products') {
        const b = safeProduct(await readBody(req));
        const validation = validateProduct(b);
        if (validation) return json(res, 400, { error: validation });
        db.catalog.laptops = db.catalog.laptops.filter(x => x.id !== b.id);
        db.catalog.digital = db.catalog.digital.filter(x => x.id !== b.id);
        if (b.type === 'laptop') db.catalog.laptops.push(b);
        else db.catalog.digital.push(b);
        audit('product.save', b.id, { ip, type: b.type });
        saveDb();
        return json(res, 200, { product: b, catalog: db.catalog });
      }

      if (req.method === 'DELETE' && p.startsWith('/api/admin/products/')) {
        const id = decodeURIComponent(p.slice('/api/admin/products/'.length));
        if (!id) return json(res, 400, { error: 'Product id is required' });
        const before = db.catalog.laptops.length + db.catalog.digital.length;
        db.catalog.laptops = db.catalog.laptops.filter(x => x.id !== id);
        db.catalog.digital = db.catalog.digital.filter(x => x.id !== id);
        if (before === db.catalog.laptops.length + db.catalog.digital.length) {
          return json(res, 404, { error: 'Product not found' });
        }
        audit('product.delete', id, { ip });
        saveDb();
        return json(res, 200, { catalog: db.catalog });
      }

      // ---------- Settings ----------
      if (req.method === 'PUT' && p === '/api/admin/settings') {
        const b = await readBody(req);
        const next = { ...db.settings };
        for (const key of ['phone','email','location','whatsapp','facebook','instagram','linkedin','currency']) {
          if (b[key] !== undefined) next[key] = safeString(b[key], 500);
        }
        if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
          return json(res, 400, { error: 'Business email is invalid' });
        }
        if (next.currency.length > 5) return json(res, 400, { error: 'Currency symbol is too long' });
        for (const key of ['whatsapp','facebook','instagram','linkedin']) {
          if (next[key] && !/^https?:\/\//i.test(next[key])) {
            return json(res, 400, { error: key + ' must be an http or https URL' });
          }
        }
        db.settings = next;
        audit('settings.save', 'settings', { ip });
        saveDb();
        return json(res, 200, { settings: db.settings });
      }

      // ---------- Orders (admin) ----------
      if (req.method === 'GET' && p === '/api/admin/orders') {
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 20, 1), 200);
        const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
        const items = db.orders.slice(offset, offset + limit);
        return json(res, 200, { items, total: db.orders.length, limit, offset });
      }

      if (req.method === 'PUT' && p.startsWith('/api/admin/orders/')) {
        const id = decodeURIComponent(p.slice('/api/admin/orders/'.length));
        const b = await readBody(req);
        const o = db.orders.find(x => x.orderId === id);
        if (!o) return json(res, 404, { error: 'Order not found' });
        const allowed = ['Pending', 'Confirmed', 'Processing', 'Completed', 'Cancelled'];
        if (b.status && !allowed.includes(b.status)) return json(res, 400, { error: 'Invalid order status' });
        if (b.status) o.status = b.status;
        if (b.notes !== undefined) o.notes = safeString(b.notes, 5000);
        if (b.refunded !== undefined) o.refunded = Boolean(b.refunded);
        if (b.status === 'Cancelled' && !o.cancelledAt) o.cancelledAt = new Date().toISOString();
        audit('order.update', o.orderId, { ip, status: o.status, refunded: o.refunded });
        saveDb();
        return json(res, 200, { order: o });
      }

      if (req.method === 'DELETE' && p === '/api/admin/orders') {
        db.orders = [];
        audit('orders.clear', 'all', { ip });
        saveDb();
        return json(res, 200, { ok: true });
      }

      // ---------- Messages (admin) ----------
      if (req.method === 'GET' && p === '/api/admin/messages') {
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 20, 1), 200);
        const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
        const items = db.messages.slice(offset, offset + limit);
        return json(res, 200, { items, total: db.messages.length, limit, offset });
      }

      if (req.method === 'DELETE' && p === '/api/admin/messages') {
        db.messages = [];
        audit('messages.clear', 'all', { ip });
        saveDb();
        return json(res, 200, { ok: true });
      }

      // ---------- Audit ----------
      if (req.method === 'GET' && p === '/api/admin/audit') {
        const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 20, 1), 200);
        const offset = Math.max(Number(u.searchParams.get('offset')) || 0, 0);
        const items = db.audit.slice(offset, offset + limit);
        return json(res, 200, { items, total: db.audit.length, limit, offset });
      }

      return json(res, 404, { error: 'API route not found' });
    }

    return sendFile(req, res);
  } catch (e) {
    if (!e.statusCode || e.statusCode >= 500) console.error(e);
    json(res, e.statusCode || 500, {
      error: (e.statusCode === 400 || e.statusCode === 413) ? e.message : 'Server error'
    });
  }
});

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------
function queueOrderEmails(order) {
  if (!EMAIL_ENABLED) return;

  const itemLines = order.items.map(x => `<li>${x.name} × ${x.qty} — ${(x.price * x.qty).toFixed(2)}</li>`).join('');
  const businessEmail = (db.settings.email || '').trim();

  if (order.customer.email) {
    queueEmail(order.customer.email, `MasterTech order ${order.orderId}`,
      `<h2>Thanks for your order</h2>
       <p>Hi ${order.customer.name},</p>
       <p>We received your order <b>${order.orderId}</b>. We'll contact you to confirm payment and delivery.</p>
       <ul>${itemLines}</ul>
       <p><b>Total:</b> ${order.total.toFixed(2)}</p>`);
  }
  if (businessEmail) {
    queueEmail(businessEmail, `New order ${order.orderId}`,
      `<h2>New order received</h2>
       <p><b>Customer:</b> ${order.customer.name} &lt;${order.customer.email}&gt;</p>
       <p><b>Phone:</b> ${order.customer.phone || '—'}</p>
       <p><b>Address:</b> ${order.customer.address || '—'}</p>
       <ul>${itemLines}</ul>
       <p><b>Total:</b> ${order.total.toFixed(2)}</p>`);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = REQUEST_TIMEOUT_MS + 5_000;

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// DECISION: on boot, if R2 is enabled and the local DB is missing, attempt a
// pull. This makes Render free-tier restarts recover state from R2.
async function boot() {
  if (R2_ENABLED && !fs.existsSync(DB_FILE)) {
    console.log('Local DB missing — attempting R2 restore...');
    await pullDbFromR2();
  }
  server.listen(PORT, HOST, () => {
    console.log(`MasterTech v7 running at http://${HOST}:${PORT}`);
    console.log(`DB:      ${DB_FILE}`);
    console.log(`Uploads: ${UPLOAD_DIR}`);
    console.log(`Email:   ${EMAIL_ENABLED ? 'Resend enabled' : 'queued only (no Resend key)'}`);
    console.log(`R2 sync: ${R2_ENABLED ? 'enabled' : 'disabled'}`);
  });
}

boot();

function shutdown(signal) {
  console.log(`${signal} received — shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));