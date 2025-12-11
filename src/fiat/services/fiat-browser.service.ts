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
    announcementModal: '#modalAnuncio',
    announcementCloseIcon: '#modalAnuncio .fa.fa-close',
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
    await this.dismissAnnouncementModalIfPresent(page);
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
    await this.dismissAnnouncementModalIfPresent(page);
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
    await this.dismissAnnouncementModalIfPresent(page);
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
          'No se pudo iniciar el navegador. Instala @sparticuz/chromium como dependencia o define CHROME_EXECUTABLE_PATH.',
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
    const manualExecutable = process.env.CHROME_EXECUTABLE_PATH;
    if (manualExecutable) {
      return {
        headless: true,
        executablePath: manualExecutable,
      } satisfies LaunchOptions;
    }

    const executablePath = await chromiumLambda.executablePath();
    if (!executablePath) {
      throw new Error(
        'Chromium executable path is not available. Ensure @sparticuz/chromium is installed as a dependency or set CHROME_EXECUTABLE_PATH.',
      );
    }

    return {
      args: chromiumLambda.args,
      executablePath,
      headless: true,
      chromiumSandbox: false,
    } satisfies LaunchOptions;
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
    await this.dismissAnnouncementModalIfPresent(page);
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

  private async dismissAnnouncementModalIfPresent(page: Page): Promise<void> {
    const modal = page.locator(this.selectors.announcementModal);
    const isAnnouncementVisible = await this.isVisible(modal, 1000);

    if (!isAnnouncementVisible) {
      return;
    }

    this.logger.debug('Closing announcement modal before continuing.');

    try {
      await page
        .locator(this.selectors.announcementCloseIcon)
        .click({ timeout: 5000 });
    } catch (error) {
      this.logger.warn(
        `Failed to click announcement modal close icon: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    const hidden = await this.waitForHiddenAttribute(
      page,
      this.selectors.announcementModal,
    );

    if (!hidden) {
      this.logger.warn(
        'Announcement modal did not expose hidden="true" after closing attempt.',
      );
    } else {
      this.logger.debug('Announcement modal hidden attribute confirmed.');
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

  private async waitForHiddenAttribute(
    page: Page,
    selector: string,
    timeout = 5000,
  ): Promise<boolean> {
    try {
      await page.waitForFunction(
        (targetSelector) => {
          const element = document.querySelector(targetSelector);
          return element?.getAttribute('hidden') === 'true';
        },
        selector,
        { timeout },
      );
      return true;
    } catch (error) {
      this.logger.debug(
        `hidden attribute check failed for ${selector}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
