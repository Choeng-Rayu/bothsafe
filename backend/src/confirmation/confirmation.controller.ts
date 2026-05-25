import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth';
import { ConfirmationService } from './confirmation.service';

@Controller('v1/deals')
export class ConfirmationController {
  constructor(private readonly confirmationService: ConfirmationService) {}

  @UseGuards(AuthGuard)
  @Post(':publicId/confirm-received')
  @HttpCode(HttpStatus.OK)
  async confirmReceived(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = idempotencyKey ?? `${user.id}:${publicId}:confirm`;
    return this.confirmationService.confirmReceived(publicId, user.id, key);
  }
}
