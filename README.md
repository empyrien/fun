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
