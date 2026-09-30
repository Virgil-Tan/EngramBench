import type { IncomingHttpHeaders } from "node:http";

export type RequestContext = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  bytes: Buffer;
  headers: IncomingHttpHeaders;
};
export type Result = { status?: number; body: unknown; headers?: Record<string, string> };

// Optional additional production UI read endpoints. Include request/response
// schemas inline; the fixed router adds these to OpenAPI. For an existing ID /
// method / path, only previously unspecified schemas/query/header parameters and
// error metadata may be added. Published fields cannot be overridden. Additional
// endpoints or documentation do not reduce any README obligation.
export const publicExtensions: unknown[] = [];

// Optional starter entrypoint: replace the router and this interface if useful.
// Only the external HTTP/command contract is required, not this file or src/.
// Do not return fixture data or synthesize a successful snapshot.
export async function execute(operationId: string, context: RequestContext): Promise<Result> {
  void context;
  throw Object.assign(new Error(`Implement ${operationId} from README`), { status: 501, code: "NOT_IMPLEMENTED" });
}
