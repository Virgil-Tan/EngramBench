// V2 always consumes the published top-level wire; historical submission adapters are forbidden.
export function assertCompatibilityAdapter(id) {
  if (id !== undefined && id !== null) throw new TypeError('CapacityLease forbids compatibility adapters');
}
export function adaptCompatibilityResponse(id, response) {
  assertCompatibilityAdapter(id);
  return response.json;
}
