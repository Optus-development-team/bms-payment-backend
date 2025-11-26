import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FiatModule } from './fiat/fiat.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), FiatModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
