// OPTIONAL, REPLACEABLE starter transport. Only the external contract is fixed.
// It does not implement any product workflow or persistence.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { matchOperation, validator, openApi } from "./runtime.mjs";
import * as implementation from "../dist/implementation.js";

const contract = JSON.parse(await readFile(new URL("./contract.json", import.meta.url)));
const extensions = implementation.publicExtensions ?? [];
if (!Array.isArray(extensions)) throw new Error("publicExtensions must be an operation array");
for (const operation of extensions) {
  if (!operation.id || !operation.path?.startsWith("/") || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(operation.method)) throw new Error("Invalid public extension operation");
  const existing = contract.operations.find((op) => op.id === operation.id || (op.method === operation.method && op.path === operation.path));
  if (existing) {
    // Complete unspecified shapes/metadata, never replace a published contract.
    if (existing.id !== operation.id || existing.method !== operation.method || existing.path !== operation.path) throw new Error("A public extension cannot replace a published route");
    for (const [key, value] of Object.entries(operation)) {
      if (existing[key] !== undefined && JSON.stringify(existing[key]) !== JSON.stringify(value)) throw new Error(`A public extension cannot change published ${key}`);
      if (!['id', 'method', 'path', 'request', 'response', 'parameters', 'errors'].includes(key)) throw new Error(`Unsupported public extension metadata: ${key}`);
      existing[key] = value;
    }
  } else contract.operations.push(operation);
}
const api = openApi(contract);
const compile = validator(contract);
const requests = new Map(contract.operations.filter((op) => op.request).map((op) => [op.id, compile(op.request)]));
const responses = new Map(contract.operations.filter((op) => op.response).map((op) => [op.id, compile(op.response)]));
const server = createServer(async (request, response) => {
  const send = (status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(typeof body === "string" && String(headers["content-type"]).startsWith("text/") ? body : JSON.stringify(body));
  };
  const error = (status, code, message, details = {}) => send(status,
    code === "MALFORMED_JSON" && contract.wireErrors?.malformedCodeOnly
      ? { error: { code } } : { error: { code, message, details } });
  try {
    const url = new URL(request.url, "http://localhost");
    const route = matchOperation(contract.operations, request.method, url.pathname);
    if (!route) return error(404, contract.wireErrors?.notFound ?? "NOT_FOUND", "No published route matches this request");
    const { operation, params } = route;
    if (operation.path === "/openapi.json") return send(200, api);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    let body;
    if (bytes.length) {
      if (operation.request?.contentMediaType === "application/octet-stream") body = bytes.toString("latin1");
      else {
        try { body = JSON.parse(bytes.toString("utf8")); }
        catch { return error(400, "MALFORMED_JSON", "Body is not valid JSON"); }
      }
    }
    const validate = requests.get(operation.id);
    if (validate && !validate(body)) return error(400, contract.wireErrors?.validation ?? "INVALID_REQUEST", "Body does not match the published request schema", { violations: validate.errors });
    const result = await implementation.execute(operation.id, { params, query: Object.fromEntries(url.searchParams), body, bytes, headers: request.headers });
    const status = result.status ?? operation.status ?? 200;
    if (status >= 200 && status < 300 && status !== (operation.status ?? 200)) return error(500, "RESPONSE_CONTRACT_VIOLATION", "Implementation returned a nonconforming success status");
    const validateResponse = responses.get(operation.id);
    if (status >= 200 && status < 300 && validateResponse && !validateResponse(result.body)) {
      return error(500, "RESPONSE_CONTRACT_VIOLATION", "Implementation returned a nonconforming success body", { violations: validateResponse.errors });
    }
    send(status, result.body, { ...(operation.path === "/" && { "content-type": "text/html; charset=utf-8" }), ...result.headers });
  } catch (failure) {
    const domainError = Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599 && typeof failure.code === "string";
    error(domainError ? failure.status : 500, domainError ? failure.code : "INTERNAL_ERROR", domainError ? failure.message : "Unhandled implementation error");
  }
});
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => {
  if (process.send) process.send({ kind: "public-api-listening", port: server.address().port });
});
