# Vercel Deployment Checklist

1. **Environment Variables (Vercel Project Settings > Environment Variables)**
   - `ECONET_URL`, `INDEX_PAGE`, `GENERATE_QR_PAGE`
   - `ECONET_USER`, `ECONET_PASS`
   - `OPTUSBMS_BACKEND_URL`, `INTERNAL_API_KEY`
   - Optional: `2FACODE` for seeding the in-memory token store

2. **Secrets / Sensitive Access**
   - Store 2FA codes via `/v1/fiat/set-2fa` only; do not persist in git or Vercel.

3. **Playwright / Chromium**
   - No `npx playwright install` required on Vercel thanks to `@sparticuz/chromium`.
   - Confirm `CHROME_EXECUTABLE_PATH` is unset so the Lambda helper resolves automatically.

4. **Vercel Limits & Settings**
   - Ensure project uses the included `vercel.json` (Node 20 runtime, 2 GB memory, 120s timeout).
   - Concurrency must stay at 1 job (already enforced via `JobQueueService`).

5. **Build & Output**
   - Vercel runs `npm install` then `npm run vercel-build`, which compiles Nest to `dist/`.
   - `api/index.ts` reuses `configureApp` so the same Swagger/docs config is available.

6. **Monitoring & Logs**
   - Use Vercel Logs to watch Playwright sessions.
   - Configure alerting/webhook on `LOGIN_2FA_REQUIRED` events in the optus backend.

7. **Local Verification Before Deploy**
   - `npm install`
   - `npm run lint`
   - `npm run build`
   - Optionally `vercel dev` to emulate the serverless handler locally.
