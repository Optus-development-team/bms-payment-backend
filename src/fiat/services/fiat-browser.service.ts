import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  Browser,
  BrowserContext,
  Download,
  LaunchOptions,
  Locator,
  Page,
  chromium,
} from 'playwright-core';
import chromiumLambda from '@sparticuz/chromium';
import { TwoFaStoreService } from './two-fa-store.service';
import { TwoFactorRequiredError } from '../errors/two-factor-required.error';

@Injectable()
export class FiatBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(FiatBrowserService.name);
  private readonly indexUrl: string;
  private readonly generateQrUrl: string;
  private readonly qrOutputDir: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initializing?: Promise<void>;

  private readonly selectors = {
    loginLogo: '#LogoInicialEconet',
    userInput: 'input#usuario',
    passwordInput: 'input#txtPassword',
    loginButton: '#btn_ingresar',
    twoFaInput: '#txtClaveTrans',
    continueButton: 'button:has-text("Continuar")',
    modal: '#modalMensaje',
    modalAcceptButton: '#modalMensaje .modal-footer .btn.btn-primary',
    decisionModal: '#modalMensajeDecision',
    decisionModalAcceptButton: '#botonOpcionAceptada',
    qrOrigin: '#Cuenta_Origen',
    qrDestiny: '#Cuenta_Destino',
    simpleQrButton: 'a.dropdown-btn.menu:has-text("Simple QR")',
    gotoGenerateQrButton: '#btn_gotoGenerarQR',
    qrDetails: '#glosa',
    qrAmount: '#monto',
    qrUniqueCheckbox: '#pagoUnico',
    qrGenerateButton: '#GenerarQR',
    qrDownloadButton: 'a[download="QR.png"]:has-text("Descargar QR")',
    lastMovementButton: '[data-id="mov-1"]',
    comprobanteModal: '#cotenidoComprobante',
    glosaRow: 'tr:has-text("Glosa")',
  } as const;

  constructor(
    private readonly configService: ConfigService,
    private readonly twoFaStoreService: TwoFaStoreService,
  ) {
    const baseUrl =
      this.configService.get<string>('ECONET_URL') ??
      'https://econet.bancoecofuturo.com.bo:447/EconetWeb';
    this.indexUrl =
      this.configService.get<string>('INDEX_PAGE') ?? `${baseUrl}/Inicio/Index`;
    this.generateQrUrl =
      this.configService.get<string>('GENERATE_QR_PAGE') ??
      `${baseUrl}/Transferencia/QRGenerar`;
    this.qrOutputDir =
      this.configService.get<string>('QR_OUTPUT_DIR') ??
      path.join(process.cwd(), 'tmp', 'qr-tests');
  }

  async generateQr(amount: number, details: string): Promise<string> {
    const page = await this.ensureSession();
    await this.openGenerateQrPage(page);
    await this.logPageInfo(page, 'Generate QR');
    await this.logElementState(page, 'Cuenta_Origen', this.selectors.qrOrigin);
    await this.logElementState(
      page,
      'Cuenta_Destino',
      this.selectors.qrDestiny,
    );
    await this.assertVisible(
      page.locator(this.selectors.qrOrigin),
      'Cuenta_Origen',
    );
    await this.assertVisible(
      page.locator(this.selectors.qrDestiny),
      'Cuenta_Destino',
    );

    await page.fill(this.selectors.qrDetails, details);
    await page.fill(this.selectors.qrAmount, amount.toString());
    this.logger.debug(
      `Filled QR form with details='${details}' amount='${amount}'.`,
    );
    await page.locator(this.selectors.qrUniqueCheckbox).check({ force: true });
    await page.click(this.selectors.qrGenerateButton);
    await page.waitForTimeout(5000);

    const downloadPromise = page.waitForEvent('download');
    await page.locator(this.selectors.qrDownloadButton).click();
    const download = await downloadPromise;
    return this.downloadToBase64(download, details);
  }

  async verifyPayment(details: string): Promise<boolean> {
    const page = await this.ensureSession();
    await this.navigate(page, this.indexUrl);

    const movementButton = page.locator(this.selectors.lastMovementButton);
    await movementButton.waitFor({ state: 'visible', timeout: 15000 });
    await movementButton.click();

    const comprobanteModal = page.locator(this.selectors.comprobanteModal);
    await comprobanteModal.waitFor({ state: 'visible', timeout: 15000 });

    const glosaRow = comprobanteModal.locator(this.selectors.glosaRow);
    await glosaRow.waitFor({ state: 'visible', timeout: 10000 });
    const glosaValue = (await glosaRow.locator('td').last().innerText()).trim();
    const matched =
      glosaValue.includes('BM QR') && glosaValue.includes(details);
    if (matched) {
      this.logger.log(
        `Payment verified for details='${details}'. Glosa='${glosaValue}'.`,
      );
    } else {
      this.logger.warn(
        `Payment not found for details='${details}'. Latest glosa='${glosaValue}'.`,
      );
    }

    return matched;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  private async ensureSession(): Promise<Page> {
    const page = await this.ensurePage();
    await this.navigate(page, this.indexUrl);
    const loginVisible = await this.isVisible(
      page.locator(this.selectors.loginLogo),
    );

    if (loginVisible) {
      await this.runLoginFlow(page);
    }

    return page;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    await this.ensureBrowser();
    if (!this.context) {
      throw new Error('Browser context is not available.');
    }

    try {
      this.page = await this.context.newPage();
    } catch (error) {
      this.logger.warn(
        `Recreando navegador por fallo al abrir página: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.resetBrowserState();
      await this.ensureBrowser();
      if (!this.context) {
        throw new Error('Browser context is not available after relaunch.');
      }
      this.page = await this.context.newPage();
    }

    this.page.setDefaultTimeout(45000);
    return this.page;
  }

  private async ensureBrowser(): Promise<void> {
    if (this.isBrowserActive()) {
      return;
    }

    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      try {
        this.logger.log('Launching new headless browser instance.');
        const launchOptions = await this.buildLaunchOptions();
        this.browser = await chromium.launch(launchOptions);
        this.context = await this.browser.newContext();
      } catch (error) {
        this.resetBrowserState();
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to launch Chromium: ${reason}`);
        throw new Error(
          'No se pudo iniciar el navegador. Revisa las dependencias del sistema o define CHROME_EXECUTABLE_PATH.',
        );
      }
    })();

    await this.initializing;
    this.initializing = undefined;
  }

  private isBrowserActive(): boolean {
    if (!this.browser || !this.context) {
      return false;
    }

    return this.browser.isConnected();
  }

  private resetBrowserState(): void {
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  private async buildLaunchOptions(): Promise<LaunchOptions> {
    // In serverless (Vercel/Lambda) use @sparticuz/chromium; locally rely on Playwright downloads.
    if (!this.isServerlessEnvironment()) {
      const localExecutable = await this.findLocalChromiumExecutable();
      if (localExecutable) {
        return {
          headless: true,
          executablePath: localExecutable,
        } satisfies LaunchOptions;
      }

      return { headless: true } satisfies LaunchOptions;
    }

    const manualExecutable = process.env.CHROME_EXECUTABLE_PATH;
    const executablePath =
      manualExecutable ?? (await chromiumLambda.executablePath());

    if (!executablePath) {
      throw new Error(
        'Chromium executable path is not available. Ensure @sparticuz/chromium is installed or set CHROME_EXECUTABLE_PATH.',
      );
    }

    return {
      args: chromiumLambda.args,
      executablePath,
      headless: true,
      chromiumSandbox: false,
    } satisfies LaunchOptions;
  }

  private isServerlessEnvironment(): boolean {
    return Boolean(
      process.env.VERCEL ??
        process.env.AWS_REGION ??
        process.env.LAMBDA_TASK_ROOT ??
        process.env.CHROME_EXECUTABLE_PATH,
    );
  }

  private async findLocalChromiumExecutable(): Promise<string | null> {
    const cacheDir = path.join(
      process.env.HOME ?? process.cwd(),
      '.cache',
      'ms-playwright',
    );
    const candidates = await this.findLatestBrowserPath(cacheDir, [
      {
        folderPrefix: 'chromium_headless_shell-',
        executable: path.join(
          'chrome-headless-shell-linux64',
          'chrome-headless-shell',
        ),
      },
      {
        folderPrefix: 'chromium-',
        executable: path.join('chrome-linux', 'chrome'),
      },
    ]);

    if (!candidates) {
      return null;
    }

    return candidates;
  }

  private async findLatestBrowserPath(
    baseDir: string,
    patterns: { folderPrefix: string; executable: string }[],
  ): Promise<string | null> {
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      const matches: { version: number; fullPath: string }[] = [];

      for (const pattern of patterns) {
        for (const entry of entries) {
          if (
            !entry.isDirectory() ||
            !entry.name.startsWith(pattern.folderPrefix)
          ) {
            continue;
          }

          const versionStr = entry.name.slice(pattern.folderPrefix.length);
          const version = Number.parseInt(versionStr, 10);
          if (Number.isNaN(version)) {
            continue;
          }

          matches.push({
            version,
            fullPath: path.join(baseDir, entry.name, pattern.executable),
          });
        }
      }

      if (!matches.length) {
        return null;
      }

      matches.sort((a, b) => b.version - a.version);
      return matches[0]?.fullPath ?? null;
    } catch {
      return null;
    }
  }

  private async runLoginFlow(page: Page): Promise<void> {
    const user = this.getEnvOrThrow('ECONET_USER');
    const password = this.getEnvOrThrow('ECONET_PASS');

    this.logger.log('Executing login flow for Econet.');
    await page.fill(this.selectors.userInput, user);
    await page.fill(this.selectors.passwordInput, password);
    await page.click(this.selectors.loginButton);
    await page.waitForLoadState('networkidle');

    await this.handleTwoFactor(page);
    await this.dismissModalIfPresent(page);
  }

  private async handleTwoFactor(page: Page): Promise<void> {
    const needsTwoFa = await this.isVisible(
      page.locator(this.selectors.twoFaInput),
      2000,
    );

    if (!needsTwoFa) {
      return;
    }

    if (!this.twoFaStoreService.hasCode()) {
      throw new TwoFactorRequiredError();
    }

    const code = this.twoFaStoreService.consumeCode();
    if (!code) {
      throw new TwoFactorRequiredError();
    }

    await page.fill(this.selectors.twoFaInput, code);
    await page.locator(this.selectors.continueButton).click();
    await page.waitForLoadState('networkidle');
    this.logger.log('2FA token submitted successfully.');
  }

  private async dismissModalIfPresent(page: Page): Promise<void> {
    const modal = page.locator(this.selectors.modal);
    const decisionModal = page.locator(this.selectors.decisionModal);

    if (await this.isVisible(modal, 1000)) {
      await page.locator(this.selectors.modalAcceptButton).click();
      await page.waitForLoadState('networkidle');
    }

    if (await this.isVisible(decisionModal, 1000)) {
      await page.locator(this.selectors.decisionModalAcceptButton).click();
      await page.waitForLoadState('networkidle');
    }
  }

  private async navigate(page: Page, url: string): Promise<void> {
    this.logger.debug(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle' });
    await this.logPageInfo(page, `After navigation to ${url}`);
  }

  private async assertVisible(locator: Locator, name: string): Promise<void> {
    try {
      await locator.waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${name} element is not visible. ${reason}`);
    }
  }

  private async isVisible(locator: Locator, timeout = 1500): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch {
      return false;
    }
  }

  private async downloadToBase64(
    download: Download,
    details: string,
  ): Promise<string> {
    const stream = await download.createReadStream();

    if (!stream) {
      throw new Error('Unable to read QR download stream.');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const normalized = Buffer.isBuffer(chunk)
        ? Buffer.from(chunk)
        : Buffer.from(chunk, 'utf8');
      chunks.push(normalized);
    }

    stream.destroy();

    const buffer = Buffer.concat(chunks);
    await this.persistQrImage(buffer, details);
    return buffer.toString('base64');
  }

  private async persistQrImage(buffer: Buffer, details: string): Promise<void> {
    try {
      await fs.mkdir(this.qrOutputDir, { recursive: true });
      const safeDetails = this.sanitizeFilenamePart(details);
      const filename = `qr-${safeDetails}-${Date.now()}.png`;
      const filePath = path.join(this.qrOutputDir, filename);
      await fs.writeFile(filePath, buffer);
      this.logger.log(`QR saved locally at ${filePath}`);
    } catch (error) {
      this.logger.warn(
        `Failed to persist QR image: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private sanitizeFilenamePart(value: string): string {
    if (!value) {
      return 'qr';
    }

    return value.replace(/[^a-z0-9-_]/gi, '_').slice(0, 40) || 'qr';
  }

  private getEnvOrThrow(key: string): string {
    const value = this.configService.get<string>(key);

    if (!value) {
      throw new Error(`${key} is not configured.`);
    }

    return value;
  }

  private async openGenerateQrPage(page: Page): Promise<void> {
    await this.navigate(page, this.generateQrUrl);
    const detailsVisible = await this.isVisible(
      page.locator(this.selectors.qrDetails),
      5000,
    );

    if (detailsVisible) {
      return;
    }

    this.logger.warn(
      'QR form not visible after direct navigation. Trying guided navigation.',
    );

    await this.navigate(page, this.indexUrl);
    const simpleQrClicked = await this.clickIfVisible(
      page.locator(this.selectors.simpleQrButton),
      'Simple QR button',
    );

    if (!simpleQrClicked) {
      await this.clickIfVisible(
        page.locator('text=Simple QR'),
        'Simple QR text fallback',
      );
    }

    await this.clickIfVisible(
      page.locator(this.selectors.gotoGenerateQrButton),
      'Go to Generate QR button',
    );

    try {
      await page.waitForURL('**/Transferencia/QRGenerar', { timeout: 15000 });
    } catch (error) {
      this.logger.warn(
        `Timed out waiting for QR generator URL: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async logPageInfo(page: Page, context: string): Promise<void> {
    try {
      const url = page.url();
      const title = await page.title();
      this.logger.debug(`[${context}] URL=${url} | Title=${title}`);
    } catch (error) {
      this.logger.debug(
        `[${context}] Unable to retrieve page info: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async logElementState(
    page: Page,
    description: string,
    selector: string,
  ): Promise<void> {
    const locator = page.locator(selector);
    const count = await locator.count();
    let visible = false;

    if (count > 0) {
      try {
        visible = await locator.first().isVisible();
      } catch (error) {
        this.logger.debug(
          `[${description}] visibility check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.debug(
      `[${description}] selector=${selector} count=${count} visible=${visible}`,
    );
  }

  private async clickIfVisible(
    locator: Locator,
    description: string,
    timeout = 5000,
  ): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      await locator.click();
      this.logger.debug(`Clicked ${description}.`);
      return true;
    } catch (error) {
      this.logger.debug(
        `Unable to click ${description}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
