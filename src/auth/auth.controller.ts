import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { TokenRequestDto } from './dto/token-request.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { Public } from './public.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Public by necessity: this is the endpoint that issues tokens. */
  @Public()
  @Post('token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange client credentials for a bearer token' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid client credentials' })
  token(@Body() body: TokenRequestDto): Promise<TokenResponseDto> {
    return this.auth.issueToken(body.clientId, body.clientSecret);
  }
}
