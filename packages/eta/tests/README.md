# Optional Magpie host integration tests

The normal community package checks need only Bun:

    bun test ./packages/eta
    bun scripts/check.mjs eta

The Go test additionally exercises Magpie's real plugin loader, embedded JS,
installed name/icon APIs, config writes/restoration, off/on/removal and the
agent-scoped gateway catalog. It uses temporary HOME/config directories,
never the user's installed Magpie state, and sends no paid model requests.

Use a disposable writable checkout of Magpie v0.1.3233, commit
191f3c0af1934fbbec87dc589fddf26913699aa9, with its required Go 1.26.8 toolchain:

    bash packages/eta/tests/run-host-tests.sh /absolute/path/to/magpie-source

GO_BINARY may point to another Go executable. The runner injects one test file
in that checkout and removes it on exit; it refuses to replace an existing
file. The tests use Magpie's internal test fixtures, so another host revision
may need fixture updates. There are five top-level tests, including removal
and manually replaced key subcases.

For published-artifact acceptance, unpack npm pack's tarball, inject the same
Go test into the disposable host, and run it there with ETA_MAGPIE_PLUGIN set
to the unpacked package's absolute path. No source patch to Magpie is needed.

These tests prove the pinned source host paths, not native GUI rendering or
paid upstream inference. The port test documents the pinned host's limitation:
Rewire alone leaves the old URL; explicit reapplication/sync writes the new URL.
