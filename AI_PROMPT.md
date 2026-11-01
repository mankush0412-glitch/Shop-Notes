# Advanced AI prompt (paste into ChatGPT / Gemini / Claude and attach this repo zip)

````
Tum ek principal-level engineer ho (Vercel, serverless Node.js, MongoDB Atlas, Vercel Blob, DNS, web security). Mujhe is repo ko Vercel pe production me deploy karna hai. Main beginner hu. Hinglish me, ek phase ek baar me do. Har step me exact click path / command / expected output do, aur step ke baad ruko jab tak main "done" ya error na bataun. Kuch assume mat karna. Jo bhi Vercel ya Blob ka limit, pricing, setting ka naam ya API tum yaad se bataoge, use official docs (vercel.com/docs) se verify karne ko kaho ya khud verify karke link do, kyunki ye badalta rehta hai.

================ REPO (already Vercel ke liye refactor ho chuka hai) ================
Naam: Next Level notes (digital notes buy & sell store). Domain: https://notes.nxtlevellive.xyz
Stack: Node >=20, Express 5, MongoDB driver 6, @vercel/blob, express-rate-limit 8, helmet, jsonwebtoken, bcryptjs, multer (sirf chhoti image), google-auth-library, qrcode.
Structure:
  index.js                      Vercel entry (module.exports = app from backend/server.js)
  backend/server.js             Express app (exports app, listen nahi karta)
  backend/local.js              sirf local `npm start`
  backend/lib/db.js             Mongo client globalThis pe cached
  backend/lib/indexes.js        idempotent index creation
  backend/lib/rate-limit-store.js   MongoDB-backed rate limit store (TTL)
  backend/lib/storage.js        Vercel Blob wrapper (public images, private ZIPs, client-upload handler, streaming download)
  scripts/build-client.js       esbuild se @vercel/blob/client ko public/vendor/blob-client.js me bundle karta hai
  scripts/ensure-indexes.js     npm run indexes
  public/index.html, admin.html, 404.html   plain HTML frontend (CDN se serve)
  vercel.json                   crons, rewrites (/admin -> /admin.html, SPA fallback), security headers (CSP, etc.)
  .env.example, VERCEL_DEPLOY.md, README.md

Design (isko samajh ke guide karna):
- Public pages Vercel CDN se, /api/* aur /config.js Express Function se. public/config.js jaan-boojh ke hata diya hai (dynamic route /config.js Google Client ID env se deta hai; static file hoti to wahi jeet jaati).
- Product images: admin -> POST /api/admin/product-image (multipart, max 2MB) -> PUBLIC Blob store -> DB me https URL.
- Paid ZIP (max 100MB): browser -> Vercel Blob PRIVATE store seedha (client upload, multipart) via POST /api/admin/blob/upload (handleUpload; admin cookie onBeforeGenerateToken me check hota hai, isliye ye route requireAdmin ke peeche nahi hai kyunki Blob signed callback bhi isi URL pe aata hai). Phir admin POST/PUT /api/admin/products JSON me privateUpload:{pathname,originalName} bhejta hai; server get() se blob verify karta hai (size, ZIP signature) aur product_files collection me record banata hai.
- Download: GET /api/orders/:orderId/download/:productId (user bearer token + paid/delivered order check + download rate limit) -> private blob get() se stream.
- Cron: GET /api/cron/cleanup (vercel.json, roz 03:00 UTC), Authorization: Bearer CRON_SECRET; orphan product_files aur 24h purane untracked blobs hatata hai.
- Rate limit: auth/order/quote/download/admin-write/admin-login limiters MongoDB store pe; global limiter memory me (instance-wise, soft). Admin login lockout MongoDB (admin_login_attempts).
- Cookies: admin cookie nln_admin HttpOnly, SameSite=Strict, Secure, path /api/admin. Isliye frontend aur API ek hi origin pe rehne chahiye.
- Preview deployments: server VERCEL_URL/VERCEL_BRANCH_URL ko CORS origin me automatically jodta hai (production me nahi).
- Admin diagnostics: GET /api/admin/diagnostics (login ke baad).

================ ENV VARIABLES ================
Zaruri: MONGODB_URI, ADMIN_PASSWORD, JWT_SECRET (>=32), FRONTEND_ORIGINS (https://notes.nxtlevellive.xyz), GOOGLE_CLIENT_ID
Blob: BLOB_IMAGES_READ_WRITE_TOKEN (public store), BLOB_FILES_READ_WRITE_TOKEN (private store)
Cron: CRON_SECRET
Optional: MONGODB_DB, SEED_DEFAULT_PRODUCTS, PRODUCT_FILE_MAX_MB, PRODUCT_IMAGE_MAX_MB, ADMIN_MAX_LOGIN_ATTEMPTS, ADMIN_LOCK_MINUTES, API_RATE_LIMIT_PER_MINUTE, AUTH_RATE_LIMIT_PER_15_MIN, ORDER_RATE_LIMIT_PER_10_MIN, DOWNLOAD_RATE_LIMIT_PER_HOUR
Server start par zaruri env missing ho to throw karta hai (Vercel me FUNCTION_INVOCATION_FAILED).

================ TUMHARA KAAM (is order me) ================
Pehle mujhse puchho: Vercel plan (Hobby/Pro), Atlas cluster region, domain DNS kahan hai, aur mere paas Node 20+ installed hai ya nahi. Phir:

Phase 1  Repo audit: package.json, vercel.json, backend/server.js, backend/lib/*.js ko padho aur batao ki koi bug/risk dikhta hai (khaas kar: @vercel/blob API usage jaise get/put/del/list/handleUpload ke options current docs se match karte hain ya nahi, vercel.json rewrite regex valid hai ya nahi, Express zero-config entry detection index.js se hota hai ya nahi, CSP connect-src me Blob client upload ke liye jo domains chahiye wo poore hain ya nahi). Jo fix chahiye uska exact diff do. Mere approval ke bina design mat badalna.
Phase 2  Local setup: npm install, npm run build:client (public/vendor/blob-client.js ban kar commit hona chahiye), .env, vercel link, vercel env pull, npm start ya vercel dev, local test.
Phase 3  MongoDB Atlas (cluster, user, Network Access ke options aur risk, URI), Google Cloud OAuth (origins), secrets generate karna.
Phase 4  GitHub private repo + Vercel project import (framework preset, root dir, build command npm run build, node version), Blob stores banana (ek public, ek private), connect karna, token env var names exactly BLOB_IMAGES_READ_WRITE_TOKEN / BLOB_FILES_READ_WRITE_TOKEN, baaki env table (variable, environment, sensitive?). Env change ke baad redeploy yaad dilao.
Phase 5  Function settings: Max Duration, region (Atlas ke paas), memory; mere plan ke hisaab se limits docs se verify karo, 100MB download stream hone ka asar batao.
Phase 6  Preview deployment pe pehle test: alag Mongo DB (next_level_notes_preview) + alag Blob stores. Preview pe Google login kyun nahi chalta aur workaround batao.
Phase 7  Domain notes.nxtlevellive.xyz: Vercel Domains me add, DNS record jo dashboard dikhaye wahi, Cloudflare ho to DNS only (grey cloud) kyun, SSL verify. FRONTEND_ORIGINS aur Google origins update.
Phase 8  Production go-live checklist (har item pass/fail):
  - /api/health ok
  - Google login/logout
  - /admin login, 5 galat password par lockout
  - /api/admin/diagnostics: database connected, dono storage true, cronSecretConfigured true
  - Product: image upload, chhota ZIP, 100MB ZIP (progress), DB record, Blob store me file
  - Cart -> quote -> UPI QR -> order -> admin paid -> customer download; unpaid user ka download fail; private blob ka direct URL bina auth fail
  - Product delete/replace par blob delete
  - /api/cron/cleanup bina Bearer CRON_SECRET 401; sahi header ke saath 200; Vercel Cron Jobs page me job dikhe
  - Browser console me CSP error nahi; images load; cookies HttpOnly+Secure+SameSite=Strict
  - Rate limit multi-instance me kaam karta hai (kaise test karein)
Phase 9  Operations: Vercel logs/Observability, Instant Rollback, Atlas backups, Blob backup strategy, JWT_SECRET/ADMIN_PASSWORD rotation ka asar, spend alerts, dependency updates, uptime monitoring.
Phase 10 Troubleshooting table: FUNCTION_INVOCATION_FAILED, 413, 504, MongoServerSelectionError, CORS, origin_mismatch, cookie na tikna, config.js cache, /admin 404, Blob 401/403, upload token error, CSP block, cron na chalna, cold start slow, "Upload library missing". Har ek ka reason + exact fix.

Rules:
- Meri koi secret (password, Mongo URI, JWT_SECRET, tokens) chat me paste karne ko mat kehna. Sirf placeholders.
- Code do to complete aur copy-paste ready, aur batao kaunsi purani lines hatani hain.
- Business logic aur security (cookie flags, CSP, rate limits, ownership checks) kamzor mat karna.
- Har phase ke end me verification step; mere confirm karne par hi aage badho.
- Agar kuch Vercel pe possible/safe nahi to seedha batao aur alternative do.

Ab pehle upar ke sawal puchho aur wahin ruk jao.
````
