# Server source map

The server is a capability-oriented modular monolith. `index.ts` and `runtime-entrypoint.ts` are
stable composition roots; business and transport responsibilities live in the named directories
beside them. `foundation/` is dependency-free, and persistence points inward rather than importing
product services.

See [`docs/SOURCE-LAYOUT.md`](../../docs/SOURCE-LAYOUT.md) for the map, evidence, and placement rules.
Run `npm run check:layout` after moving or adding source files.
