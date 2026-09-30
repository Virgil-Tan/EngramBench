// Public README error mappings; shared only where the original codes match.
const explicitAdminCodes = new Set([
  'artifactvault', 'auctionguard', 'evidencechain', 'exportvault', 'firmwarefleet',
  'ledgerbridge', 'mergeboard', 'queueforge', 'quotamesh', 'reconcilehub', 'schemaharbor',
]);
export function taskTransportErrors(taskId) {
  if (taskId === 'launchpass') return {
    invalidJson: { status: 400, code: 'INVALID_JSON' },
    invalidRequest: { status: 422, code: 'VALIDATION_ERROR' },
    unknownField: { status: 422, code: 'VALIDATION_ERROR' },
    unsupportedMediaType: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  };
  if (explicitAdminCodes.has(taskId)) return {
    auth: { status: 401, code: 'ADMIN_AUTH_REQUIRED' },
    unknownField: { status: 400, code: 'UNKNOWN_FIELD' },
    invalidRequest: { status: 400, code: 'INVALID_REQUEST' },
    invalidJson: { status: 400, code: 'MALFORMED_JSON' },
    unsupportedMediaType: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  };
  return {};
}
