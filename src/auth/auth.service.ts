import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EnvConfig } from '../config/env.validation';

/**
 * Client-credentials style token issuance against a single identity from env.
 *
 * Secrets are compared with crypto.timingSafeEqual on SHA-256 digests.
 * timingSafeEqual throws when the inputs differ in length, and comparing
 * lengths first would leak the secret's length through timing; hashing
 * makes both sides 32 bytes regardless of input.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly jwt: JwtService,
  ) {}

  async issueToken(
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; expiresIn: string }> {
    const idOk = safeEquals(clientId, this.config.get('API_CLIENT_ID', { infer: true }));
    const secretOk = safeEquals(
      clientSecret,
      this.config.get('API_CLIENT_SECRET', { infer: true }),
    );
    // Evaluate both before branching so a wrong id and a wrong secret take the same time.
    if (!(idOk && secretOk)) throw new UnauthorizedException('Invalid client credentials');

    const accessToken = await this.jwt.signAsync({ sub: clientId });
    return { accessToken, expiresIn: this.config.get('JWT_EXPIRES_IN', { infer: true }) };
  }
}

function safeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
