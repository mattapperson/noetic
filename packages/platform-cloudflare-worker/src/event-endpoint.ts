/**
 * An HTTP endpoint for events from outside (spec 25 § Cloudflare Workers, spec 35
 * § Events). A webhook is the host's business: this is only the last step, from a
 * request the host accepts to an event a source emits.
 *
 * The provider is answered once the event is stored. `source.emit()` resolves when
 * every listening trigger has the event in its inbox, so a `2xx` from here means
 * the event will be handled, and anything else tells the provider to send it again.
 */

//#region Types

/** @public Options for `eventEndpoint`. */
export interface EventEndpointOptions<E> {
  /** Where the event goes: a source's `emit`. Resolves once the event is stored. */
  emit: (event: E) => Promise<void>;
  /**
   * Decide whether the request is genuine, from the request and its raw body.
   * Without it every request is taken, which is right only behind something that
   * already checked.
   */
  verify?: (request: Request, body: string) => boolean | Promise<boolean>;
  /**
   * Turn the raw body into the event to emit. Return undefined for a delivery to
   * accept and ignore, such as a provider's ping. A throw answers `400`.
   */
  toEvent: (body: string, request: Request) => E | undefined | Promise<E | undefined>;
}

/** @public The statuses `eventEndpoint` answers with. */
export const EventEndpointStatus = {
  /** The event is stored. */
  Stored: 200,
  /** The delivery was accepted and carried no event. */
  Ignored: 204,
  /** `toEvent` could not read the body. */
  BadRequest: 400,
  /** `verify` refused the request. */
  Unauthorized: 401,
  MethodNotAllowed: 405,
  /** The event could not be stored; the provider should send it again. */
  NotStored: 503,
} as const;

/** @public */
export type EventEndpointStatus = (typeof EventEndpointStatus)[keyof typeof EventEndpointStatus];

//#endregion

//#region Helpers

function answer(status: EventEndpointStatus): Response {
  return new Response(null, {
    status,
  });
}

/** The event in `body`, `null` for none, or the status to refuse with. */
async function eventIn<E>(
  options: EventEndpointOptions<E>,
  request: Request,
  body: string,
): Promise<
  | {
      event: E | undefined;
    }
  | undefined
> {
  try {
    return {
      event: await options.toEvent(body, request),
    };
  } catch {
    return undefined;
  }
}

//#endregion

//#region Public API

/**
 * @public
 * A `fetch`-shaped handler that verifies a request, emits its event, and answers
 * once the event is stored.
 *
 * @example
 * ```ts
 * const receive = eventEndpoint({
 *   emit: (event) => mail.emit(event),
 *   verify: standardWebhookVerifier({ secret: env.WEBHOOK_SECRET }),
 *   toEvent: (body, request) => ({
 *     type: 'received',
 *     id: request.headers.get('webhook-id') ?? crypto.randomUUID(),
 *     payload: JSON.parse(body),
 *   }),
 * });
 * export default { fetch: (request) => receive(request) };
 * ```
 */
export function eventEndpoint<E>(
  options: EventEndpointOptions<E>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') {
      return answer(EventEndpointStatus.MethodNotAllowed);
    }
    const body = await request.text();
    if (options.verify && !(await options.verify(request, body))) {
      return answer(EventEndpointStatus.Unauthorized);
    }
    const read = await eventIn(options, request, body);
    if (!read) {
      return answer(EventEndpointStatus.BadRequest);
    }
    if (read.event === undefined) {
      return answer(EventEndpointStatus.Ignored);
    }
    try {
      await options.emit(read.event);
    } catch {
      return answer(EventEndpointStatus.NotStored);
    }
    return answer(EventEndpointStatus.Stored);
  };
}

//#endregion
