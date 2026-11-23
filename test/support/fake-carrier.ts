/**
 * A scriptable stand-in for a carrier's HTTP API, plugged into `CarrierHttp` as its `fetch`. Routes are matched by method and
 * path; each answer is either fixed or computed from the request, and a list of answers is used one after another (handy for
 * "401 first, then 200"). Every request is recorded so a test can check exactly what was sent.
 *
 * It proves OUR code against the shapes we wrote down from each carrier's documentation or experience. It cannot prove the
 * carrier: that needs the carrier's own sandbox.
 */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** The raw body as sent. */
  raw: string;
  /** The body parsed as JSON when it is JSON. */
  json: unknown;
  /** The body parsed as a form when it is `application/x-www-form-urlencoded`. */
  form: URLSearchParams | null;
}

export interface FakeAnswer {
  status?: number;
  body?: unknown;
  /** Send this text instead of JSON. */
  text?: string;
  /** Throw a network error instead of answering. */
  networkError?: boolean;
}

type Answer = FakeAnswer | ((req: FakeRequest) => FakeAnswer);
type Route = {
  method: string;
  path: string | RegExp;
  answers: Answer[];
  used: number;
};

export class FakeCarrier {
  readonly requests: FakeRequest[] = [];
  private readonly routes: Route[] = [];

  /** Register an answer (or a list of answers, used in turn; the last repeats). */
  on(
    method: 'GET' | 'POST',
    path: string | RegExp,
    answer: Answer | Answer[],
  ): this {
    this.routes.push({
      method,
      path,
      answers: Array.isArray(answer) ? answer : [answer],
      used: 0,
    });
    return this;
  }

  /** The requests that went to a path, in order. */
  to(path: string | RegExp): FakeRequest[] {
    return this.requests.filter((r) =>
      typeof path === 'string'
        ? r.url.pathname === path
        : path.test(r.url.pathname),
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    let json: unknown = null;
    let form: URLSearchParams | null = null;
    if ((headers.get('content-type') ?? '').includes('application/json')) {
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
    } else if (
      (headers.get('content-type') ?? '').includes('x-www-form-urlencoded')
    ) {
      form = new URLSearchParams(raw);
    }
    const req: FakeRequest = { method, url, headers, raw, json, form };
    this.requests.push(req);

    const route = this.routes.find(
      (r) =>
        r.method === method &&
        (typeof r.path === 'string'
          ? r.path === url.pathname
          : r.path.test(url.pathname)),
    );
    if (!route)
      return new Response(JSON.stringify({ message: 'no such route' }), {
        status: 404,
      });
    const pick = route.answers[Math.min(route.used, route.answers.length - 1)];
    route.used += 1;
    const answer = typeof pick === 'function' ? pick(req) : pick;
    if (answer.networkError) throw new TypeError('fetch failed');
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
