import type { Response } from 'express';

export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replay';

/**
 * Marks whether this particular call changed anything.
 *
 * `false` on the call that created the reservation or performed the release,
 * `true` on every repeat of it. Both reserve and release are idempotent, so a
 * repeat returns the same body as the original; without this header a client
 * (or a reviewer clicking twice in Swagger) cannot tell an accepted retry
 * from a first-time success.
 *
 * Why a header and not a body field: the body is the representation of the
 * reservation and must be identical no matter who asks for it or how many
 * times. Whether *this call* was a replay is a fact about the call, not about
 * the reservation, so it belongs in the response metadata.
 *
 * Why it is always present rather than only on replays: absence would be
 * indistinguishable from an old build or a stripping proxy, and the whole
 * point is that the difference is visible.
 */
export function setIdempotentReplay(res: Response, replay: boolean): void {
  res.setHeader(IDEMPOTENT_REPLAY_HEADER, replay ? 'true' : 'false');
}

/** Swagger description of the header, attached to the affected responses. */
export const IDEMPOTENT_REPLAY_HEADER_DOC = {
  [IDEMPOTENT_REPLAY_HEADER]: {
    description:
      'false when this call created the reservation or performed the release; ' +
      'true when it repeated an operation that had already happened.',
    schema: { type: 'string', enum: ['true', 'false'] },
  },
};
