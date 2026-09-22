# Ghostmaker

The trait bench for the [Dead Pixels Ghost Club](https://deadpixels.club) —
assemble a ghost from the collection's real trait vault.

**Live:** https://deadpixels.club/ghostmaker

The ghost sits center-bench. Every trait type is a shelf row beside it: the
part left of the ghost is the previous option, the part right of it is the
next one. Click an arrow to pull that part in (it flies from its shelf onto
the ghost and lands exactly where its art sits in the 47px frame), click a
part image to open a searchable browser of everything eligible, drag a row
like a conveyor, or roll a row's dice. Reset returns to Ghost #1 as minted.

## The interesting part: the rules are mined, not written

Everything the bench allows is derived from the 9,308 minted ghosts by
[`tools/build-ghostmaker-data.py`](tools/build-ghostmaker-data.py), which
emits [`ghost-assets/ghostmaker-data.json`](ghost-assets/ghostmaker-data.json):

1. **Per-skin trait resolution.** For every (trait, skin) pair: a minted
   combination uses the exact file the collection used; otherwise a file
   whose suffix names the skin (`muscles_right__gold.png`); otherwise a
   broadly-neutral plain file the collection shows on 3+ skins; otherwise
   the trait is unavailable for that skin — flick to a skin without muscle
   arms and the muscles fly off.
2. **Cross-slot requirements.** Any trait whose partner in another slot is a
   single value ≥99% of the time (n≥50) becomes a hard rule — paired arms
   (muscles, boxing gloves, guitar, watergun, gestures), two-hand items
   (the floaty duck), coverage (skull mask ⇒ no mouth), anti-propulsion
   gear (backpacks, battle axe, scythe, stuck hatchet) — 19 rules, plus the
   3-slot jetpack rig. The app enforces them with cycle-free cascades.

## Circulation badge

Under the ghost, a badge says whether the exact build is **already in
circulation**: classic builds are matched by skin + the six trait bases
(backdrop ignored, alt variants collapsed — so #7646 and #9309, which differ
only by a cap variant, both count) against every classic mint via a compact
base-36 signature index in the data file; Neon builds are matched by exact
Neon layer ids against the minted Neon blueprints. Built for community
build competitions, where an entry has to be a ghost that doesn't exist yet.

The live page also has a **Neon lab** (curated palette recipes over a
generated layer atlas, the competition default) whose data files are served
from the site and are not mirrored here.

## Posting an entry to X

"Post your entry" (under the badge, disabled for builds already in
circulation) shares the build as a contest entry tagged @deadpixels_club.
X's post links can prefill text but not attach media, so on phones the
native share sheet hands the image and text to the X app, and on desktop
the image goes to the clipboard while X's composer opens ready to paste.

Each post links back to the exact build: `/ghostmaker?skin=…&head=…`, one
key per slot (`bg skin head eyes mouth lh rh prop`, plus `m=neon`),
omitted slots meaning none, and `.` standing in for `$` in trait ids.
Opening a link re-validates every value against the vault and the rules.

## Files

| File | What it is |
| --- | --- |
| `ghostmaker.html` | The page — layout, bench styling, part-browser styling |
| `js/ghostmaker.js` | Everything else — shelf rows, flight animations, rule engine, picker, PNG export |
| `tools/build-ghostmaker-data.py` | Derives the data file from the collection's `ghost-anim-data.json` |
| `ghost-assets/ghostmaker-data.json` | The derived compatibility data the app runs on |

No frameworks, no build step — vanilla JS served as-is.

## What's not here

The 47×47 trait layer art (`ghost-assets/<slot>/*.png`) and the collection
index (`ghost-assets/ghost-anim-data.json`) are not included — the app loads
them by root-relative path on deadpixels.club. To run this elsewhere you'd
point those paths (and the build script's input) at the live site.

## License

Code is [MIT](LICENSE). All Dead Pixels Ghost Club artwork remains
© Dead Pixels Ghost Club and is not covered by the code license.
