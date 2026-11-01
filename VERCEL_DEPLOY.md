# Vercel deploy guide (Hinglish, step by step)

Domain: https://notes.nxtlevellive.xyz

## Pehle samjho: kya badla
| Pehle (VPS) | Ab (Vercel) |
|---|---|
| Ek hamesha chalne wala server | Express ek Vercel Function ban gaya (`index.js`) |
| Images/ZIP disk pe | Vercel Blob (images = public store, ZIP = private store) |
| ZIP server se upload | Browser se seedha Blob (4.5 MB limit bypass) |
| Rate limit memory me | MongoDB me (instances ke beech shared) |
| setInterval cleanup | Vercel Cron (`/api/cron/cleanup`, roz 1 baar) |
| `backend/.env`, `PRIVATE_PRODUCT_DIR` | Root `.env` (sirf local), Vercel me env variables |

## Step 1: Local tayari (Node 20+ chahiye)
```
npm install
npm run build:client
```
Ye `public/vendor/blob-client.js` banata hai (admin ZIP upload ke liye zaruri). Phir `package-lock.json` aur `public/vendor/blob-client.js` dono GitHub pe commit karo.
(Agar ye file na bani to admin me ZIP upload par "Upload library missing" error aayega.)

## Step 2: MongoDB Atlas
1. Free cluster banao, Database Access me user + password banao (password me special character ho to URL-encode karo).
2. Network Access: Vercel ke IPs badalte rehte hain, isliye `0.0.0.0/0` allow karna padta hai (strong password zaruri). Static IP chahiye to Vercel ka paid option dekho.
3. Connection string copy karo => `MONGODB_URI`.

## Step 3: Google OAuth
Google Cloud Console -> APIs & Services -> Credentials -> OAuth client (Web). Authorized JavaScript origins me `https://notes.nxtlevellive.xyz` daalo. Client ID => `GOOGLE_CLIENT_ID`. (Preview URLs par Google login nahi chalega, wildcard allowed nahi hota; Google login production domain par test karo.)

## Step 4: GitHub + Vercel project
1. Repo private banao, code push karo (`.env` kabhi nahi).
2. Vercel -> Add New -> Project -> repo import karo. Framework: Express/Other (auto detect hoga), Root Directory: repo root.
3. Build Command: `npm run build` (ye sirf client bundle banata hai, fail nahi hota). Output Directory khali.

## Step 5: Vercel Blob (2 stores)
Project -> Storage -> Create Database -> Blob:
1. **Public store** (images). Connect to Project; environment variable prefix `BLOB_IMAGES` rakho => `BLOB_IMAGES_READ_WRITE_TOKEN` banega.
2. **Private store** (paid ZIP). Connect to Project; prefix `BLOB_FILES` => `BLOB_FILES_READ_WRITE_TOKEN`.
Agar dashboard me prefix option na mile ya token auto-add na ho, store ka read-write token copy karke upar wale naam se manually env me daalo. Ye app tokens explicitly use karta hai.

## Step 6: Environment Variables (Project Settings -> Environment Variables)
| Name | Value | Environment |
|---|---|---|
| MONGODB_URI | Atlas string | Production (+Preview alag DB ke saath) |
| MONGODB_DB | next_level_notes (Preview: next_level_notes_preview) | Prod/Preview |
| ADMIN_PASSWORD | strong password | Prod/Preview |
| JWT_SECRET | 32+ random chars | Prod/Preview |
| FRONTEND_ORIGINS | https://notes.nxtlevellive.xyz | Production |
| GOOGLE_CLIENT_ID | Google Web Client ID | Prod/Preview |
| BLOB_IMAGES_READ_WRITE_TOKEN | public store token | Prod/Preview |
| BLOB_FILES_READ_WRITE_TOKEN | private store token | Prod/Preview |
| CRON_SECRET | 16+ random chars | Production |
Secrets ko "Sensitive" mark karo. Env change ke baad **redeploy** zaruri hai.
Random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Step 7: Function settings
Settings -> Functions: Max Duration badhao (100MB ZIP download stream hota hai). Apne plan ka limit docs me dekho. Function Region ko Atlas cluster ke region ke paas rakho.

## Step 8: Domain
Settings -> Domains -> `notes.nxtlevellive.xyz` add karo. DNS me wahi record daalo jo Vercel dikhaye (aam taur par CNAME). Cloudflare me ho to **DNS only (grey cloud)** rakho, proxy ON mat karo.

## Step 9: Live check
1. `https://notes.nxtlevellive.xyz/api/health` => `{"ok":true,...}`
2. Google login.
3. `/admin` login, phir `/api/admin/diagnostics` kholo: database connected, dono storage `true`, cronSecretConfigured `true`.
4. Admin -> Settings me UPI ID daalo.
5. Product banao: image + ZIP (chhota pehle, phir bada).
6. Test order -> admin se status `paid` -> customer download. Unpaid order download nahi hona chahiye.
7. Vercel -> Settings -> Cron Jobs me cleanup job dikhna chahiye.

## Troubleshooting
| Problem | Matlab / Fix |
|---|---|
| 500 FUNCTION_INVOCATION_FAILED | Logs dekho. Aam wajah: zaruri env missing (MONGODB_URI, ADMIN_PASSWORD, JWT_SECRET 32+, FRONTEND_ORIGINS) |
| 503 Service temporarily unavailable | Atlas IP allow nahi / URI galat |
| Origin not allowed by CORS | FRONTEND_ORIGINS me exact domain nahi (https, bina trailing slash) |
| Admin ZIP: "Upload library missing" | `npm run build:client` chalake `public/vendor/blob-client.js` commit karo |
| Upload token / 401 | Admin login expire; dobara login. Ya BLOB_FILES token galat |
| 503 File/Image storage not configured | Blob token env missing; redeploy karo |
| Google origin_mismatch | Google Console origins me domain |
| Admin login lock | ADMIN_LOCK_MINUTES wait ya MongoDB `admin_login_attempts` collection saaf |
| Download 504 | Function Max Duration badhao |

## Jo verify nahi ho paya (honest note)
Is zip ko banate waqt Vercel, MongoDB aur Blob tak access nahi tha. Code ka syntax aur module load check hua hai, lekin asli end-to-end test (upload, download, cron) tumhe Preview deployment par karna hai. Pehle Preview + alag DB + alag Blob stores par test karo, phir production.
