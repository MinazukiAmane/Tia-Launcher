glib 0.18.5, vendored for GTK 3 compatibility.

Backports https://github.com/gtk-rs/gtk-rs-core/pull/1343 to fix
RUSTSEC-2024-0429. Also applies compiler suggestions for explicit lifetimes
and redundant parentheses, without changing behavior. Upstream license
and copyright files are retained. Remove this override when Tauri updates
its GTK dependency to a fixed upstream version.
