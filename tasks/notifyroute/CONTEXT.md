# NotifyRoute Context

NotifyRoute models tenant-scoped notification routing under rate limits, changing consent, and uncertain provider outcomes.

- `Notification` freezes the requested content, template version, and route policy revision.
- `Delivery` owns one channel and endpoint attempt sequence for one Notification.
- `Suppression` is a monotonic consent fence checked again before every external send.
- `RateLimitPolicy` constrains tenant-channel and recipient-channel traffic across all API and Worker processes.
- `ProviderReceipt` resolves an accepted or unknown external delivery without creating another logical send.
- `Campaign` and its frozen audience are introduced only by the Manager message.

Do not expose endpoint secrets, webhook signing material, raw provider credentials, or private recipient data in events or snapshots.
