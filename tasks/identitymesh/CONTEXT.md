# IdentityMesh Context

IdentityMesh models authentication identity lifecycle, not downstream authorization policy.

- `Session` belongs to one User, Device, and Refresh Token family.
- `DeviceTrust` is a nonce-bound trust decision for one public-key fingerprint.
- `SigningKey` has an issuance and bounded verification lifecycle.
- `Revocation` advances a monotonic fence; stale verifiers fail closed.
- `AuditEntry` is a secret-free immutable security fact in a tenant digest chain.
- `CompromiseIncident` and recovery quorum are introduced only by the Manager message.

Do not persist or expose credentials, raw refresh tokens, challenge nonces, provider assertions, or private keys.
