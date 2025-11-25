# SYSTEM CONTEXT: BMS_PAYMENT_BACKEND (Automation Worker)

## 1. System Overview
**Role:** Isolated microservice for high-risk, high-resource automation tasks.
**Tech Stack:** NestJS, **Playwright** (Automation Engine), Web3/Ethers.js, Redis (Queue).
**Design Principle:** "Black Box" with **Session Persistence**. The system maintains a live browser session to minimize login frequency.

## 2. Core Modules

### A. Fiat Automation (Playwright Engine - Ecofuturo)
* **Target URL Base:** `https://econet.bancoecofuturo.com.bo:447/EconetWeb`
* **Session Strategy:** Singleton Browser Context. Cookies must be preserved.

#### Shared Logic: `ensureSession()`
Before every job, run this check:
1.  Navigate to `/Inicio/Index`.
2.  **Check Login State:** If element `#LogoInicialEconet` is **NOT** visible, session is valid. Proceed to Job.
3.  **If Login Required:**
    * Fill `#usuario` with `process.env.ECONET_USER`.
    * Fill `#password` with `process.env.ECONET_PASS`.
    * Click `#btn_ingresar`.
    * Wait for page load (`networkidle`).
    * **2FA Check:** Check visibility of `#txtClaveTrans`.
        * *Condition A:* If visible AND `process.env.2FACODE` is empty:
            * **Action:** Send Webhook `LOGIN_2FA_REQUIRED` to Main Backend.
            * **Result:** Fail current job (Gracefully) with reason "Waiting for 2FA".
        * *Condition B:* If visible AND `process.env.2FACODE` exists:
            * **Action:** Fill `#txtClaveTrans` -> Click button with text `Continuar`.
            * **Post-Action:** Clear `process.env.2FACODE` (to prevent reuse if OTP is one-time).
    * **Modal Check:** Wait for page load. If `#modalMensaje` is visible -> Click button with text `Aceptar`.

#### Job Type 1: `GENERATE_QR`
* **Trigger:** API call to `/v1/fiat/generate-qr`.
* **Input Data:** `amount`, `details` (mapped to Glosa).
* **Process:**
    1.  **Session:** Run `ensureSession()`.
    2.  **Navigation:** Go to `/Transferencia/QRGenerar`.
    3.  **Validation:** Verify elements `#Cuenta_Origen` and `#Cuenta_Destino` are visible.
    4.  **Form Filling:**
        * Fill `#glosa` with the `details` string.
        * Fill `#monto` with the `amount` number.
        * Check/Click checkbox `#pagoUnico`.
    5.  **Generation:** Click button `#GenerarQR`.
    6.  **Wait:** Explicit wait of 5 seconds (as per bank behavior).
    7.  **Download Handling:**
        * Setup Playwright Download Listener: `page.waitForEvent('download')`.
        * Click element with attribute `download="QR.png"` and text `Descargar QR`.
        * **Action:** Intercept the download stream, convert the file buffer to **Base64 String**.
    8.  **Output:** Send `QR_GENERATED` webhook with the Base64 image.

#### Job Type 2: `VERIFY_PAYMENT`
* **Trigger:** API call to `/v1/fiat/verify-payment`.
* **Input Data:** `details` (The unique code/gloss used in generation).
* **Process:**
    1.  **Session:** Run `ensureSession()`.
    2.  **Navigation:** Go to `/Inicio/Index`.
    3.  **Open Details:** Click the element with attribute `data-id="mov-1"` (Latest transaction).
    4.  **Scraping:**
        * Wait for modal `#cotenidoComprobante` to appear.
        * Locate the row containing text `Glosa`.
        * Extract the text content of the `<td>` within that row.
    5.  **Verification Logic:**
        * **Check 1:** Text must contain string `"BM QR"`.
        * **Check 2:** Text must contain the `details` string (unique order ID).
    6.  **Output:** * If both checks pass: Send `VERIFICATION_RESULT` (Success).
        * If checks fail: Send `VERIFICATION_RESULT` (Failed).

### B. Crypto Automation (USDT Watcher)
* **Purpose:** Monitor incoming USDT (TRC20) transactions.
* **Mechanism:** Polls Blockchain or listens to WebSocket events for a specific address.

## 3. Data Flow & Queueing (Redis)
* **Queue Name:** `bank_automation_queue`
* **Concurrency:** Strictly **1**.
* **Error Handling:**
    * **2FA Missing:** Logic defined in `ensureSession`. Main Backend receives webhook -> Asks Admin -> Admin replies -> Main Backend hits `/v1/fiat/set-2fa`.

## 4. API Interface Definition

### Inbound Endpoints (Consumed by Main Agent Server)

#### `POST /v1/fiat/generate-qr`
* **Request Body:** `{ "order_id": "...", "amount": 100, "details": "Order-123" }`
* **Response:** `202 Accepted`

#### `POST /v1/fiat/verify-payment`
* **Request Body:** `{ "order_id": "...", "details": "Order-123" }`
* **Response:** `202 Accepted`

#### `POST /v1/fiat/set-2fa` 
* **Purpose:** Receive the 2FA code provided by the Admin via WhatsApp to unblock the login process.
* **Auth:** `x-internal-api-key` required.
* **Request Body:**
    ```json
    {
      "code": "123456"
    }
    ```
* **Logic:** Updates the runtime `process.env.2FACODE` variable (or internal memory store) so the next job retry can succeed.
* **Response:** `200 OK` `{ "status": "updated", "message": "Retry the job now" }`

### Outbound Integrations (Callers)

#### `POST {OPTUSBMS_BACKEND_URL}/webhook/payments/result`

* **Payload Type A (QR Ready):**
    ```json
    { "type": "QR_GENERATED", "order_id": "...", "data": { "qr_image_base64": "..." } }
    ```

* **Payload Type B (Verification Result):**
    ```json
    { "type": "VERIFICATION_RESULT", "order_id": "...", "data": { "success": true } }
    ```

* **Payload Type C (Login 2FA Required):** <-- NEW PAYLOAD
    ```json
    {
      "type": "LOGIN_2FA_REQUIRED",
      "data": {
        "message": "Bank is asking for Token/SMS code.",
        "timestamp": "..."
      }
    }
    ```