#!/usr/bin/env python3
"""Build ghost-assets/ghostmaker-data.json for the /ghostmaker app.

Derives, from the real collection (ghost-assets/ghost-anim-data.json, 9,308
ghosts), which trait goes with which skin and via which exact file:

  1. minted   — a (trait, skin) pair that exists in the collection uses the
                file the collection used (most common when several).
  2. tagged   — the trait has a file whose suffix names this skin
                (muscles_right__gold.png for gold), even if never minted.
  3. neutral  — the trait has an untagged/alt file that the collection shows
                on >= NEUTRAL_MIN distinct skins (crown.png on 9 skins), and
                this skin is attested wearing neutral files in this slot.
  4. otherwise the trait is unavailable for that skin.

Also emits the two cross-slot rules the collection enforces strictly:
jetpack hands + jetpack propulsion travel together, and backpack_left
never appears without backpack_right. Both are asserted against the data
below so this file can't silently drift out of truth.

Run from anywhere:  python3 tools/build-ghostmaker-data.py
"""

import collections
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "ghost-assets", "ghost-anim-data.json")
OUT = os.path.join(ROOT, "ghost-assets", "ghostmaker-data.json")

NEUTRAL_MIN = 3  # distinct skins a plain/alt file must be minted on to count as skin-agnostic

# Suffix roots that name a skin (or skin family). Onesie animal names are
# added at runtime (sword__unicorn.png is the dark-unicorn-onesie arm recolor).
# A suffix is "tagged" when it is a root, or a root plus an alt counter
# (zombie_alt1, onesie1). Everything else (alt1, alt2, ...) is a style alt
# of the same trait, not a skin tag.
SKIN_TAG_ROOTS = {
    "white", "gold", "blobby", "bubble", "glitch", "glow", "goblin", "ice",
    "robot", "translucent", "zombie", "hot",
    "onesie", "onesie_brown", "onesie_green", "onesie_grey", "onesie_white",
    "onesie_yellow", "onesie_dark",
}


def humanize(name):
    name = re.sub(r"_(left|right)$", "", name)
    words = name.replace("_", " ").split()
    fixed = []
    for w in words:
        fixed.append({"3d": "3D", "gm": "GM", "h": "H"}.get(w, w.capitalize()))
    return " ".join(fixed)


def main():
    with open(SRC) as f:
        d = json.load(f)
    order = d["order"]
    vals = d["values"]
    files = d["files"]
    ghosts = d["ghosts"]
    skin_i = order.index("skin")
    slots = [s for s in order if s != "skin"]

    # value -> file per slot
    vfile = {slot: dict(zip(vals[slot], files[slot])) for slot in order}

    # onesie animal names are skin-tag roots too (see SKIN_TAG_ROOTS note)
    animals = {v.partition("$")[2] for v in vals["skin"] if v.startswith("onesie$")}
    tag_roots = SKIN_TAG_ROOTS | {a for a in animals if a}

    def suffix_of(value):
        return value.partition("$")[2]

    def tag_root_of(suffix):
        for t in sorted(tag_roots, key=len, reverse=True):
            if suffix == t or re.fullmatch(re.escape(t) + r"(_alt\d+|\d+)", suffix):
                return t
        return None

    def is_tagged(value):
        return tag_root_of(suffix_of(value)) is not None

    # ---- pass over the collection -------------------------------------
    skin_count = collections.Counter()
    # minted[slot][base][skin] -> Counter(value)
    minted = {s: collections.defaultdict(lambda: collections.defaultdict(collections.Counter)) for s in slots}
    # value_skins[slot][value] -> set of skins that wore that exact file
    value_skins = {s: collections.defaultdict(set) for s in slots}
    # neutral_gate[slot] -> set of skins minted WEARING a neutral file in slot
    # (a none$ placeholder is not "wearing" anything and must not open the gate)
    neutral_gate = {s: set() for s in slots}

    for arr in ghosts.values():
        skin = vals["skin"][arr[skin_i]]
        skin_count[skin] += 1
        for slot, idx in zip(order, arr):
            if slot == "skin":
                continue
            v = vals[slot][idx]
            base = v.partition("$")[0]
            minted[slot][base][skin][v] += 1
            value_skins[slot][v].add(skin)
            if base != "none" and not is_tagged(v):
                neutral_gate[slot].add(skin)

    released_skins = sorted(skin_count, key=lambda s: -skin_count[s])

    # ---- skin tag sets -------------------------------------------------
    # onesie animal -> arm-color suffix, from minted color-suffixed files
    onesie_color = {}
    for slot in ("hand_left", "hand_right"):
        for base, per_skin in minted[slot].items():
            for skin, ctr in per_skin.items():
                if not skin.startswith("onesie$"):
                    continue
                for v in ctr:
                    suf = suffix_of(v)
                    if suf.startswith("onesie_"):
                        prev = onesie_color.get(skin)
                        assert prev in (None, suf), f"{skin}: {prev} vs {suf}"
                        onesie_color[skin] = suf

    def tags_for(skin):
        base, _, animal = skin.partition("$")
        if base == "onesie":
            tags = [animal]  # sword__unicorn.png style animal-specific recolors win
            if skin in onesie_color:
                tags.append(onesie_color[skin])
            tags.append("onesie")
            return tags
        return [base]  # zombie$alt1 -> zombie, translucent$muscles -> translucent

    # ---- resolve every (slot, base, skin) ------------------------------
    # option list per slot: base -> {label, bySkin: {skin: file}, rule counts}
    out_slots = {}
    stats = collections.Counter()
    for slot in slots:
        bases = {}
        all_values = vals[slot]
        by_base_values = collections.defaultdict(list)
        for v in all_values:
            by_base_values[v.partition("$")[0]].append(v)
        for base in sorted(minted[slot]):  # only bases the collection actually used
            base_values = by_base_values[base]
            # per tag root, the canonical tagged value (shortest suffix wins,
            # so zombie beats zombie_alt1 unless the mint record says otherwise)
            tagged_by_root = {}
            for v in base_values:
                root = tag_root_of(suffix_of(v))
                if root is None:
                    continue
                prev = tagged_by_root.get(root)
                if prev is None or len(suffix_of(v)) < len(suffix_of(prev)):
                    tagged_by_root[root] = v
            neutral_values = [v for v in base_values if not is_tagged(v)]
            # neutral values that the collection shows on >= NEUTRAL_MIN skins
            broad_neutrals = [v for v in neutral_values if len(value_skins[slot][v]) >= NEUTRAL_MIN]
            by_skin = {}
            total = 0
            for skin in released_skins:
                per = minted[slot][base].get(skin)
                if per:  # rule 1: minted
                    v = per.most_common(1)[0][0]
                    by_skin[skin] = vfile[slot][v]
                    total += sum(per.values())
                    stats["minted"] += 1
                    continue
                hit = next((tagged_by_root[t] for t in tags_for(skin) if t in tagged_by_root), None)
                if hit:  # rule 2: file tagged for this skin
                    by_skin[skin] = vfile[slot][hit]
                    stats["tagged"] += 1
                    continue
                if broad_neutrals and skin in neutral_gate[slot]:  # rule 3
                    v = max(broad_neutrals, key=lambda v: len(value_skins[slot][v]))
                    by_skin[skin] = vfile[slot][v]
                    stats["neutral"] += 1
                    continue
                stats["unavailable"] += 1
            bases[base] = {
                "label": "None" if base == "none" else humanize(base),
                "minted": total,
                "skins": by_skin,
            }
        out_slots[slot] = bases

    # every slot must resolve "none" for every skin (fall back to blank)
    for slot in slots:
        none = out_slots[slot].get("none")
        if none is None:
            none = {"label": "None", "minted": 0, "skins": {}}
            out_slots[slot]["none"] = none
        for skin in released_skins:
            none["skins"].setdefault(skin, None)  # null file = draw nothing

    # ---- skins (the flippable skin options themselves) -----------------
    skin_opts = []
    for skin in released_skins:
        label = humanize(skin.replace("$", " "))
        skin_opts.append({
            "id": skin,
            "label": label,
            "file": vfile["skin"][skin],
            "minted": skin_count[skin],
        })

    # ---- cross-slot rules, asserted against the data --------------------
    hl_i, hr_i, pr_i = order.index("hand_left"), order.index("hand_right"), order.index("propulsion")
    jp_props = sorted({v.partition("$")[0] for v in vals["propulsion"] if v.startswith("jetpack")})
    exceptions = 0
    for arr in ghosts.values():
        hl = vals["hand_left"][arr[hl_i]].partition("$")[0]
        hr = vals["hand_right"][arr[hr_i]].partition("$")[0]
        pr = vals["propulsion"][arr[pr_i]].partition("$")[0]
        trio = (hl == "jetpack_left", hr == "jetpack_right", pr in jp_props)
        if any(trio) and not all(trio):
            exceptions += 1
        if hl == "backpack_left" and hr != "backpack_right":
            raise AssertionError("backpack rule broken")
    assert exceptions <= 1, f"jetpack trio has {exceptions} exceptions"  # 1 known 1/1

    # discover every hard requirement the collection enforces: a base whose
    # partner in another slot is a single base >=99% of the time (n>=50).
    # Covers paired arms (muscles/gloves/guitar/watergun/gestures), two-hand
    # items (floaty duck), coverage (skull mask -> no mouth), and the
    # anti-propulsion items (backpacks, battle axe, scythe, stuck hatchet).
    # Jetpack pieces are excluded here — the 3-slot rig rule owns them.
    recs = [{s: vals[s][arr[order.index(s)]].partition("$")[0] for s in order}
            for arr in ghosts.values()]
    jp_set = {"jetpack_left", "jetpack_right"} | set(jp_props)
    requires = []
    for A in slots:
        for B in slots:
            if A == B:
                continue
            partner = collections.defaultdict(collections.Counter)
            for r in recs:
                partner[r[A]][r[B]] += 1
            for a in sorted(partner):
                if a == "none" or a in jp_set:
                    continue
                ctr = partner[a]
                total = sum(ctr.values())
                if total < 50:
                    continue
                top, topn = ctr.most_common(1)[0]
                if top in jp_set:
                    continue
                if topn / total >= 0.99:
                    requires.append({"if": [A, a], "then": [B, top]})

    data = {
        "size": d["size"],
        "paintOrder": ["bg"] + order,
        "slots": slots,
        "skins": skin_opts,
        "traits": out_slots,
        "backgrounds": d["backgrounds"],
        "rules": {
            "jetpack": {"hand_left": "jetpack_left", "hand_right": "jetpack_right", "propulsion": jp_props},
            "requires": requires,
        },
    }
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024}KB)")
    print("resolution stats:", dict(stats))
    print(f"cross-slot requires ({len(requires)}):")
    for r in requires:
        print(f"  {r['if'][0]}:{r['if'][1]} -> {r['then'][0]}:{r['then'][1]}")
    for slot in slots:
        n = len(out_slots[slot])
        print(f"  {slot}: {n} traits; available for white/gold/robot/zombie/onesie$duck: "
              + "/".join(str(sum(1 for b in out_slots[slot].values() if s in b['skins'])) for s in ("white", "gold", "robot", "zombie", "onesie$duck")))


if __name__ == "__main__":
    main()
