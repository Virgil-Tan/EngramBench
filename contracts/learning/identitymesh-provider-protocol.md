## Public policy supplement — identitymesh-provider-2026-09-08.1

This author-approved revision fills the previously unspecified local identity-provider wire protocol.
It is not the unchanged historical benchmark and is not a retroactive interpretation of old runs.
The complete original README and Manager requirements remain in force: password authentication,
single session/token-family issuance, durable idempotency, UNKNOWN reconciliation, device ownership,
revocation, secret-free audit and quarantine are not relaxed. The existing incoming login, callback
and reconcile operations and their exact request/response shapes do not change.

### Test accounts and authority

The local provider is a separate test service at `PROVIDER_BASE_URL`, never a real external provider.
Its explicit account table has rows `{tenantId,userId,username,password}`. The exact, case-sensitive
`(tenantId,username,password)` tuple authenticates to that row's `userId`; an unknown tuple fails.
Account rows must refer to existing same-tenant Users provisioned by a public seed or create-user
operation. Configuring the test provider does not create Users, Devices, Sessions or trust inside
IdentityMesh. No password spelling, username prefix or user ID encoding selects a test outcome.
The public example account is declared under `providerProtocol.accounts` in contract.json;
other tests configure their own explicit rows through the same public helper.

### Outbound login

IdentityMesh sends `POST /v1/login` relative to `PROVIDER_BASE_URL`, with JSON Content-Type and
`Idempotency-Key` exactly equal to the 1–128 visible-ASCII-character `providerRequestId` in the closed body:

`{providerRequestId,tenantId,deviceId,username,password}`.

IdentityMesh generates one opaque providerRequestId for a LoginAttempt and durably binds it before
contacting the provider. Incoming idempotent replay and concurrent retry keep that identity. The
provider returns HTTP 200 and the closed body `{providerRequestId,outcome,userId}`. `outcome` is
`SUCCEEDED`, `FAILED` or `UNKNOWN`; userId is the configured User UUID only for SUCCEEDED and null
otherwise. Invalid credentials produce FAILED, not an HTTP transport error. The response always
echoes the exact providerRequestId. Repeating an identical request returns the same provider record;
reusing that ID with any different body is HTTP 409 PROVIDER_REQUEST_CONFLICT. The provider never
echoes credentials. The service must validate the returned identity against the same tenant, User
and Device ownership and retain every original revocation and quarantine check.

### Unknown outcome and reconciliation

UNKNOWN, a lost/delayed response, or provider unavailability cannot issue tokens or imply FAILED.
Reconciliation sends `GET /v1/login-requests/:providerRequestId` with an encoded path segment and
no body or credentials. It returns the same HTTP 200 outcome shape for the original provider record.
A missing provider record returns HTTP 404 PROVIDER_REQUEST_NOT_FOUND; it is unresolved, not proof
of invalid credentials. The service keeps the original attempt unresolved and does not allocate a
replacement provider ID or a second LoginAttempt to bypass UNKNOWN. A caller replay of the original
idempotent login may resend the same request identity when the provider has no record; background
reconciliation needs only that identity and never stored credentials.

Provider truth may move from UNKNOWN to SUCCEEDED or FAILED. Terminal truth cannot be reversed.
The existing incoming reconcile operation and LOGIN_RECONCILIATION Work query this same record;
they converge with callbacks on at most one Session/token-family issuance and one terminal audit/event
transition. A new login blocked by an unresolved original attempt retains LOGIN_RESULT_UNKNOWN.

### Callbacks and test controls

Callbacks use the unchanged incoming `POST /api/v1/provider/callbacks` body
`{providerCallbackId,providerRequestId,outcome,userId,occurredAt}` and a durable Idempotency-Key.
The providerRequestId is obtained from the real outbound request or returned LoginAttempt, never
guessed. For SUCCEEDED, userId is the same configured mapping; otherwise it is null. The test sender
may deliver a notification repeatedly or deliver an earlier UNKNOWN notification after a terminal one.
Such delivery cannot change a terminal result, create another Session, or duplicate its audit/event.

The public `identitymesh-provider.mjs` helper hosts this protocol on loopback. It accepts an explicit
account table plus test-owned initial/reconciled outcome and response delay controls; these controls
are out-of-band configuration and are never extra fields on IdentityMesh's login request. It exposes
only secret-free observed request metadata, monotonic outcome resolution, and callback construction.
`registerAccounts(rows)` may extend the explicit out-of-band table after public Users are provisioned;
the same tenant/username may be registered again only with the identical userId and password mapping.
Credentials and raw provider assertions remain forbidden in service persistence, responses, snapshots,
events, audits and logs. This helper implements only the external test provider, not any IdentityMesh
business state, transaction, authentication-token algorithm, worker, or recovery logic.

Malformed provider wire uses HTTP 400 INVALID_PROVIDER_REQUEST, unsupported media uses HTTP 415
UNSUPPORTED_MEDIA_TYPE, and unpublished provider routes use HTTP 404 NOT_FOUND, each with the
closed `{error:{code,message,details:{}}}` envelope. These provider-side transport codes do not add
or replace IdentityMesh's published incoming semantic errors.
