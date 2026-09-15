import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class TokenRequestDto {
  @ApiProperty({ example: 'demo-client' })
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @ApiProperty({ example: 'demo-client-secret-change-me' })
  @IsString()
  @IsNotEmpty()
  clientSecret!: string;
}
