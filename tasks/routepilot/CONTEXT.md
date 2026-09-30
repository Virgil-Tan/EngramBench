# RoutePilot Context

RoutePilot models a tenant-scoped API gateway whose data plane must use immutable, atomically activated control-plane revisions.

- `Backend` is an upstream origin with a stable identity; URLs and health details are never exposed outside the tenant.
- `RouteRevision` freezes path matching, precedence, backend versions, canary weights, rate limits, and circuit policy.
- `ConfigRelease` atomically activates one complete set of RouteRevisions; requests never observe a partial release.
- `GatewayRequest` freezes the selected release, route, version, and retry identity for one incoming request.
- `CircuitWindow` and `RateWindow` are shared PostgreSQL authorities across all API processes.
- `RegionalRollout`, introduced only by the Manager, activates one release through frozen regional stages.

Do not call a release a deployment, a backend a route, or a retry a replay. Never expose upstream credentials, admin tokens, internal URLs, or private headers.
