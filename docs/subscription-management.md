# Personal subscription management

`/manage` provides a single-owner dashboard. Profiles, exclusions and groups are stored in the existing Redis/Upstash KV. Browser cookies contain only a random session token; sessions expire after one day. Login credentials and subscription sources must never be committed to Git.

Configure `ADMIN_PASSWORD_HASH` with the SHA-256 hash of a cryptographically random management password. Use at least 32 random bytes. The same variable must be configured for each deployment environment where management is enabled. Vercel and Node runtimes refuse in-memory storage when management is configured. The catalog requires an adapter with atomic compare-and-set support (Redis, Upstash, or the test-only memory adapter).

Open `/manage`, log in, and import a subscription URL, full Clash YAML, Base64 subscription or node URIs. Read the nodes and reported usage, exclude unwanted nodes, and optionally add manual, URL-test or fallback groups. With custom groups, the first group receives unmatched traffic. Without custom groups, all selected nodes belong to one selector. This deliberately generates a simple catch-all rule; it does not preserve a source subscription's traffic rules.

Saving stores the profile on the server. Export URLs are `/c/<code>`. Codes are fixed after saving; create another profile for a different code. Disabling a managed profile returns HTTP 410. Existing short codes remain stored and keep their behavior unless a managed profile claims the same code. Profile edits use revision checks and an atomic storage operation; concurrent edits return HTTP 409 instead of losing changes.

A managed export fetches its sources on every update, embeds the nodes, and forwards the first available `Subscription-Userinfo` header. Multiple-source usage is not summed. Source failures return HTTP 503 rather than an empty successful configuration. The client never needs to fetch a source proxy-provider again. All export URLs are bearer links and reveal node credentials to anyone who can access them, including when their fixed suffix is easy to guess.

When management is enabled, legacy `/shorten-v2` and `/config` write operations require the same authenticated session. Managed settings, session hashes and catalog keys are namespaced and do not replace the legacy short-link records. Login sessions are invalidated when `ADMIN_PASSWORD_HASH` changes. To roll back, restore the previous deployment; the separate management catalog does not modify the underlying legacy records.
