import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, readRequestUser } from '../auth';
import { DomainException } from '../common/errors';
import { StorageService, type SignUploadInput } from './storage.service';

@Controller('v1/storage')
@UseGuards(AuthGuard)
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('uploads/sign')
  async signUpload(@Req() req: Request, @Body() body: SignUploadInput) {
    const user = readRequestUser(req)!;

    if (!body.kind || !body.mime || !body.size) {
      throw DomainException.badRequest('storage.missing_field');
    }

    if (!this.storage.validateMime(body.mime)) {
      throw DomainException.badRequest('storage.invalid_mime');
    }

    if (!this.storage.validateSize(body.size)) {
      throw DomainException.badRequest('storage.invalid_size');
    }

    return this.storage.signUpload(user.id, body);
  }
}
