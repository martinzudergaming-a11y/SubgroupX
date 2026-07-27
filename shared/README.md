# Shared source contract

`src/` is the dependency-free TypeScript contract imported by both the Node server and browser.
It may depend only on another relative module in this directory. It is a source boundary, not a
published package; server code uses explicit relative imports and browser code uses `@shared/*`.

See [`docs/SOURCE-LAYOUT.md`](../docs/SOURCE-LAYOUT.md) and verify with `npm run check:layout`.
