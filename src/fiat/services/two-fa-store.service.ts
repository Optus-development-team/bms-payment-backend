import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TwoFaStoreService {
  private code: string | null;

  constructor(private readonly configService: ConfigService) {
    const initialCode = this.configService.get<string>('2FACODE');
    this.code =
      initialCode && initialCode.trim().length > 0 ? initialCode.trim() : null;
  }

  setCode(code: string) {
    this.code = code.trim();
  }

  consumeCode(): string | null {
    const current = this.code;
    this.code = null;
    return current;
  }

  hasCode(): boolean {
    return !!this.code && this.code.trim().length > 0;
  }
}
