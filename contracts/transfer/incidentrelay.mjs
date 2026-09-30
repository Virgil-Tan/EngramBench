import { ref, obj, arr, one, nil, str, text, bool, int, count, positive, range, uuid, time, en, page, id, T, auth, key, q, paging, commands, environmentVariables, op, commonSchemas, snapshot, seedSchema, infra, observe, basicSmoke, seedSmoke, commonNotes, manager } from '../learning/helpers-a2.mjs';

const httpUrl = { type: 'string', pattern: '^https?://[^/@?#\\s]+(?::[0-9]+)?(?:/[^#\\s]*)?$' };
const severity = en('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
const legacyPolicyStep = obj({ stepIndex: int, delaySeconds: int, responderId: uuid });
const groupPolicyStep = obj({ stepIndex: int, delaySeconds: int, responderIds: arr(uuid), quorumRequired: int });
const policy = steps => obj({ policyId: uuid, version: positive, steps: arr(steps), expireAfterSeconds: int });
const acknowledgement = obj({ acknowledgementId: uuid, incidentId: uuid, stepIndex: int, responderId: uuid, acknowledgedAt: time });
const incident = obj({ incidentId: uuid, serviceId: uuid, dedupKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$' }, severity, title: str, details: str, state: en('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'EXPIRED'), policyId: uuid, policyVersion: positive, createdAt: time, expiresAt: time, nextEscalationAt: nil(time), acknowledgedBy: nil(uuid), acknowledgedAt: nil(time), resolvedAt: nil(time), sequence: positive });
const finalIncident = obj({ ...incident.properties, acknowledgementStepIndex: nil(int), acknowledgements: arr(ref('IncidentAcknowledgement')) });
const notification = obj({ notificationId: uuid, incidentId: uuid, stepIndex: int, responderId: uuid, deliveryUrl: httpUrl, body: obj({ notificationId: uuid, incidentId: uuid, serviceId: uuid, stepIndex: int, responderId: uuid, severity, title: str, details: str }), state: en('PENDING', 'DELIVERED', 'SUPERSEDED'), attemptCount: count, nextAttemptAt: nil(time), successfulDeliveryAt: nil(time) });
const resources = { services: 'Service', responders: 'Responder', escalationPolicies: 'EscalationPolicy', incidents: 'Incident', escalationSteps: 'EscalationStep', notificationDeliveries: 'NotificationDelivery', groupEscalationSteps: 'GroupEscalationStep', incidentAcknowledgements: 'IncidentAcknowledgement' };
const schemas = {
  ...commonSchemas(['ESCALATION_STEP', 'INCIDENT_EXPIRY'], ['incident.opened', 'escalation.sent', 'incident.acknowledged', 'incident.resolved', 'incident.expired']),
  Service: obj({ serviceId: uuid, name: str, currentPolicyId: uuid, currentPolicyVersion: positive }),
  Responder: obj({ responderId: uuid, name: str, deliveryUrl: httpUrl }),
  LegacyEscalationPolicy: policy(legacyPolicyStep), EscalationPolicy: { anyOf: [policy(legacyPolicyStep), policy(groupPolicyStep)] },
  LegacyIncident: incident, Incident: finalIncident, IncidentReply: one(ref('LegacyIncident'), ref('Incident')),
  EscalationStep: obj({ incidentId: uuid, stepIndex: int, responderId: uuid, dueAt: time, state: en('PENDING', 'SENT', 'SUPERSEDED'), notificationId: uuid, successfulDeliveryAt: nil(time) }),
  NotificationDelivery: notification, IncidentAcknowledgement: acknowledgement,
  GroupEscalationStep: obj({ incidentId: uuid, stepIndex: int, responderIds: arr(uuid), quorumRequired: int, dueAt: time, state: en('PENDING', 'SENT', 'SUPERSEDED'), notifications: arr(ref('NotificationDelivery')), successfulDeliveryAt: nil(time) }),
  TimelineItem: obj({ sequence: positive, type: str, occurredAt: time, actorId: nil(uuid), data: ref('JsonValue') }),
  VerificationSnapshot: snapshot(resources),
};
schemas.Error.properties.error.properties.code = en('UNSUPPORTED_MEDIA_TYPE', 'MALFORMED_JSON', 'UNKNOWN_FIELD', 'INVALID_REQUEST', 'INVALID_CURSOR', 'NOT_FOUND', 'ADMIN_AUTH_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'INCIDENT_DEDUP_CONFLICT', 'INCIDENT_ALREADY_ACKNOWLEDGED', 'INCIDENT_NOT_ACKNOWLEDGEABLE', 'INCIDENT_NOT_RESOLVABLE', 'ESCALATION_POLICY_VERSION_CHANGED', 'INVALID_ESCALATION_POLICY', 'RESPONDER_NOT_IN_ACTIVE_QUORUM', 'INVALID_QUORUM_POLICY', 'INTERNAL_ERROR', 'RESPONSE_CONTRACT_VIOLATION', 'NOT_IMPLEMENTED');
const service = { serviceId: id(101), name: 'Public response service', currentPolicyId: id(102), currentPolicyVersion: 1 };
const responder = { responderId: id(103), name: 'Public responder', deliveryUrl: 'http://127.0.0.1:4011/notifications' };
const policyExample = { policyId: id(102), version: 1, steps: [{ stepIndex: 0, delaySeconds: 86400, responderId: id(103) }], expireAfterSeconds: 172800 };
const alert = { serviceId: id(101), dedupKey: 'public-new-incident', severity: 'LOW', title: 'Public alert', details: 'Public independent write-read example' };
const seedResources = { services: 'Service', responders: 'Responder', escalationPolicies: 'LegacyEscalationPolicy', incidents: 'LegacyIncident', escalationSteps: 'EscalationStep', notificationDeliveries: 'NotificationDelivery' };
const policyBody = step => obj({ expectedCurrentVersion: nil(positive), steps: arr(step), expireAfterSeconds: int });
const errors = Object.fromEntries([400, 401, 404, 409, 415, 500].map(status => [status, ref('Error')]));
const operations = [
  ...infra(), ...observe(),
  op('list-incidents', 'GET', '/api/v1/incidents', 200, page(ref('Incident')), undefined, { query: { limit: 50 } }, { parameters: paging }),
  op('get-incident', 'GET', '/api/v1/incidents/:incidentId', 200, ref('Incident'), undefined, { params: { incidentId: id(110) } }),
  op('create-incident', 'POST', '/api/v1/incidents', 201, ref('IncidentReply'), obj({ serviceId: uuid, dedupKey: incident.properties.dedupKey, severity, title: str, details: str }), { body: alert }),
  op('acknowledge-incident', 'POST', '/api/v1/incidents/:incidentId/acknowledge', 200, ref('IncidentReply'), obj({ responderId: uuid }), { params: { incidentId: id(110) }, body: { responderId: id(103) } }),
  op('resolve-incident', 'POST', '/api/v1/incidents/:incidentId/resolve', 200, ref('IncidentReply'), obj({ responderId: uuid, resolution: str }), { params: { incidentId: id(110) }, body: { responderId: id(103), resolution: 'Service restored' } }),
  op('create-policy', 'POST', '/api/v1/services/:serviceId/escalation-policies', 200, ref('EscalationPolicy'), { anyOf: [policyBody(legacyPolicyStep), policyBody(groupPolicyStep)] }, { params: { serviceId: id(101) }, body: { expectedCurrentVersion: 1, steps: [{ stepIndex: 0, delaySeconds: 86400, responderIds: [id(103)], quorumRequired: 1 }], expireAfterSeconds: 172800 } }, { source: manager, transportErrors: { invalidRequest: { status: 400, code: 'INVALID_ESCALATION_POLICY' } } }),
  op('get-policy', 'GET', '/api/v1/services/:serviceId/escalation-policy', 200, ref('EscalationPolicy'), undefined, { params: { serviceId: id(101) } }),
  op('incident-timeline', 'GET', '/api/v1/incidents/:incidentId/timeline', 200, obj({ items: arr(ref('TimelineItem')) }), undefined, { params: { incidentId: id(110) } }),
  op('record-acknowledgement', 'POST', '/api/v1/incidents/:incidentId/acknowledgements', 200, obj({ incident: ref('Incident'), acknowledgement: ref('IncidentAcknowledgement'), replayed: bool }), obj({ stepIndex: int, responderId: uuid }), { params: { incidentId: id(110) }, body: { stepIndex: 0, responderId: id(103) } }, { source: manager }),
].map(operation => ({ ...operation, errors, ...(operation.id === 'production-ui' && { response: { type: 'string', contentMediaType: 'text/html' } }) }));

export default {
  taskId: 'incidentrelay', title: 'IncidentRelay', httpHost: '127.0.0.1', commands, environmentVariables,
  transportErrors: { auth: { status: 401, code: 'ADMIN_AUTH_REQUIRED' }, unknownField: { status: 400, code: 'UNKNOWN_FIELD' } },
  schemas, operations,
  seed: { command: ['npm', 'run', 'db:seed', '--', '--file', '${SEED_PATH}'], replay: true, schema: seedSchema(seedResources), example: { schemaVersion: 1, seedVersion: 'incidentrelay-public-v2-1', services: [service], responders: [responder], escalationPolicies: [policyExample], incidents: [], escalationSteps: [], notificationDeliveries: [] } },
  smoke: [...basicSmoke, seedSmoke({ services: [service], responders: [responder], escalationPolicies: [{ policyId: id(102), version: 1 }] }),
    { operationId: 'create-incident', body: alert, headers: key('incident-smoke'), expectStatus: 201, capture: { incidentId: ['incidentId'] } },
    { operationId: 'get-incident', params: { incidentId: '${incidentId}' }, expectStatus: 200, expectBody: { incidentId: '${incidentId}', ...alert, state: 'OPEN', policyVersion: 1 } },
    { operationId: 'verification-snapshot', headers: auth, expectStatus: 200, expectContains: [{ path: ['resources', 'incidents'], match: { incidentId: '${incidentId}', ...alert, state: 'OPEN' } }] }],
  notes: [...commonNotes,
    'V2 public wire clarification: GET incident timeline returns {items:[TimelineItem]} in sequence order, with no pagination query. New reads and mutations expose FINAL Incident fields, including nullable acknowledgementStepIndex and acknowledgements; the mutation response union also preserves exact saved V1 idempotency replies. No new response envelope or resolution field is added.',
    'V2 compatibility clarification: the V1 seed keeps legacy Incident and EscalationPolicy schemas only. FINAL reads accept both the immutable historical singular policy shape and Manager group policy shape, while migration exposes legacy targets as quorum-one groups. FINAL incidents include migrated acknowledgement records. FINAL snapshot retains all six original arrays and the two explicitly added arrays; no private Work/Event seed members exist.',
    'Policy list order, strictly increasing integer delays, distinct targets, quorum bounds, expiry, delivered-notification eligibility and business error codes are checked by the implementation. Integer/array wire shapes do not make an invalid policy legal: INVALID_ESCALATION_POLICY and INVALID_QUORUM_POLICY remain mandatory semantic errors.',
    'The public seed is a linked Service/Responder/immutable Policy graph. Its long first delay keeps the independent smoke incident OPEN during checks without depending on a notification receiver. The smoke does not validate notification delivery or recovery.',
  ],
};
