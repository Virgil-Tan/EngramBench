# ColdChainControl public policy and execution protocol

Policy revision: `coldchaincontrol-2026-09-08.1`.

These are new author-approved choices, not rules retroactively inferred from old
submissions. All arms receive this supplement. Original business requirements,
security invariants, workload sizes and performance thresholds remain unchanged.

## Site radius

Coordinates are integer degrees times 1,000,000. Use spherical Haversine distance
with Earth radius exactly 6,371,008.8 metres, clamping its intermediate to [0,1].
Quantize once to integer millimetres: floor(distanceMetres * 1000 + 0.5).
Membership is inclusive: distanceMillimetres <= radiusMeters * 1000.
Only Sites in the Shipment Tenant and frozen route are eligible. Select minimum
quantized distance, breaking ties by lexicographically smallest lowercase siteId.
Site membership never permits route regression, skipped custody or delivery with
unresolved temperature excursions.

## Notifications

Mandatory notification kinds for matching ACTIVE policies are EXCURSION_OPENED,
EXCURSION_RESOLVED, SHIPMENT_DELIVERED, SHIPMENT_CANCELLED, RECALL_ISSUED and
RECALL_CONTAINED. Their exact payload is {resourceType,resourceId,shipmentId,state}.
resourceType is Excursion, ColdShipment or RecallOrder, resourceId is its UUID and
state is the committed public state. shipmentId is the parent Shipment UUID for
Excursion, the Shipment UUID itself for ColdShipment, and null for RecallOrder.
Excursion/Shipment events use aggregateType ColdShipment and aggregateId shipmentId;
Recall events use aggregateType RecallOrder and aggregateId resourceId.
Other original mandatory Events remain required and may retain their public types.

Create exactly one logical Delivery per matching (notificationPolicyId,eventId)
atomically with the effect/Event. Normally use the frozen policy destination.
WEBHOOK_URL, when configured, overrides the transport destination for local tests;
it does not bypass policy matching or logical recipient identity.

POST the immutable Event without outboxState:
{eventId,tenantId,aggregateType,aggregateId,sequence,kind,occurredAt,payload}.
Use Content-Type application/json and X-ColdChain-Event-Id equal to eventId.
Canonical JSON sorts object keys recursively by JavaScript UTF-16 order, preserves
arrays, uses JSON.stringify without whitespace, then UTF-8. Freeze complete bytes
once; retries preserve eventId and exact bytes. Mutable delivery status/attempts
never enter the payload. Original secret/HMAC/attestation exclusions apply.

## Durable rate, retry and dead letter

At admission time the Tenant budget is the minimum positive rateLimitPerMinute
among its ACTIVE policies. No ACTIVE policies means no admission. A shared durable
sliding window counts ALL HTTP send admissions across policies/processes/retries
in (databaseNow-60 seconds,databaseNow]. Reserve admission before sending. A crash
after reservation may consume a slot. Quota deferral sends nothing and does not
increment attempts; retry no earlier than the oldest counted admission +60s.

HTTP 2xx acknowledges. Unknown ACK, connection failures and other statuses retry
the same Delivery, at most six admitted attempts. After failures 1..5, earliest
delays are 1,2,4,8,16 seconds from database attempt completion, subject also to
the shared quota. Failure six commits DEAD_LETTER with null nextAttemptAt and
deliveredAt. Success commits DELIVERED and database deliveredAt. Crashes cannot
fabricate ACK, allocate replacement event identities or forget reserved attempts.
Cancellation suppresses only unsent excursion notifications made inapplicable;
its own SHIPMENT_CANCELLED event and already-observed unknown ACK retries are not
discarded. Suppression is durable DEAD_LETTER with no extra HTTP attempt.

## Recovery barrier protocol

Enable only when TEST_BARRIER_URL and TEST_BARRIER_TOKEN are both nonempty. POST
to that exact URL with Content-Type application/json and X-Test-Barrier-Token
equal to TEST_BARRIER_TOKEN. Do not log/persist this token.

Worker body is closed: {role:"worker",point,kind,workId,aggregateId,attempt,leaseToken}.
IDs are UUIDs, attempt is the positive persisted claim ordinal, and leaseToken is
the nonempty opaque token for that claim. kind is the actual published Work kind.
- worker.claimed: after durable claim, before effect preparation.
- worker.before-commit: after preparation, immediately before the transaction
  that writes effects and completes/cancels Work.
- worker.after-attempt: after the guarded transaction has completed or rejected
  the attempt. This body additionally requires outcome, either committed or stale.
  A stale outcome means no business or Work write from that attempt. This receipt
  makes release of an obsolete owner observable without relying on arbitrary sleeps.

All three apply to CONFIG_DELIVER, TELEMETRY_PROJECT, DEVICE_OFFLINE_CHECK,
CUSTODY_HANDOFF_EXPIRY, RECALL_PROPAGATE and QUARANTINE_ENFORCE. A paused barrier
must not retain locks preventing reclaim, cancellation or supersession. Release
does not grant authority: revalidate database lease/token and domain authority in
the effect transaction. A stale released owner cannot write effects or Work state.

Dispatcher body is closed:
{role:"dispatcher",point:"dispatcher.response-received",notificationDeliveryId,eventId,attempt,responseStatus}.
IDs are UUIDs, attempt is positive, responseStatus is an integer 100..599. Call
after receiving the webhook response, before persisting ACK. Do not invent Work
for Delivery. Controller may hold, kill or release after a replacement completes.
Any 2xx releases; ignore body. Failure/non-2xx is not permission to proceed with
effects/ACK: leave recoverable durable state. When disabled, do not call barriers
or use an alternate business implementation. Controllers provide no business code.
