# GeoPulse Domain Language

- **LocationEvent**: one immutable device observation identified by `eventId` and monotonic `deviceSequence`.
- **RegionVersion**: one immutable polygon revision with an activation interval and boundary tolerance.
- **Membership**: the current region state for one device, derived from accepted observations.
- **Transition**: one durable `ENTER`, `EXIT`, or `DWELL` fact; it is never rewritten after publication.
- **Watermark**: the greatest event time through which a device's ordered observations have been evaluated.
- **Boundary tolerance**: the published distance band that suppresses enter/exit oscillation near an edge.
- **RegionBundle**: the Manager-added immutable set of RegionVersions published as one atomic revision.

Use these terms in the public contract, dialogue, evaluator, checklist, and reports. Do not substitute
"ping" for LocationEvent, "zone" for Region, or "alert" for Transition.
