import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FiatModule } from './fiat/fiat.module';
import { X402Module } from './x402/x402.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), FiatModule, X402Module],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
