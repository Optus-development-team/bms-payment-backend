import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initializing?: Promise<void>;

  private readonly selectors = {
    loginLogo: '#LogoInicialEconet',
    userInput: '#usuario',
    passwordInput: '#password',
    loginButton: '#btn_ingresar',
    twoFaInput: '#txtClaveTrans',
    continueButton: 'button:has-text("Continuar")',
    modal: '#modalMensaje',
    modalAccept: 'button:has-text("Aceptar")',
    qrOrigin: '#Cuenta_Origen',
    qrDestiny: '#Cuenta_Destino',
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
  }

  async generateQr(amount: number, details: string): Promise<string> {
    const page = await this.ensureSession();
    await this.navigate(page, this.generateQrUrl);
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
    await page.locator(this.selectors.qrUniqueCheckbox).check({ force: true });
    await page.click(this.selectors.qrGenerateButton);
    await page.waitForTimeout(5000);

    const downloadPromise = page.waitForEvent('download');
    await page.locator(this.selectors.qrDownloadButton).click();
    const download = await downloadPromise;
    return this.downloadToBase64(download);
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

    return glosaValue.includes('BM QR') && glosaValue.includes(details);
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

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(45000);
    return this.page;
  }

  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.context) {
      return;
    }

    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      this.logger.log('Launching new headless browser instance.');
      const launchOptions = await this.buildLaunchOptions();
      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext();
    })();

    await this.initializing;
    this.initializing = undefined;
  }

  private isServerlessEnvironment(): boolean {
    return Boolean(
      process.env.VERCEL ??
        process.env.AWS_REGION ??
        process.env.LAMBDA_TASK_ROOT ??
        process.env.CHROME_EXECUTABLE_PATH,
    );
  }

  private async buildLaunchOptions(): Promise<LaunchOptions> {
    if (!this.isServerlessEnvironment()) {
      return { headless: true };
    }

    const manualExecutable = process.env.CHROME_EXECUTABLE_PATH;
    const executablePath =
      manualExecutable ?? (await chromiumLambda.executablePath());

    if (!executablePath) {
      throw new Error(
        'Chromium executable path is not available in serverless mode.',
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
    const modalVisible = await this.isVisible(
      page.locator(this.selectors.modal),
      1000,
    );

    if (!modalVisible) {
      return;
    }

    await page.locator(this.selectors.modalAccept).click();
    await page.waitForLoadState('networkidle');
  }

  private async navigate(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'networkidle' });
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

  private async downloadToBase64(download: Download): Promise<string> {
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

    return Buffer.concat(chunks).toString('base64');
  }

  private getEnvOrThrow(key: string): string {
    const value = this.configService.get<string>(key);

    if (!value) {
      throw new Error(`${key} is not configured.`);
    }

    return value;
  }
}
