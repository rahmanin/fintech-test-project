import { ApiProperty } from '@nestjs/swagger';

export class TokenResponseDto {
  @ApiProperty({ description: 'JWT (HS256) to send as `Authorization: Bearer <token>`' })
  accessToken!: string;

  @ApiProperty({ example: '1h' })
  expiresIn!: string;
}
