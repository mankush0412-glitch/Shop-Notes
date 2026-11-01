'use strict';
// Vercel Blob storage layer.
//   - Product images  -> PUBLIC store  (BLOB_IMAGES_READ_WRITE_TOKEN)
//   - Paid ZIP files  -> PRIVATE store (BLOB_FILES_READ_WRITE_TOKEN)
// @vercel/blob is loaded with dynamic import() so it works from this CommonJS app.
const { Readable, pipeline } = require('stream');

const FILES_TOKEN = process.env.BLOB_FILES_READ_WRITE_TOKEN || '';
const IMAGES_TOKEN = process.env.BLOB_IMAGES_READ_WRITE_TOKEN || '';

let blobModule;
let blobClientModule;
async function blob() { return (blobModule ||= await import('@vercel/blob')); }
async function blobClient() { return (blobClientModule ||= await import('@vercel/blob/client')); }

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const filesConfigured = () => Boolean(FILES_TOKEN);
const imagesConfigured = () => Boolean(IMAGES_TOKEN);
const status = () => ({ privateFilesStore: filesConfigured(), publicImagesStore: imagesConfigured() });

// ---------- public product images ----------
const IMAGE_TYPES = { jpg:'image/jpeg', png:'image/png', webp:'image/webp', avif:'image/avif' };

async function putProductImage(buffer, ext) {
  if (!IMAGES_TOKEN) throw httpError(503, 'Image storage is not configured (BLOB_IMAGES_READ_WRITE_TOKEN missing)');
  const { put } = await blob();
  const result = await put(`products/prod-${Date.now()}.${ext}`, buffer, {
    access: 'public',
    addRandomSuffix: true,
    contentType: IMAGE_TYPES[ext] || 'application/octet-stream',
    token: IMAGES_TOKEN
  });
  return result.url;
}

async function deleteProductImage(image) {
  if (!IMAGES_TOKEN) return;
  let url;
  try { url = new URL(String(image || '')); } catch { return; } // legacy relative paths: nothing to delete
  if (url.protocol !== 'https:' || !/\.blob\.vercel-storage\.com$/i.test(url.hostname)) return;
  try {
    const { del } = await blob();
    await del(url.href, { token: IMAGES_TOKEN });
  } catch (err) {
    console.warn('Could not delete product image:', err.message);
  }
}

// ---------- private ZIP files ----------
async function getPrivateBlob(pathname) {
  if (!FILES_TOKEN) throw httpError(503, 'File storage is not configured (BLOB_FILES_READ_WRITE_TOKEN missing)');
  const { get } = await blob();
  let result;
  try {
    result = await get(pathname, { access: 'private', token: FILES_TOKEN });
  } catch (err) {
    if (err?.name === 'BlobNotFoundError' || /not.?found/i.test(String(err?.message || ''))) return null;
    throw err;
  }
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return result;
}

async function deletePrivateBlob(urlOrPathname) {
  if (!FILES_TOKEN || !urlOrPathname) return;
  try {
    const { del } = await blob();
    await del(urlOrPathname, { token: FILES_TOKEN });
  } catch (err) {
    console.warn('Could not delete private blob:', err.message);
  }
}

// Reads the first n bytes of a web ReadableStream and then cancels it.
async function readFirstBytes(stream, n) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < n) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, n);
}

async function sendPrivateBlob(res, pathname, downloadName) {
  const result = await getPrivateBlob(pathname);
  if (!result) throw httpError(404, 'File unavailable');
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Download-Filename', encodeURIComponent(downloadName));
  res.attachment(downloadName); // Content-Disposition + zip content-type
  if (result.blob?.size) res.set('Content-Length', String(result.blob.size));
  await new Promise((resolve, reject) => {
    pipeline(Readable.fromWeb(result.stream), res, err => (err ? reject(err) : resolve()));
  });
}

async function listPrivateBlobs(prefix, { maxPages = 5 } = {}) {
  if (!FILES_TOKEN) return [];
  const { list } = await blob();
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const result = await list({ prefix, limit: 1000, cursor, token: FILES_TOKEN });
    out.push(...(result.blobs || []));
    if (!result.hasMore) break;
    cursor = result.cursor;
  }
  return out;
}

// Server half of a browser -> Blob "client upload" (needed because Vercel Functions
// cannot accept request bodies larger than ~4.5 MB).
async function handleClientUpload({ body, request, maxBytes, authorize, pathnameAllowed }) {
  if (!FILES_TOKEN) throw httpError(503, 'File storage is not configured (BLOB_FILES_READ_WRITE_TOKEN missing)');
  const { handleUpload } = await blobClient();
  return handleUpload({
    body,
    request,
    token: FILES_TOKEN,
    onBeforeGenerateToken: async pathname => {
      await authorize(); // admin cookie check; throws 401
      if (!pathnameAllowed(pathname)) throw httpError(400, 'Invalid upload path');
      return {
        allowedContentTypes: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
        maximumSizeInBytes: maxBytes,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ kind: 'product-zip' })
      };
    },
    // The product save request (POST/PUT /api/admin/products) records the file,
    // so nothing is needed here.
    onUploadCompleted: async () => {}
  });
}

module.exports = {
  filesConfigured,
  imagesConfigured,
  status,
  putProductImage,
  deleteProductImage,
  getPrivateBlob,
  deletePrivateBlob,
  readFirstBytes,
  sendPrivateBlob,
  listPrivateBlobs,
  handleClientUpload
};
