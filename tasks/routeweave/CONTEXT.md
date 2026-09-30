# RouteWeave Context

RouteWeave models tenant-scoped parcel movement over immutable route-plan revisions while scans arrive late, duplicated, or out of order.

- `Shipment` is the customer-visible journey and owns one current RoutePlan revision.
- `TransportLeg` is one ordered movement between two Hubs.
- `ScanEvent` is immutable source evidence identified by scanner event ID and observed time.
- `JourneyProjection` is the deterministic view derived from all accepted evidence, never from arrival order.
- `LossCase` fences further movement until resolved, while `Reassignment` creates a new compatible plan revision.
- `Consignment` and `ParcelPiece`, introduced only by the Manager, change one Shipment from one parcel to many independently scanned pieces.

Do not overwrite source scans or call a projection a scan. Never expose carrier credentials, private facility data, or another tenant's tracking state.
