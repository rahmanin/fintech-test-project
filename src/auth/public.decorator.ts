import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt-out marker for the global JwtAuthGuard. Every route is protected by
 * default; only routes that cannot carry a token (the probe, the token
 * endpoint itself) are marked public.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
