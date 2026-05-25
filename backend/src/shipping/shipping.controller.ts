import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, CurrentUser, type AuthenticatedUser } from '../auth';
import { ShippingService, type SubmitShippingProofInput } from './shipping.service';

@Controller('v1/deals')
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @UseGuards(AuthGuard)
  @Post(':publicId/shipping-proofs')
  @HttpCode(HttpStatus.CREATED)
  async submitProof(
    @Param('publicId') publicId: string,
    @Body() body: SubmitShippingProofInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.shippingService.submitProof(publicId, user.id, body);
  }
}
