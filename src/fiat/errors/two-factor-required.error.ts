export class TwoFactorRequiredError extends Error {
  constructor() {
    super('2FA code is required to complete the login process.');
  }
}
