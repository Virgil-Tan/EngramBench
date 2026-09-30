# IdentityMesh

Build IdentityMesh from this intentionally blank repository. This README is the complete public product
contract. Ask before making a product choice that the contract does not settle.

## Required stack and commands

- Node.js 22, TypeScript, React, PostgreSQL 16, npm, and the preinstalled Chromium.
- PostgreSQL is the sole authority for identities, sessions, device trust, signing keys, revocations,
  durable idempotency, leases, audit records, and ordering.
- The production UI must use the public HTTP API; browser storage is not authoritative.

Required non-interactive commands:

```text
npm run db:migrate
npm run db:seed -- --file <path>
npm run dev
npm run build
npm run start:api
npm run start:worker
npm run start:dispatcher
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:recovery
npm run test:all
npm run test:perf
```

Every command must be non-interactive, exit non-zero on failure, and clean up child processes.

## Product boundary

IdentityMesh is a tenant-scoped identity lifecycle service. It provides password login through a local
identity-provider test double, rotating refresh sessions, device trust, signing-key rotation, immediate
revocation propagation, and an append-only audit chain. It is not an authorization policy engine and does
not implement application RBAC/ABAC; those are separate concerns.

The local provider double can return successful login, invalid credentials, delayed response, duplicate
callback, reordered callback, or unknown response. Tests must not call a real identity provider.

## Canonical objects and states

```text
Tenant, User, LoginAttempt, Session, RefreshToken, Device,
DeviceTrust, SigningKey, Revocation, ProviderCallback, AuditEntry,
AuditCheckpoint, OutboxEvent, Work
```

```text
LoginAttempt: STARTED -> SUCCEEDED | FAILED | UNKNOWN
Session: ACTIVE -> ROTATING -> ACTIVE | REVOKED | EXPIRED
DeviceTrust: PENDING -> TRUSTED -> SUSPENDED | REVOKED
SigningKey: GENERATED -> ACTIVE -> RETIRING -> RETIRED
Revocation: REQUESTED -> PROPAGATING -> PROPAGATED
```

### Exact public shapes

`uuid` is lowercase RFC 4122 text, `timestamp` is UTC ISO-8601 with millisecond precision and `Z`, and
`sha256` is 64 lowercase hex. Unlisted object fields are rejected.

```text
LoginAttempt = {loginAttemptId:uuid,tenantId:uuid,deviceId:uuid,providerRequestId:string,state:STARTED|SUCCEEDED|FAILED|UNKNOWN,userId:uuid|null,sessionId:uuid|null,createdAt:timestamp,resolvedAt:timestamp|null,sequence:int}
Session = {sessionId:uuid,tenantId:uuid,userId:uuid,deviceId:uuid,tokenFamilyId:uuid,state:ACTIVE|ROTATING|REVOKED|EXPIRED,refreshGeneration:int,requiredRevocationVersion:int,createdAt:timestamp,expiresAt:timestamp,revokedAt:timestamp|null,sequence:int}
Device = {deviceId:uuid,tenantId:uuid,userId:uuid,publicKeyFingerprint:sha256,state:PENDING|TRUSTED|SUSPENDED|REVOKED,trustRevision:int,createdAt:timestamp,terminalAt:timestamp|null}
DeviceChallenge = {challengeId:uuid,deviceId:uuid,userId:uuid,nonceDigest:sha256,state:PENDING|USED|EXPIRED,expiresAt:timestamp,usedAt:timestamp|null}
SigningKey = {keyId:uuid,tenantId:uuid,publicJwk:json,publicKeyFingerprint:sha256,state:GENERATED|ACTIVE|RETIRING|RETIRED,activatedAt:timestamp|null,retireAt:timestamp|null,retiredAt:timestamp|null,sequence:int}
Revocation = {revocationId:uuid,tenantId:uuid,subjectType:SESSION|DEVICE|USER|TENANT,subjectId:uuid,version:int,state:REQUESTED|PROPAGATING|PROPAGATED,createdAt:timestamp,propagatedAt:timestamp|null}
AuditEntry = {entryId:uuid,tenantId:uuid,sequence:int,eventType:string,actorRef:string,subjectRef:string,occurredAt:timestamp,payloadDigest:sha256,priorDigest:sha256|null,digest:sha256}
```

## Authentication contract

1. A successful login creates one Session and one initial RefreshToken family. Credentials and raw provider
   assertions are never persisted or returned.
2. Refresh-token rotation is single-use. A reused prior token revokes the complete token family and all
   sessions derived from that family; it cannot create a new session.
3. An `UNKNOWN` provider result is not treated as a failed login and cannot be retried as a new login until
   the original attempt is reconciled.
4. Session expiry uses database time. Access-token verification uses the current active signing key and
   accepts a retiring key only for tokens issued before its retirement boundary.
5. Every mutation requires a durable `Idempotency-Key` scoped by method and canonical path.

## Device trust contract

1. A Device is identified by a stable device public key fingerprint, never by an opaque browser cookie.
2. Trust approval is bound to one user, tenant, device fingerprint, challenge nonce, and expiry.
3. A challenge nonce is single-use and expires; replay or cross-user use has no durable effect.
4. Device revocation immediately invalidates derived sessions and queued refresh work.
5. Device trust state is independent from application authorization roles.

## Signing-key rotation contract

1. Only one SigningKey is ACTIVE for issuing new access tokens.
2. Rotation creates a new key, atomically marks it ACTIVE, and moves the prior key to RETIRING.
3. A retiring key remains verifiable only until its published retirement boundary and maximum token TTL.
4. Private key material is never exposed by API, snapshot, logs, or audit payloads; snapshots contain only
   public JWK metadata and fingerprints.
5. Repeated or concurrent rotation requests converge on one key generation and one ordered audit event.

## Revocation propagation contract

1. Revocation is append-only and scoped to a token family, session, device, user, or tenant.
2. The effective revocation version is monotonic. A stale cache or delayed propagation message may never
   re-enable a revoked subject.
3. Every verifier checks the locally available revocation version and fails closed when its version is older
   than the required security fence.
4. Duplicate and reordered propagation messages are safe and preserve the same revocation identity.
5. A revoked session cannot refresh, a revoked device cannot approve a challenge, and a revoked user cannot
   create a new session.

## Audit-chain contract

1. Every security-relevant transition creates exactly one immutable AuditEntry in the same transaction as
   the business state change.
2. Each entry contains `entryId`, `tenantId`, `sequence`, `eventType`, `actorRef`, `subjectRef`, `occurredAt`,
   `payloadDigest`, and `priorDigest`; the digest chain is per tenant.
3. Payloads contain no secrets, tokens, private keys, raw credentials, or provider assertions.
4. A checkpoint records the latest sequence and digest. Verification must detect deletion, insertion,
   reordering, or payload mutation.
5. Audit delivery is at-least-once, but repeated delivery keeps the same entry identity and body.

## Public HTTP surface

```text
POST /api/v1/tenants
POST /api/v1/users
POST /api/v1/login-attempts
POST /api/v1/provider/callbacks
POST /api/v1/login-attempts/:attemptId/reconcile
POST /api/v1/sessions/:sessionId/refresh
POST /api/v1/sessions/:sessionId/revoke
GET  /api/v1/sessions

POST /api/v1/devices/register
POST /api/v1/devices/:deviceId/challenges
POST /api/v1/device-challenges/:challengeId/approve
POST /api/v1/devices/:deviceId/revoke

POST /api/v1/signing-keys/rotate
GET  /api/v1/signing-keys/jwks
POST /api/v1/revocations
GET  /api/v1/audit/verify
GET  /api/v1/audit?limit&cursor
GET  /api/v1/verification-snapshot
```

Serve `GET /openapi.json` and `GET /healthz`. JSON errors use
`{"error":{"code":"STABLE_CODE","message":"...","details":{}}}`. Reject unknown fields,
unsupported media types, malformed timestamps, invalid UUIDs, and unsafe ranges. Collections use
`{items,nextCursor}` with stable opaque cursors.

Published semantic errors are exhaustive for well-formed requests:

```text
409 LOGIN_RESULT_UNKNOWN
409 REFRESH_TOKEN_REUSED
409 DEVICE_CHALLENGE_INVALID
409 SUBJECT_REVOKED
409 REVOCATION_FENCE_STALE
409 ACTIVE_KEY_CHANGED
409 SIGNING_KEY_RETIRED
409 IDEMPOTENCY_CONFLICT
400 INVALID_AUTH_REQUEST
400 INVALID_REQUEST
```

Durable Work has exact shape
`{workId:uuid,kind:LOGIN_RECONCILIATION|REVOCATION_PROPAGATION|KEY_RETIREMENT|AUDIT_DELIVERY,aggregateId:uuid,state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED,terminal:boolean,attempt:int,leaseOwner:string|null,leaseExpiresAt:timestamp|null}`.
Workers fence their final commit. Required event types are `login.succeeded`, `login.failed`,
`session.refreshed`, `session.revoked`, `device.trusted`, `device.revoked`, `key.rotated`, and
`revocation.propagated`. Event and AuditEntry identity/body remain stable across retry.

## Seed and snapshot

The seed is exactly:

```json
{"schemaVersion":1,"seedVersion":"...","importedAt":"...","tenants":[],"users":[],"devices":[],"sessions":[],"signingKeys":[],"revocations":[],"auditEntries":[],"auditCheckpoints":[]}
```

Import is atomic. Replaying the same version and digest is a no-op; the same version with a different digest
returns `SEED_VERSION_CONFLICT`. The verification snapshot is point-in-time and exposes public key metadata,
subjects, revocation versions, Work, and audit entries without credentials, tokens, assertions, private keys,
or private paths.
The V1 `resources` object contains exactly `tenants`, `users`, `loginAttempts`, `sessions`, `devices`,
`deviceChallenges`, `signingKeys`, `revocations`, `auditEntries`, and `auditCheckpoints`; every array is
complete and deterministically sorted by its published ID or tenant sequence.

## Out of scope

Application RBAC/ABAC, social-login product UX, real external identity providers, hardware security modules,
biometric storage, password recovery policy, SCIM provisioning, and authorization decisions for downstream
business services.

## Successful response contracts

Successful response contracts are closed:

- A mutation route without a literally stated success status returns 200.
- Unless a route literally publishes another object, array, or empty body, a success described by a named resource, named resource state, or named resource fields returns that exact resource shape at the JSON top level. Any response-only fields literally named by the route are additional top-level fields.
- If a mutation publishes no success body, it returns the exact current shape of the single primary resource created or changed by that route at the JSON top level.
- When a route explicitly returns multiple named resources, the body is one object keyed by their lower-camel resource names unless the route publishes another literal shape.
- Wrappers such as `{data:...}`, `{result:...}`, or an extra single-resource envelope are invalid unless the route literally declares them. OpenAPI must publish the same success status and closed response schema as runtime.
