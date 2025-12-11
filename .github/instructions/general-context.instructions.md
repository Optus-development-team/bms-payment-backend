# SYSTEM CONTEXT: BMS_PAYMENT_BACKEND (Automation Worker)

## 1. System Overview
- **Role:** NestJS 11 microservice dedicated to Ecofuturo bank automation (QR generation and payment verification) and x402 cryptocurrency payments on Avalanche Fuji. It runs stand-alone so risky browser automation does not impact other services.
- **Runtime:** Node 18+, NestJS HTTP server (Express adapter). Vercel serverless handler (`api/index.ts`) reuses the same module/bootstrap logic used locally.
- **Key Libraries:** `playwright-core` for automation, `@sparticuz/chromium` for serverless Chromium binaries, `axios` for outbound webhooks, `class-validator` + `class-transformer` for DTO coercion, `viem` for blockchain interactions, and custom in-memory `JobQueueService` implementations (no Redis).
- **Global Config:** `configureApp` enables validation pipes, Swagger UI under `/docs`, and the `x-internal-api-key` and `X-PAYMENT` security schemes for privileged endpoints.
- **Statefulness:** `FiatBrowserService` owns a single Playwright browser/context/page. `X402PaymentService` maintains in-memory payment jobs. All jobs share these resources to preserve authenticated cookies and payment state.

## 2. Application Modules

### 2.1 HTTP/API Layer
	- `/generate-qr` and `/verify-payment` accept background jobs (202 Accepted responses) with DTOs that normalize snakeCase/camelCase payloads.
	- `/generate-hybrid-payment` creates payment jobs supporting both fiat QR and x402 crypto payment methods.
	- `/set-2fa` stores temporary 2FA tokens and requires the `x-internal-api-key` header to match `INTERNAL_API_KEY`.
	- `GET /pay` handles both QR (fiat) and crypto in a single flow: without `X-PAYMENT` returns HTTP 402 with available methods; with `X-PAYMENT` verifies/settles and emits `X-PAYMENT-RESPONSE`.
	- `GET /pay/:orderId/status` returns the payment status for observability.
	- `POST /pay/:orderId/confirm` (secured with `x-internal-api-key`) allows manual confirmation when crypto requires it.
	- `/supported` lists supported networks and tokens.
	- `/health` checks facilitator wallet balance.
	- `GET /pay` handles both QR (fiat) and crypto in a single flow: without `X-PAYMENT` returns HTTP 402 with available methods; with `X-PAYMENT` verifies/settles and emits `X-PAYMENT-RESPONSE`.
	- `GET /pay/:orderId/status` returns the payment status for observability.
	- `POST /pay/:orderId/confirm` (secured with `x-internal-api-key`) allows manual confirmation when crypto requires it.
	- `/supported` lists supported networks and tokens.
	- `/health` checks facilitator wallet balance.
- `SwaggerModule` documents every route and is reused both locally and on Vercel through `configureApp`.

### 2.2 Fiat Job Orchestration
- `FiatService` receives controller DTOs and pushes work into `JobQueueService`.
- `JobQueueService` keeps an in-memory promise chain (`tail: Promise<void>`) to guarantee **exactly one** Playwright job runs at a time. There is no Redis/worker pool; concurrency safety depends on the singleton Nest process (or single Vercel lambda instance).
- `FiatAutomationService` executes the actual automation work and reports outcomes through `WebhookService`. It wraps failures to detect the `TwoFactorRequiredError` so alerts can be sent upstream.

### 2.3 x402 Payment Module
- **X402Module** provides cryptocurrency payment processing using the HTTP 402 Payment Required protocol on Avalanche Fuji testnet.
- **Network Configuration:**
	- Chain ID: 43113 (Avalanche Fuji Testnet)
	- RPC: `https://api.avax-test.network/ext/bc/C/rpc`
	- USDC Token: `0x5425890298aed601595a70AB815c96711a31Bc65` (6 decimals)
	- Block Explorer: `https://testnet.snowtrace.io`
- **Services:**
	- `X402FacilitatorService`: Verifies EIP-712 signatures and settles payments on-chain using EIP-3009 `transferWithAuthorization`. The facilitator pays gas fees.
	- `X402PaymentService`: Manages payment lifecycle with in-memory job storage. Supports manual confirmation flow before final settlement.
	- `X402WebhookService`: Sends payment events to `${OPTUSBMS_BACKEND_URL}/webhook/x402/result`.
	- `X402JobQueueService`: Sequential job processing similar to fiat queue.
	1. Client calls `GET /api/pay` without `X-PAYMENT` → server returns HTTP 402 body with crypto accept + fiat QR option **only if QR generation finishes within 30s**.
	2. Client retries `GET /api/pay` with `X-PAYMENT` header (crypto payload or fiat payload).
	3. Crypto path: facilitator verifies and settles EIP-712/EIP-3009, optionally awaiting manual confirmation.
	4. Fiat path: Playwright verification checks glosa; only one payment method is honored per order.
	5. Server returns `X-PAYMENT-RESPONSE` header describing settlement result.

### 2.4 Playwright Automation (`FiatBrowserService`)
- Always launches the bundled `@sparticuz/chromium` binary (even locally) to avoid OS-level dependencies; `CHROME_EXECUTABLE_PATH` can override the executable path when necessary. Sandbox disabled.
- Maintains one `Browser`, `BrowserContext`, and `Page`. `ensurePage` lazily creates them and reuses across commands; `onModuleDestroy` closes the browser.
- Navigation helpers (`navigate`, `logPageInfo`, `logElementState`, `clickIfVisible`) are heavily logged to aid troubleshooting when running remotely.
- Saves downloaded QR PNGs to `QR_OUTPUT_DIR` (defaults to `tmp/qr-tests`). Files are persisted best-effort and independently of webhook delivery.

### 2.5 Two-Factor Handling (`TwoFaStoreService`)
- Small in-memory holder seeded from optional env `2FACODE`.
- `setCode` updates the current token; `consumeCode` returns the code once and clears it. `hasCode` is used to decide if automation may proceed.
- Consumption happens during login; if no code is available, `FiatBrowserService` throws `TwoFactorRequiredError` so `FiatAutomationService` can emit a webhook and stop the job cleanly.

### 2.6 Webhook Dispatch (`WebhookService`)
- Posts to `${OPTUSBMS_BACKEND_URL}/webhook/payments/result` using Axios with a 10s timeout.
- Emits three event types:
	- `QR_GENERATED` with `{ qr_image_base64 }` payload.
	- `VERIFICATION_RESULT` with `{ success: boolean }`.
	- `LOGIN_2FA_REQUIRED` when automation is blocked waiting for a token.
- If `OPTUSBMS_BACKEND_URL` is undefined, the service logs a warning and skips the call (no retries/backoff built in).

### 2.7 Serverless Entry Point
- `api/index.ts` caches the initialized Nest adapter so Vercel requests reuse the same in-memory state (including the queued jobs and browser session) while the lambda instance is warm.
- `vercel.json` routes every path (including `/docs` and `/v1/*`) to that handler, and bumps the function limits to 2 GB / 120 s.

## 3. Automation Flows

### 3.1 `ensureSession()` (FiatBrowserService)
1. Call `ensurePage()` to get/create the shared Playwright `Page` and `BrowserContext`.
2. Navigate to `INDEX_PAGE` (defaults to `${ECONET_URL}/Inicio/Index`).
3. Inspect `#LogoInicialEconet`:
	 - **Not visible:** already authenticated; return.
	 - **Visible:** run the login flow:
		 1. Fill `#usuario` with `ECONET_USER` and `#txtPassword` with `ECONET_PASS`.
		 2. Click `#btn_ingresar` and wait for `networkidle`.
		 3. If `#txtClaveTrans` appears, fetch a code:
				- No stored code -> throw `TwoFactorRequiredError`.
				- Code available -> fill, click the button labeled "Continuar", wait for `networkidle`, and log success.
		 4. Dismiss informational modals if either `#modalMensaje` or `#modalMensajeDecision` is visible by clicking their accept/continue buttons.

### 3.2 Job `GENERATE_QR`
1. Run `ensureSession()`.
2. Try to open `GENERATE_QR_PAGE` (defaults to `${ECONET_URL}/Transferencia/QRGenerar`). If the form is not visible, fall back to guided navigation via the "Simple QR" menu and `#btn_gotoGenerarQR`.
3. Assert `#Cuenta_Origen` and `#Cuenta_Destino` are visible (fail fast otherwise).
4. Fill `#glosa` with `details`, `#monto` with the decimal `amount`, and force-check `#pagoUnico`.
5. Click `#GenerarQR`, wait 5 seconds (bank rendering quirk), then wait for a `download` event triggered by clicking `a[download="QR.png"]`.
6. Convert the downloaded PNG to Base64, persist a copy under `QR_OUTPUT_DIR`, and call `WebhookService.sendQrGenerated(orderId, base64)`.

### 3.3 Job `VERIFY_PAYMENT`
1. Run `ensureSession()`.
2. Navigate to `INDEX_PAGE`.
3. Click the latest movement button `[data-id="mov-1"]` and wait for the modal `#cotenidoComprobante`.
4. Extract the `<td>` sibling inside the row containing text `Glosa`.
5. Consider the payment successful when the glosa includes both the literal `BM QR` and the `details` string.
6. Emit `WebhookService.sendVerificationResult(orderId, success)` with the boolean outcome.

## 4. API Contracts

### 4.1 Inbound (called by the Optus backend or orchestration layer)
- `POST /v1/fiat/generate-qr`
	- Body: `{ order_id | orderId, amount: number, details | glosa | details }`.
	- Response: `{ "status": "accepted" }` (HTTP 202). The actual QR is delivered asynchronously via webhook.
- `POST /v1/fiat/verify-payment`
	- Body: `{ order_id | orderId, details | glosa }`.
	- Response: `{ "status": "accepted" }` (HTTP 202). Result arrives via webhook.
- `POST /v1/fiat/set-2fa`
	- Headers: `x-internal-api-key` must equal `INTERNAL_API_KEY`.
	- Body: `{ "code": "123456" }` (alphanumeric, 4-12 chars).
	- Response: `{ "status": "updated", "message": "Retry the job now" }` (HTTP 200). The code is stored in-memory and consumed on the next login attempt.

### 4.2 x402 Payment API (Inbound)
- `GET /api/pay`
 	- Query: `orderId`, `amountUsd`, optional `description`, `resource`, `fiatAmount`, `currency`, `symbol`, `requiresManualConfirmation`.
 	- No `X-PAYMENT` header → returns HTTP 402 JSON body `{ x402Version, resource, accepts, error, jobId }` with crypto option and fiat QR option **only if the QR is generated within 30s**.
 	- With `X-PAYMENT` header (base64 payload): processes crypto (EIP-712 exact) or fiat payloads; responds `200 OK` with `X-PAYMENT-RESPONSE` header containing `{ success, type, transaction, network?, payer?, currency?, errorReason }`.
 	- Only one payment method may be completed per order; attempting a different method returns 402.

- `GET /api/health`
 	- Response: `{ status, facilitatorAddress, usdcBalance, network }`.

### 4.3 x402 Webhooks (Outbound)
- URL: `${OPTUSBMS_BACKEND_URL}/webhook/x402/result`
- Events:
	1. `X402_PAYMENT_REQUIRED`: Payment job created, awaiting client payment.
	2. `X402_PAYMENT_VERIFIED`: EIP-712 signature verified successfully.
	3. `X402_PAYMENT_SETTLED`: On-chain transfer completed.
	4. `X402_PAYMENT_CONFIRMED`: Manual confirmation received and settled.
	5. `X402_PAYMENT_FAILED`: Payment processing failed.
	6. `X402_PAYMENT_EXPIRED`: Payment timed out.
- Payload structure: `{ type, jobId, orderId, data: { amount?, transactionHash?, error?, blockExplorerUrl? }, timestamp }`.

### 4.4 Outbound (webhooks delivered by this service)
- URL: `${OPTUSBMS_BACKEND_URL.replace(/\/$/, '')}/webhook/payments/result`
- Payloads:
	1. `QR_GENERATED`: `{ "type": "QR_GENERATED", "order_id": "...", "data": { "qr_image_base64": "..." } }`
	2. `VERIFICATION_RESULT`: `{ "type": "VERIFICATION_RESULT", "order_id": "...", "data": { "success": true|false } }`
	3. `LOGIN_2FA_REQUIRED`: `{ "type": "LOGIN_2FA_REQUIRED", "data": { "message": "Bank is asking for Token/SMS code.", "timestamp": ISOString } }`

## 5. Environment Configuration

| Variable | Purpose |
| --- | --- |
| `ECONET_URL` | Base Ecofuturo URL (default `https://econet.bancoecofuturo.com.bo:447/EconetWeb`). |
| `INDEX_PAGE` | Override for the landing page (`${ECONET_URL}/Inicio/Index`). |
| `GENERATE_QR_PAGE` | Override for the QR form (`${ECONET_URL}/Transferencia/QRGenerar`). |
| `QR_OUTPUT_DIR` | Directory for saving QR PNG files locally (`tmp/qr-tests`). |
| `ECONET_USER` / `ECONET_PASS` | Bank credentials required for login. |
| `OPTUSBMS_BACKEND_URL` | Base URL for webhook delivery. Mandatory for outbound updates. |
| `INTERNAL_API_KEY` | Shared secret required by `/set-2fa`. |
| `2FACODE` | Optional seed token for `TwoFaStoreService`. Usually empty in production and supplied via API when needed. |
| `CHROME_EXECUTABLE_PATH` | Optional manual override for Chromium binary in serverless environments. |
| `X402_FACILITATOR_PRIVATE_KEY` | **Required for x402.** Private key of the facilitator wallet that executes `transferWithAuthorization`. Must have AVAX for gas. |
| `X402_PAY_TO_ADDRESS` | **Required for x402.** Destination address for USDC payments. |
| `X402_PAYMENT_TIMEOUT_MS` | Optional. Payment expiration time in milliseconds (default: 300000 = 5 minutes). |

## 6. Operational Notes
- **Concurrency:** The in-memory queue guarantees sequential execution only within the same Node process. If you scale horizontally, ensure only one instance runs or introduce a distributed lock/queue.
- **2FA Lifecycle:** When `LOGIN_2FA_REQUIRED` fires, upstream systems must call `/set-2fa` with the new token and then retry the blocked job.
- **Error Logging:** Unexpected automation errors are logged via Nest's `Logger` but only 2FA blocks trigger webhooks.
- **Local Testing:** Playwright downloads are saved under `tmp/qr-tests`, and Swagger docs are available at `/docs`. Run `npm run start:dev` for local dev or `vercel dev` for serverless parity.
- **x402 Payments:** The facilitator wallet must have sufficient AVAX on Fuji testnet for gas fees. Use the `/api/health` endpoint to check balance. Payments are processed sequentially via the job queue.
- **Manual Confirmation:** When `requireManualConfirmation: true`, payments pause after verification until `/confirm` is called. This allows human review before on-chain settlement.

