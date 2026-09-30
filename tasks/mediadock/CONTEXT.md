# MediaDock Context

MediaDock models tenant-scoped media ingestion and derived artifacts over durable metadata and managed bytes.

- `UploadSession` owns an immutable expected object identity and a resumable part set.
- `BlobObject` is content-addressed physical storage; `MediaAsset` is the tenant-visible logical identity.
- `ScanJob` gates all access and transcoding; only a CLEAN source can become READY.
- `TranscodeJob` writes staging output and promotes one verified Rendition atomically.
- `AccessGrant` is a revocable, expiring capability whose raw token is never stored.
- `CleanupRun` deletes only objects proven unreachable from live assets, jobs, grants, and leases.
- `MediaAlias` and immutable publication revisions are introduced only by the Manager message.

Never expose raw access tokens, storage paths, scanner payloads, signing keys, or another tenant's deduplication facts.
