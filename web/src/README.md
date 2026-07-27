# Web source map

The browser tree uses product capabilities at the top and layers only inside a capability.
`platform/` contains browser/transport adapters, `ui/` contains truly shared primitives,
`conversation/` and `files/` are reusable domains, and `dashboard/` composes route features,
session interaction, and application chrome.

See [`docs/SOURCE-LAYOUT.md`](../../docs/SOURCE-LAYOUT.md). Do not recreate a generic
`dashboard/components/` bucket; place a file beside the behavior that changes with it.
