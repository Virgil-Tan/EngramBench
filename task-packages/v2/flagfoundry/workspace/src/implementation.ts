import type { IncomingHttpHeaders } from "node:http";
import type { IncomingMessage } from "node:http";

export type RequestContext = {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  bytes?: Buffer;
  stream?: IncomingMessage;
  headers: IncomingHttpHeaders;
};
export type Result = { status?: number; body: unknown; headers?: Record<string, string> };

// Optional additional production UI read endpoints. Include request/response
// schemas inline; the fixed router adds these to OpenAPI. Existing operation IDs
// or method/path pairs may not be replaced. Additional
// endpoints or documentation do not reduce any README obligation.
export const publicExtensions: unknown[] = [];

// Optional exports: async start() and async stop(). The API process awaits start
// before listening and calls stop during termination. Use these for real DB pools
// and any README-required background lifecycle hosted by npm start (LaunchPass).
// Worker/dispatcher processes still dispatch through lifecycle.ts when required.

// Implement the complete README behind these operation IDs. Split into modules
// as needed. Do not return fixture data or synthesize a successful snapshot.
export async function execute(operationId: string, context: RequestContext): Promise<Result> {
  void context;
  throw Object.assign(new Error(`Implement ${operationId} from README`), { status: 501, code: "NOT_IMPLEMENTED" });
}
