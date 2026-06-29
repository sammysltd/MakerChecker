# @makerchecker/proof-verifier

A standalone, **zero-dependency, zero-trust** verifier for MakerChecker audit
bundles. It re-implements verification from the public
[audit specification](../../docs/audit-spec.md) alone — it does **not** import
the server, touch a database, or make a network call. Hand it a signed bundle
and it tells you, offline, whether the chain is intact and who signed it.

> An auditor trusts this verifier *because* it is not the vendor's server. The
> code is Apache-2.0 and reproducible; the trust is in the independence.

## Why it exists

A MakerChecker deployment exports a signed, hash-chained record of every agent
action (`audit export`). The value of that record is that **anyone can check it
without trusting us**. This package is the reference independent checker: a CLI,
an importable isomorphic core, and a single-file web page that runs entirely in
the browser with nothing uploaded.

## CLI

```bash
npx @makerchecker/proof-verifier verify bundle.json
# pin the instance public key (obtained out of band) so a re-signed bundle is rejected:
npx @makerchecker/proof-verifier verify bundle.json --key instance-pubkey.pem
# pipe it, or get machine-readable output:
cat bundle.json | agent-proof verify - --json
```

Exit code `0` = verified, `1` = failed, `2` = usage error.

```
PASS  8 events, full chain (genesis-rooted)
      head 0bcad691a02af976dc71359097a96d39cb880381a4a0c6e45edb3b0dfd200e68
      key  sha256:460b8ebb6806467bfc0613e15eedbe217f7ad34da3d426bb510449161e7e9af5
```

## Browser

Open [`verifier.html`](./verifier.html) in a recent browser, or save it and open
it offline. Drop a bundle in; all hashing and Ed25519 verification happen
locally via WebCrypto. This is the file you can hand a regulator: it keeps
working with no server, no account, and no internet, even after a contract ends.

## Library

```js
import { verifyBundle, nodeCrypto } from "@makerchecker/proof-verifier";

const result = await verifyBundle(bundle, nodeCrypto, {
  expectedPublicKeyPem, // optional out-of-band key pinning
});
// { ok: true, count, bundleKind, headHash, keyFingerprint }
// | { ok: false, reason, failedSeq? }
```

The core (`@makerchecker/proof-verifier/core`) is isomorphic: all cryptography
is injected through a provider, so the same logic runs under Node and in the
browser.

## What it checks

Per the [audit spec](../../docs/audit-spec.md):

1. **Signature** — Ed25519 over the RFC 8785 canonical signing string.
2. **Count** — events match the signed count.
3. **Hash-set digest** — the exact event set and order are bound into the signature.
4. **Per-event hashes** — every event's SHA-256 recomputes (any altered field fails here).
5. **Linkage** — full bundles verify complete genesis-rooted `prev_hash` linkage;
   run bundles verify every event is bound to the signed `run_id`.
6. **Head & bounds** — head hash and first/last seq match the manifest.
7. **Key pinning (optional)** — rejects a bundle re-signed with any key but the pinned one.

## Conformance vectors

[`vectors/`](./vectors) is a public corpus: valid full and run bundles plus
adversarial variants (tampered payload, corrupted signature, truncation,
reordering, a re-signed foreign-run splice, and a wrong-key forgery), each with
the verdict a conformant verifier must return in
[`vectors/index.json`](./vectors/index.json). Any implementation in any language
can run these and self-certify.

```bash
npm test            # rebuilds the vectors and asserts every verdict
npm run build:vectors
```

The reimplementation here is cross-checked to be **byte-identical** to the
producer's own primitives (`@makerchecker/shared`), so "verify from the spec
alone" is a fact, not a slogan.

## License

Apache-2.0.
