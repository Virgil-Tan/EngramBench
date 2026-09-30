# EdgeTwin Context

EdgeTwin models tenant-scoped device shadows and durable commands while devices disconnect and acknowledgements arrive late or out of order.

- `DeviceShadow` contains independent desired and reported versions; neither may move backward.
- `DeviceCommand` freezes payload, desired version, expiry, and one stable delivery identity.
- `CommandReceipt` is immutable device evidence and may arrive duplicated or out of order.
- `FirmwareRelease` is immutable content metadata; `UpgradeCampaign` freezes eligible devices and target release.
- `UpgradeTarget` owns one device's upgrade state and never infers success from dispatch alone.
- `DeploymentWave`, introduced only by the Manager, adds staged health-gated activation and rollback.

Do not call desired state reported state, or receipt arrival order device order. Never expose device secrets, firmware signing material, private endpoints, or cross-tenant telemetry.
