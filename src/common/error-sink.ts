/**
 * Where the exception filter reports unhandled server errors. The filter is created without dependency injection, so the monitoring
 * module registers its recorder here when the application starts. With nothing registered (unit tests, scripts) reporting does nothing.
 */
export interface ServerErrorReport {
  method: string;
  /** The route template (`/api/v1/products/:id`), never the URL with real ids and never the query string. */
  route: string;
  status: number;
  error: unknown;
  requestId: string | null;
}

type Sink = (report: ServerErrorReport) => Promise<void>;
let sink: Sink | undefined;

export const setErrorSink = (next: Sink | undefined): void => {
  sink = next;
};

/** Returns a promise to wait for (so a serverless function is not frozen before the write), or undefined when nothing is registered. */
export const reportServerError = (
  report: ServerErrorReport,
): Promise<void> | undefined => sink?.(report);
