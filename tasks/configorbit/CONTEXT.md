# ConfigOrbit Context

ConfigOrbit is a tenant-scoped runtime configuration control plane.

- `ConfigRevision` is an immutable complete configuration document for one application environment.
- `Release` points an environment at one frozen revision and owns its rollout rule.
- `EnvironmentGeneration` is the monotonic cache-consistency fence observed by clients.
- `ClientObservation` records a client's last acknowledged generation, not an authority copy of configuration.
- `Invalidation` announces a committed generation and is safe under duplicate or reordered delivery.
- `PromotionTrain` and `PromotionStage` are introduced only by the Manager message.

Do not call a draft revision a release, and do not treat cache invalidation delivery as release authority.
