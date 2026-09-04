# glib 0.18.5 (patched)

Vendored from [crates.io glib 0.18.5](https://crates.io/crates/glib/0.18.5)
(`checksum 233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`).

## Why this exists

Tauri 2's Linux stack is pinned to GTK3 (`gtk` / `webkit2gtk` 0.18.x), which
depends on `glib ^0.18`. The published fix for
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) /
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) is
only in `glib` 0.20.0. gtk-rs will not cut a 0.18.6
([gtk-rs-core#2010](https://github.com/gtk-rs/gtk-rs-core/issues/2010)).

## Local change

Byte-identical backport of [gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)
in `src/variant_iter.rs` (`VariantStrIter::impl_get`):

- `let p` → `let mut p`
- `&p` → `&mut p`

No other files are modified. Package version stays `0.18.5` so it still
satisfies `gtk` 0.18's `glib ^0.18` requirement.

## Retire when

Drop this directory and the `[patch.crates-io]` entries in
`packages/desktop/src-tauri/Cargo.toml` and `packages/mobile/src-tauri/Cargo.toml`
once Tauri ships GTK4 bindings that resolve `glib >= 0.20`.
