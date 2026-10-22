# SRS IT CMS API

Express 5 + MongoDB (Mongoose 8) API behind the SRS IT website and its `/admin` panel. TypeScript, ESM, run with `tsx` in development. The API contract lives in `../docs/CMS-CONTRACT.md`; shared types are mirrored in `src/types.ts` from `../lib/cms/types.ts`.

## Setup

```bash
cd server
npm install
cp .env.example .env   # fill in Mongo, Cloudinary, JWT secrets, SITE_URL, REVALIDATE_SECRET, ADMIN_*
npm run dev            # http://localhost:4000
```

No database at hand (or Atlas blocks your IP)? Use an in-process MongoDB:

```bash
MONGODB_URI=memory npm run dev
```

On boot the API creates every index (unique slugs, TTLs) and, if there are no users yet, creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` (the email is logged, never the password).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode with `tsx`. |
| `npm run typecheck` | `tsc --noEmit` (strict). |
| `npm run build` / `npm start` | Compile to `dist/` and run it with Node. |
| `npm run create-admin` | Create the env admin, or promote it to admin. `npm run create-admin -- --reset` also resets its password and reactivates it. |
| `npm run seed` | Import the site's bundled content (see `src/scripts/seed.ts`). Reads it from the website repo, by default the sibling folder `../srsit` (override with `SITE_DIR`). |
| `./deploy.sh` | On the server: pull, install, build and restart the pm2 app (see "Deploying"). |

## Endpoints

All responses are JSON; errors are `{ "error": { "message", "code", "details"? } }` (validation → 422 with flattened zod issues plus dotted `issues[].path`; duplicate slug/key → 409 `conflict`).

| Area | Routes | Access |
| --- | --- | --- |
| Health | `GET /api/health` → `{ ok, db }` | public |
| Auth | `POST /api/auth/login`, `POST /refresh`, `POST /logout`, `GET /me`, `PATCH /me`, `POST /change-password` | login is rate limited (10 / 15 min per IP + email) |
| Content | `/api/admin/:collection` — `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /:id/duplicate`, `POST /reorder {ids}`, `POST /bulk {action, ids}` | read: any role · write: editor, admin |
| Settings | `GET` / `PUT /api/admin/settings/:key` (`site`, `home`) | read: any · write: editor, admin |
| Enquiries | `GET /api/admin/enquiries`, `GET /export.csv`, `GET /:id`, `PATCH /:id {status}`, `POST /:id/notes`, `DELETE /:id/notes/:noteId`, `DELETE /:id` | read: any · write: editor, admin |
| Media | `/api/admin/media` (see contract) | read: any · write: editor, admin |
| Users | `GET/POST /api/admin/users`, `GET/PATCH/DELETE /api/admin/users/:id` | admin |
| Activity | `GET /api/admin/activity?page=&limit=&entity=&action=&user=` | any role |
| Dashboard | `GET /api/admin/dashboard` → `DashboardStats` | any role |
| Cache | `POST /api/admin/revalidate` | editor, admin |
| Public | `GET /api/public/bundle`, `GET /api/public/:collection`, `GET /api/public/:collection/:slug`, `GET /api/public/settings/:key`, `POST /api/public/enquiries` | public (published content only) |

Collections: `solutions, industries, technologies, projects, articles, jobs, team, clients, faqs, pages, redirects`.

List queries accept `q` (partial, case-insensitive), `status`, `page`, `limit` (≤ 500), `sort` (e.g. `-updatedAt,title`) and per-collection filters: `category`, `group` (`none` = no group) and `featuredOnHome` for solutions; `solution` for industries/projects; `category` for technologies/articles; `department` for jobs; `permanent` for redirects. Creates fill defaults (`status: "draft"`, next `order`, a unique slug/key generated from `title` when omitted).

## Auth model

- `srs_at`: HS256 JWT (15 min, issuer/audience checked) in an httpOnly cookie, or `Authorization: Bearer`.
- `srs_rt`: opaque refresh token (30 days), stored only as an HMAC in `sessions`. Every refresh rotates it. Replaying a rotated token revokes all sessions from that login. The exception is a replay within 15 s of the rotation, which counts as parallel tabs refreshing at once and only gets a new access token.
- Every authenticated request re-checks the user (active, role) and the session (not revoked), so deactivation, role changes, logout and password changes take effect immediately.
- Roles: `viewer` read-only, `editor` content/settings/media/enquiries, `admin` also users. Nobody can delete or demote themselves or remove the last active admin.

## Caching and site revalidation

- `GET /api/public/bundle` is built once and held in memory until the next write (or 60 s for writes made by other processes). It is served with a strong `ETag`, `Cache-Control: public, max-age=60, stale-while-revalidate=600` and answers `If-None-Match` with 304.
- Every content, settings or media-metadata write also POSTs `{ "tags": ["cms"] }` to `${SITE_URL}/api/revalidate` with `x-revalidate-secret`. The POST is debounced (500 ms) and fire-and-forget; failures are only logged. If `SITE_URL` is unset, nothing is sent.

## Layout

```
src/
  index.ts            boot + graceful shutdown
  app.ts              createApp(): middleware + routers (no listen)
  db.ts               connectDb()/disconnectDb(), memory server support
  config/env.ts       zod-validated environment
  types.ts            mirror of lib/cms/types.ts
  lib/                errors, logger, slug, sanitize, csv, pagination, activity, revalidate, public-cache, content-events, bootstrap
  middleware/         auth, validate, sanitize, rate-limit, error-handler
  models/             Mongoose models (content collections, settings, users, sessions, enquiries, activity, media)
  schemas/            zod schemas (content create/update + defaults, settings)
  modules/            auth, content (generic router + registry), settings, enquiries, users, activity, dashboard, public, system
  routes/admin.ts     /api/admin composition (auth, roles, mount points)
  scripts/            create-admin (seed and smoke scripts live here too)
```

## Deploying

Production runs on the VPS from a git clone of this repo at `/var/www/srsit-api`, as the pm2 app `srsit-api` on `127.0.0.1:4100`, behind nginx at `https://fahimstack.tech/srsit-api` (`/etc/nginx/snippets/srsit-api.conf`). The server's `.env` lives only there (git ignores it).

To ship a change: push to `main`, then on the VPS

```sh
cd /var/www/srsit-api && ./deploy.sh
```

`deploy.sh` pulls, installs, compiles `dist/`, drops dev dependencies and restarts pm2, then waits for `/api/health`. If you change `.env`, run `pm2 restart srsit-api --update-env`.
