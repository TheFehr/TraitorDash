# Fonts of the public role pages

Served at `/fonts/` by the app itself, so every client draws the pages the same (RFC 15).
Latin subsets in woff2, from the npm packages `@fontsource/courier-prime` 5.3.0 (weights 400 and 700)
and `@fontsource/barlow-condensed` 5.3.0 (weights 600 and 800). Both are under the SIL Open Font
License 1.1; the licence texts sit next to the files (`OFL-*.txt`) and must stay with them.
A text outside the Latin range (a translated description) falls back to the client's own font.
