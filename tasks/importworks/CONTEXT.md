# ImportWorks Context

ImportWorks is a tenant-scoped, resumable bulk-data ingestion service.

- `ImportJob` freezes the dataset, schema revision, commit mode, and ordered source-file digest.
- `UploadChunk` is an immutable byte range whose digest makes retry and resume deterministic.
- `ValidationFinding` records a stable row, field, code, and redacted value summary.
- `CommittedRecord` is the durable published result of one valid external row identity.
- `ErrorReport` is a reproducible export derived from the frozen validation result.
- `ImportBundle` and `BundleMember` are introduced only by the Manager message.

Do not call an uploaded file a batch, or treat a successfully uploaded file as committed data.
