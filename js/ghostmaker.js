/* Ghostmaker — assemble a ghost from the real trait vault.
 *
 * Data: /ghost-assets/ghostmaker-data.json (built by tools/build-ghostmaker-data.py
 * from the minted collection). Every option shown is resolvable for the current
 * skin; changing skin re-resolves every trait to that skin's variant file or
 * drops the trait when no variant exists. Cross-slot rules (jetpack rig,
 * backpack straps) mirror what the collection itself enforces.
 *
 * UI: the ghost sits center-bench. Each trait type is a shelf row — the chip
 * left of the ghost is the previous option, the chip right is the next one.
 * Stepping a row makes the part fly from its shelf onto the ghost (cropped to
 * its art, scaling up as it travels) while the outgoing part flies off to the
 * opposite shelf. Backdrops fly in underneath the ghost.
 */
(function () {
  "use strict";

  // keep the query in step with the script tag's ?v= — it pins matching
  // data through the CDN cache whenever the two evolve together
  var DATA_URL = "/ghost-assets/ghostmaker-data.json?v=14";
  var MINTED_URL = "/ghost-assets/minted-blueprints-9412.json";
  var NEON_URL = "/ghost-assets/neon-builder-data-v1.json";
  // Temporary competition default. The Neon lab still has an explicit
  // Classic builder escape hatch, and failed Neon loads leave Classic usable.
  var DEFAULT_TO_NEON = true;
  var ROW_ORDER = ["bg", "skin", "head", "eyes", "mouth", "hand_left", "hand_right", "propulsion"];
  // Canonical compositor order verified against the minted Neon renders.
  // Propulsion art intentionally stacks over the body where they overlap.
  var NEON_PAINT_ORDER = ["skin", "propulsion", "hand_left", "eyes", "mouth", "head", "hand_right"];
  var SLOT_LABEL = {
    bg: "Backdrop", skin: "Skin", head: "Head", eyes: "Eyes", mouth: "Mouth",
    hand_left: "Left hand", hand_right: "Right hand", propulsion: "Propulsion"
  };
  // Ghost #1, exactly as minted (background from completeness-data.json)
  var DEFAULT_STATE = {
    bg: "solid_white", skin: "white", head: "none", eyes: "expression_eyes",
    mouth: "expression_mouth", hand_left: "none", hand_right: "gesture_relaxed", propulsion: "none"
  };
  var CHIP_ART = 44;   // chip inner art box, px

  // A ghost always has eyes and (unless a rule forbids it — skull mask) a
  // mouth. The collection agrees: 0 of 9,412 minted ghosts lack eyes, and
  // the only 91 without a mouth are exactly the skull-mask ghosts.
  var REQUIRED = { eyes: true, mouth: true };

  function slotRequired(slot) {
    if (neonMode) {
      var neonRequired = NEON && NEON.rules && NEON.rules.required;
      return (neonRequired || ["eyes", "mouth", "hand_right"]).indexOf(slot) !== -1;
    }
    return !!REQUIRED[slot];
  }

  var G = null;                 // classic trait data
  var MINTED = null;            // exact #9309–#9412 blueprint patch
  var NEON = null;              // complete generated Neon layer lattice + palette rules
  var neonAtlas = null;
  var neonLoad = null;
  var neonOpenRequest = 0;
  var neonIndex = {};
  var neonSkinOptions = null;
  var neonBoundsCache = new Map();
  var neonMode = false;
  var classicState = null;
  var TRAIT_SLOTS = [];         // non-skin trait slots, paint order
  var state = {};
  var rows = {};                // slot -> Row
  var imgCache = new Map();
  var boundsCache = new Map();

  // ---------- helpers ----------------------------------------------------

  function assetUrl(slot, file) { return "/ghost-assets/" + slot + "/" + file; }

  function loadImg(url) {
    if (imgCache.has(url)) return imgCache.get(url);
    var p = new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error("failed: " + url)); };
      im.src = url;
    });
    // evict failures so a flaky fetch doesn't poison the URL for the session
    p.catch(function () { imgCache.delete(url); });
    imgCache.set(url, p);
    return p;
  }

  // opaque-pixel bounding box of a 47x47 layer, {x,y,w,h} or null if empty
  function artBounds(url) {
    if (boundsCache.has(url)) return boundsCache.get(url);
    var p = loadImg(url).then(function (im) {
      var oc = document.createElement("canvas");
      oc.width = 47; oc.height = 47;
      var c = oc.getContext("2d", { willReadFrequently: true });
      c.drawImage(im, 0, 0);
      var d = c.getImageData(0, 0, 47, 47).data;
      var minX = 47, minY = 47, maxX = -1, maxY = -1;
      for (var y = 0; y < 47; y++) {
        for (var x = 0; x < 47; x++) {
          if (d[(y * 47 + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    });
    p.catch(function () { boundsCache.delete(url); });
    boundsCache.set(url, p);
    return p;
  }

  function chipScaleFor(bb) {
    var m = Math.max(bb.w, bb.h);
    // integer upscale when the art fits, fractional downscale when it doesn't
    return m <= CHIP_ART ? Math.floor(CHIP_ART / m) : CHIP_ART / m;
  }

  function stateIdFor(slot) { return state[slot]; }

  function copyState(from) {
    var out = {};
    Object.keys(DEFAULT_STATE).forEach(function (key) { out[key] = from[key]; });
    return out;
  }

  function restoreState(from) {
    Object.keys(DEFAULT_STATE).forEach(function (key) { state[key] = from[key]; });
  }

  function baseOf(id) {
    return !id || id === "none" ? "none" : id.split("$", 1)[0];
  }

  function titleWords(value) {
    return value.replace(/_to_/g, " → ").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function parseNeonVariant(value, slot) {
    value = slot === "skin" ? value.split("@", 1)[0].split("$", 2)[1] : value.split("$neon_", 2)[1];
    var bloom = null;
    var bm = value.match(/_b(\d+)$/);
    if (bm) { bloom = Number(bm[1]); value = value.slice(0, bm.index); }
    var light = 0;
    var lm = value.match(/_l(\d+)$/);
    if (lm) { light = Number(lm[1]); value = value.slice(0, lm.index); }
    return { palette: value, light: light, bloom: bloom };
  }

  function skinLayerId(id) { return id.split("@", 1)[0]; }

  function buildNeonIndex() {
    neonIndex = {};
    neonSkinOptions = null;
    Object.keys(NEON.layers).forEach(function (slot) {
      neonIndex[slot] = Object.keys(NEON.layers[slot]).map(function (value) {
        var parsed = parseNeonVariant(value, slot);
        return {
          id: value,
          value: value,
          base: baseOf(value),
          palette: parsed.palette,
          light: parsed.light,
          bloom: parsed.bloom,
          cell: NEON.layers[slot][value],
          slot: slot,
          neon: true
        };
      });
    });
  }

  // the classic ⇄ neon switch: idle | loading | active | error
  function setNeonButton(mode) {
    var sw = document.getElementById("mode-switch");
    if (!sw) return;
    var bench = document.getElementById("bench");
    document.body.classList.toggle("neon-loading", mode === "loading");
    if (bench) {
      bench.inert = mode === "loading";
      if (mode === "loading") bench.setAttribute("aria-busy", "true");
      else bench.removeAttribute("aria-busy");
    }
    var random = document.getElementById("btn-random");
    if (random) {
      random.textContent = mode === "active" ? "Randomize Neon" : "Randomize all";
      random.title = mode === "active" ? "Build another rule-compatible Neon" : "Randomize a classic ghost";
    }
    sw.disabled = mode === "loading";
    sw.classList.toggle("on", mode === "active");
    sw.classList.toggle("loading", mode === "loading");
    sw.classList.toggle("error", mode === "error");
    sw.setAttribute("aria-checked", mode === "active" ? "true" : "false");
    if (mode === "loading") sw.setAttribute("aria-busy", "true"); else sw.removeAttribute("aria-busy");
    sw.title = mode === "active" ? "Switch back to the classic builder"
      : mode === "error" ? "The Neon atlas did not load — tap to retry"
      : "Switch on the Neon lab";
    var status = document.getElementById("mode-status");
    if (status) {
      status.textContent = mode === "loading" ? "loading the Neon atlas…"
        : mode === "error" ? "Neon atlas didn't load — tap the switch to retry"
        : mode === "active" ? "Neon lab · free accessory colors" : "classic trait vault";
    }
  }

  function ensureNeonLoaded() {
    if (NEON && neonAtlas) return Promise.resolve(NEON);
    if (neonLoad) return neonLoad;
    setNeonButton("loading");
    neonLoad = fetch(NEON_URL).then(function (r) {
      if (!r.ok) throw new Error("Neon builder data " + r.status);
      return r.json();
    }).then(function (data) {
      return loadImg(data.atlas).then(function (atlas) {
        NEON = data;
        neonAtlas = atlas;
        buildNeonIndex();
        setNeonButton("idle");
        return data;
      });
    }).catch(function (err) {
      neonLoad = null;
      NEON = null;
      neonAtlas = null;
      neonIndex = {};
      neonSkinOptions = null;
      setNeonButton("error");
      throw err;
    });
    return neonLoad;
  }

  function findNeonLayer(slot, base, palette, light) {
    var list = neonIndex[slot] || [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item.base === base && item.palette === palette && item.light === light) return item.value;
    }
    return null;
  }

  function neonLayerValue(slot, id) {
    return slot === "skin" ? skinLayerId(id) : id;
  }

  function neonCell(slot, id) {
    var value = neonLayerValue(slot, id);
    return NEON.layers[slot] && NEON.layers[slot][value];
  }

  function drawAtlasCell(ctx, cell, dx, dy, dw, dh, crop) {
    var sx = (cell % NEON.columns) * NEON.cell;
    var sy = Math.floor(cell / NEON.columns) * NEON.cell;
    if (crop) {
      ctx.drawImage(neonAtlas, sx + crop.x, sy + crop.y, crop.w, crop.h, dx, dy, dw, dh);
    } else {
      ctx.drawImage(neonAtlas, sx, sy, NEON.cell, NEON.cell, dx, dy, dw, dh);
    }
  }

  function neonBounds(cell) {
    if (neonBoundsCache.has(cell)) return neonBoundsCache.get(cell);
    var cv = document.createElement("canvas");
    cv.width = NEON.cell; cv.height = NEON.cell;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    drawAtlasCell(ctx, cell, 0, 0, NEON.cell, NEON.cell);
    var data = ctx.getImageData(0, 0, NEON.cell, NEON.cell).data;
    var minX = NEON.cell, minY = NEON.cell, maxX = -1, maxY = -1;
    for (var y = 0; y < NEON.cell; y++) {
      for (var x = 0; x < NEON.cell; x++) {
        if (data[(y * NEON.cell + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    var bounds = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    neonBoundsCache.set(cell, bounds);
    return bounds;
  }

  function leaveNeonMode() {
    if (!neonMode) return false;
    neonMode = false;
    document.body.classList.remove("neon-builder");
    setNeonButton("idle");
    if (classicState) restoreState(classicState);
    classicState = null;
    return true;
  }

  function defaultNeonState() {
    var skins = neonIndex.skin.filter(function (item) { return item.palette === "purple_to_cyan"; });
    var skin = skins.filter(function (item) { return item.light === 20 && item.bloom === 40; })[0] || skins[0];
    var body = parseNeonVariant(skin.value, "skin");
    return {
      bg: "starlight",
      skin: skin.value,
      propulsion: "none",
      hand_left: "none",
      eyes: findNeonLayer("eyes", "expression_eyes", body.palette, body.light),
      mouth: findNeonLayer("mouth", "expression_mouth", body.palette, body.light),
      head: "none",
      hand_right: findNeonLayer("hand_right", "gesture_relaxed", body.palette, body.light)
    };
  }

  function toggleNeonBuilder() {
    clearFx();
    if (neonMode) {
      leaveNeonMode();
      syncRows();
      render(true);
      pushLog([{ t: "classic trait vault restored" }]);
      return;
    }
    if (!NEON || !neonAtlas) {
      var request = ++neonOpenRequest;
      pushLog([{ t: "opening Neon vault — loading 4,400 generated layers" }]);
      ensureNeonLoaded().then(function () {
        if (request === neonOpenRequest && !neonMode) toggleNeonBuilder();
      }).catch(function (err) {
        console.error("[ghostmaker neon init]", err);
        pushLog([{ t: "Neon atlas did not load — classic builder is still ready · tap retry", warn: true }]);
      });
      return;
    }
    classicState = copyState(state);
    neonMode = true;
    document.body.classList.add("neon-builder");
    restoreState(defaultNeonState());
    setNeonButton("active");
    syncRows();
    render(true);
    pushLog([{ t: "Neon lab open — mix all 11 accessory colors with any skin" }]);
  }

  function skinLabel(id) {
    if (neonMode) {
      var meta = parseNeonVariant(id, "skin");
      return titleWords(meta.palette) + " · L" + meta.light + " · Glow " + meta.bloom;
    }
    for (var i = 0; i < G.skins.length; i++) if (G.skins[i].id === id) return G.skins[i].label;
    return id;
  }

  function traitLabel(slot, base) {
    if (neonMode) {
      if (base === "none") return "None";
      if (slot === "bg") {
        var nb = NEON.backgrounds.filter(function (item) { return item.id === base; })[0];
        return nb ? nb.label : titleWords(base);
      }
      if (slot === "skin") return skinLabel(base);
      var parsed = parseNeonVariant(base, slot);
      var label = (G.traits[slot][baseOf(base)] || {}).label || titleWords(baseOf(base));
      return label + " · " + titleWords(parsed.palette) + " L" + parsed.light;
    }
    if (slot === "bg") {
      for (var i = 0; i < G.backgrounds.length; i++) if (G.backgrounds[i].id === base) return G.backgrounds[i].label;
      return base;
    }
    if (slot === "skin") return skinLabel(base);
    var o = G.traits[slot][base];
    return o ? o.label : base;
  }

  function currentFile(slot) {
    if (neonMode) {
      if (slot !== "bg") return null;
      var bg = NEON.backgrounds.filter(function (item) { return item.id === state.bg; })[0];
      return bg ? bg.file : null;
    }
    if (slot === "bg") {
      for (var i = 0; i < G.backgrounds.length; i++) if (G.backgrounds[i].id === state.bg) return G.backgrounds[i].file;
      return null;
    }
    if (slot === "skin") {
      for (var j = 0; j < G.skins.length; j++) if (G.skins[j].id === state.skin) return G.skins[j].file;
      return null;
    }
    var o = G.traits[slot][state[slot]];
    return o ? (o.skins[state.skin] || null) : null;
  }

  function canJetpack(skin) {
    var jp = G.rules.jetpack;
    var hl = G.traits.hand_left[jp.hand_left];
    var hr = G.traits.hand_right[jp.hand_right];
    if (!hl || !(skin in hl.skins)) return false;
    if (!hr || !(skin in hr.skins)) return false;
    for (var i = 0; i < jp.propulsion.length; i++) {
      var p = G.traits.propulsion[jp.propulsion[i]];
      if (p && skin in p.skins) return true;
    }
    return false;
  }

  function neonOptionsFor(slot) {
    if (slot === "bg") {
      return NEON.backgrounds.map(function (item) {
        return { id: item.id, label: item.label, slot: "bg", file: item.file, minted: 0, neon: true, variant: "Neon backdrop" };
      });
    }
    if (slot === "skin") {
      if (neonSkinOptions) return neonSkinOptions;
      // Each body variant appears once. Accessory colors are selected
      // independently, so curated recipe metadata no longer duplicates skins.
      neonSkinOptions = neonIndex.skin.map(function (item) {
        return {
          id: item.value,
          value: item.value,
          label: titleWords(item.palette),
          slot: "skin",
          cell: item.cell,
          neon: true,
          palette: item.palette,
          light: item.light,
          bloom: item.bloom,
          variant: "L" + item.light + " · Glow " + item.bloom
        };
      });
      return neonSkinOptions;
    }

    var skinMeta = parseNeonVariant(state.skin, "skin");
    var bodySet = new Set(NEON.bodyBases[slot] || []);
    var accentBases = new Set(NEON.accentBases[slot] || []);
    var out = [];
    // Keep a rule-forced empty state selectable/current (the skull mask's
    // mouth), while still preventing users from making required slots empty.
    if (!slotRequired(slot) || state[slot] === "none") {
      out.push({ id: "none", label: "None", slot: slot, file: null, minted: 0, neon: true, variant: "Empty" });
    }
    (neonIndex[slot] || []).forEach(function (item) {
      var body = bodySet.has(item.base);
      var accent = accentBases.has(item.base);
      if (body && (item.palette !== skinMeta.palette || item.light !== skinMeta.light)) return;
      if (!body && !accent) return;
      var label = (G.traits[slot][item.base] || {}).label || titleWords(item.base);
      out.push({
        id: item.value,
        value: item.value,
        label: label,
        slot: slot,
        cell: item.cell,
        neon: true,
        base: item.base,
        palette: item.palette,
        light: item.light,
        variant: titleWords(item.palette) + " · L" + item.light + (body ? " · Body-lit" : " · Accessory")
      });
    });
    out.sort(function (a, b) {
      if (a.id === "none") return -1;
      if (b.id === "none") return 1;
      return a.label.localeCompare(b.label) || a.variant.localeCompare(b.variant);
    });
    return out;
  }

  function optionsFor(slot, skin) {
    if (neonMode) return neonOptionsFor(slot);
    skin = skin || state.skin;
    if (slot === "bg") {
      return G.backgrounds.map(function (b) { return { id: b.id, label: b.label, slot: "bg", file: b.file, minted: 0 }; });
    }
    if (slot === "skin") {
      return G.skins.map(function (s) { return { id: s.id, label: s.label, slot: "skin", file: s.file, minted: s.minted }; });
    }
    var jp = G.rules.jetpack;
    var jpOK = canJetpack(skin);
    var reqs = G.rules.requires || [];
    var out = [];
    Object.keys(G.traits[slot]).forEach(function (base) {
      var o = G.traits[slot][base];
      if (!(skin in o.skins)) return;
      if (REQUIRED[slot] && base === "none") return;
      var isJp = (slot === "hand_left" && base === jp.hand_left) ||
                 (slot === "hand_right" && base === jp.hand_right) ||
                 (slot === "propulsion" && jp.propulsion.indexOf(base) !== -1);
      if (isJp && !jpOK) return;
      // a trait whose required partner can't be crafted for this skin is out too
      for (var ri = 0; ri < reqs.length; ri++) {
        var rr = reqs[ri];
        if (rr["if"][0] !== slot || rr["if"][1] !== base) continue;
        var tb = rr.then[1];
        if (tb === "none") continue;
        var to = G.traits[rr.then[0]][tb];
        if (!to || !(skin in to.skins)) return;
      }
      out.push({ id: base, label: o.label, slot: slot, file: o.skins[skin], minted: o.minted });
    });
    out.sort(function (a, b) {
      if (a.id === "none") return -1;
      if (b.id === "none") return 1;
      return b.minted - a.minted || (a.label < b.label ? -1 : 1);
    });
    return out;
  }

  function availableNow(slot, base) {
    var opts = optionsFor(slot);
    for (var i = 0; i < opts.length; i++) if (opts[i].id === base) return true;
    return false;
  }

  // most-common eligible option for a required slot, avoiding one base
  function requiredFallback(slot, notBase) {
    var opts = optionsFor(slot);
    if (neonMode) {
      var preferred = slot === "eyes" ? "expression_eyes" : (slot === "mouth" ? "expression_mouth" : "gesture_relaxed");
      for (var ni = 0; ni < opts.length; ni++) {
        if (baseOf(opts[ni].id) === preferred && baseOf(opts[ni].id) !== notBase) return opts[ni].id;
      }
    }
    for (var i = 0; i < opts.length; i++) if (opts[i].id !== notBase) return opts[i].id;
    return "none";
  }

  // ---------- shelf rows --------------------------------------------------

  function Row(slot, rowIndex, bench) {
    var self = this;
    this.slot = slot;
    this.opts = [];

    var rc = "r" + rowIndex;

    this.meta = document.createElement("div");
    this.meta.className = "rowmeta " + rc;
    this.meta.tabIndex = 0;
    this.meta.setAttribute("role", "group");
    this.meta.innerHTML =
      '<div class="rowtext"><span class="rowname">' + SLOT_LABEL[slot] + '</span>' +
      '<span class="rowval"></span></div>' +
      '<button class="revert" aria-label="Revert ' + SLOT_LABEL[slot].toLowerCase() + ' to the baseline (ghost #1)" title="Back to the baseline ' + SLOT_LABEL[slot].toLowerCase() + '">↺</button>' +
      '<button class="browse" aria-label="Browse all ' + SLOT_LABEL[slot].toLowerCase() + ' parts" title="Browse all ' + SLOT_LABEL[slot].toLowerCase() + ' parts">⌕</button>' +
      '<button class="dice" aria-label="Random ' + SLOT_LABEL[slot].toLowerCase() + '" title="Random ' + SLOT_LABEL[slot].toLowerCase() + '">⚄</button>';
    this.val = this.meta.querySelector(".rowval");
    this.meta.querySelector(".dice").addEventListener("click", function (e) {
      e.stopPropagation();
      diceRoll(slot);
    });
    this.meta.querySelector(".browse").addEventListener("click", function (e) {
      e.stopPropagation();
      openPicker(slot);
    });
    this.meta.querySelector(".revert").addEventListener("click", function (e) {
      e.stopPropagation();
      revertSlot(slot);
    });
    this.meta.addEventListener("keydown", function (e) {
      // Let the nested Browse and Random buttons keep their native keyboard
      // behavior; the conveyor shortcuts belong to the row group itself.
      if (e.target !== self.meta) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); self.step(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); self.step(1); }
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(slot); }
    });

    this.prevChip = document.createElement("button");
    this.prevChip.className = "chip chip-prev " + rc;
    this.nextChip = document.createElement("button");
    this.nextChip.className = "chip chip-next " + rc;
    [this.prevChip, this.nextChip].forEach(function (chip) {
      chip.type = "button";
      chip.appendChild(document.createElement("canvas"));
      chip.firstChild.width = CHIP_ART; chip.firstChild.height = CHIP_ART;
      var noneEl = document.createElement("span");
      noneEl.className = "none";
      noneEl.textContent = "∅";
      noneEl.style.display = "none";
      chip.appendChild(noneEl);
    });
    // clicking a waiting part puts it on the ghost
    this.prevChip.addEventListener("click", function () { if (!self.eatClick()) self.step(-1); });
    this.nextChip.addEventListener("click", function () { if (!self.eatClick()) self.step(1); });

    this.count = document.createElement("div");
    this.count.className = "rowcount " + rc;

    bench.appendChild(this.meta);
    bench.appendChild(this.prevChip);
    bench.appendChild(this.nextChip);
    bench.appendChild(this.count);

    // drag a row like a conveyor: every 64px is one step
    this.suppressClick = false;
    [this.meta, this.prevChip, this.nextChip].forEach(function (el) { self.attachDrag(el); });
  }

  Row.prototype.eatClick = function () {
    var s = this.suppressClick;
    this.suppressClick = false;
    return s;
  };

  Row.prototype.attachDrag = function (el) {
    var self = this;
    var drag = null;
    el.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (el === self.meta && e.target.closest && e.target.closest("button")) return;
      // capture to the element the press started on: captured moves still
      // bubble up to this handler, and the eventual click stays on the
      // pressed button (capturing to the container would steal it)
      var capEl = e.target && e.target.setPointerCapture ? e.target : el;
      drag = { id: e.pointerId, x0: e.clientX, applied: 0, capEl: capEl };
      try { capEl.setPointerCapture(e.pointerId); } catch (err) {}
    });
    el.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.x0;
      var steps = Math.trunc(dx / 64);
      while (drag.applied !== steps) {
        // dragging right pulls the conveyor right: previous option comes in
        var dir = steps > drag.applied ? -1 : 1;
        drag.applied += (dir === -1 ? 1 : -1);
        self.step(dir);
        self.suppressClick = true;
      }
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var capEl = drag.capEl;
      drag = null;
      try { capEl.releasePointerCapture(e.pointerId); } catch (err) {}
      setTimeout(function () { self.suppressClick = false; }, 0);
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  Row.prototype.indexOf = function (id) {
    for (var i = 0; i < this.opts.length; i++) if (this.opts[i].id === id) return i;
    return -1;
  };

  Row.prototype.neighbor = function (dir) {
    var n = this.opts.length;
    if (n < 2) return null;
    var i = Math.max(0, this.indexOf(stateIdFor(this.slot)));
    return this.opts[(i + dir + n) % n];
  };

  Row.prototype.step = function (dir) {
    var o = this.neighbor(dir);
    if (o) userSet(this.slot, o.id, dir === 1 ? "next" : "prev");
  };

  Row.prototype.update = function () {
    this.opts = optionsFor(this.slot);
    var cur = stateIdFor(this.slot);
    this.val.textContent = traitLabel(this.slot, cur);
    this.meta.setAttribute("aria-label", SLOT_LABEL[this.slot] + " — " + traitLabel(this.slot, cur) +
      ". Arrow keys change it; Enter browses all parts.");
    this.meta.title = "Browse all " + SLOT_LABEL[this.slot].toLowerCase() + " parts";
    this.meta.querySelector(".revert").setAttribute("aria-label", "Revert " +
      SLOT_LABEL[this.slot].toLowerCase() + " to " + (neonMode ? "the Neon baseline" : "the baseline (ghost #1)"));
    var minted = 0;
    if (neonMode) {
      this.count.textContent = this.slot === "skin"
        ? "body palette"
        : (cur === "none" ? "" : "eligible Neon layer");
    } else if (this.slot === "skin") {
      minted = (G.skins.filter(function (s) { return s.id === cur; })[0] || {}).minted || 0;
    } else if (this.slot !== "bg" && cur !== "none" && G.traits[this.slot][cur]) {
      minted = G.traits[this.slot][cur].minted;
    }
    if (!neonMode) this.count.textContent = minted ? num(minted) + " minted" : (cur === "none" ? "" : (this.slot === "bg" ? "" : "vault only"));
    this.paintChip(this.prevChip, this.neighbor(-1), "previous");
    this.paintChip(this.nextChip, this.neighbor(1), "next");
  };

  Row.prototype.paintChip = function (chip, opt, word) {
    chip.disabled = !opt;
    var cv = chip.firstChild;
    var noneEl = chip.lastChild;
    var token = (chip._token = (chip._token || 0) + 1);
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, CHIP_ART, CHIP_ART);
    if (!opt) {
      chip.setAttribute("aria-label", "No other " + SLOT_LABEL[this.slot].toLowerCase() + " options");
      noneEl.style.display = "none";
      return;
    }
    var detail = opt.neon && opt.variant ? " — " + opt.variant : "";
    chip.setAttribute("aria-label", "Put on " + word + " " + SLOT_LABEL[this.slot].toLowerCase() + ": " + opt.label + detail);
    chip.title = "Put on " + opt.label + detail;
    if (opt.neon && opt.cell != null) {
      noneEl.style.display = "none";
      cv.style.display = "";
      var bb = neonBounds(opt.cell);
      if (!bb) return;
      var ns = chipScaleFor(bb);
      var ndw = bb.w * ns, ndh = bb.h * ns;
      ctx.imageSmoothingEnabled = false;
      drawAtlasCell(ctx, opt.cell, (CHIP_ART - ndw) / 2, (CHIP_ART - ndh) / 2, ndw, ndh, bb);
      return;
    }
    if (!opt.file || opt.id === "none") {
      noneEl.style.display = "";
      cv.style.display = "none";
      return;
    }
    noneEl.style.display = "none";
    cv.style.display = "";
    var url = assetUrl(opt.slot === "bg" ? "bg" : (opt.slot === "skin" ? "skin" : this.slot), opt.file);
    Promise.all([loadImg(url), artBounds(url)]).then(function (r) {
      if (chip._token !== token || !r[1]) return;
      var im = r[0], bb = r[1];
      var s = chipScaleFor(bb);
      var dw = bb.w * s, dh = bb.h * s;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, CHIP_ART, CHIP_ART);
      ctx.drawImage(im, bb.x, bb.y, bb.w, bb.h, (CHIP_ART - dw) / 2, (CHIP_ART - dh) / 2, dw, dh);
    }).catch(function () {});
  };

  function syncRows() {
    ROW_ORDER.forEach(function (slot) { if (rows[slot]) rows[slot].update(); });
  }

  // ---------- state changes & rules --------------------------------------

  function pickJetpackProp() {
    var jp = G.rules.jetpack;
    if (jp.propulsion.indexOf(state.propulsion) !== -1) return state.propulsion;
    var pref = ["jetpack_fire", "jetpack_rainbow"].concat(jp.propulsion);
    for (var i = 0; i < pref.length; i++) {
      var p = G.traits.propulsion[pref[i]];
      if (p && state.skin in p.skins) return pref[i];
    }
    return "none";
  }

  // Enforce everything the collection enforces: the 3-slot jetpack rig plus
  // every discovered requirement (paired arms, two-hand items, coverage,
  // anti-propulsion pieces). `touched` protects slots already decided this
  // round — a rule that would override one drops its own antecedent instead,
  // which keeps enforcement cycle-free.
  function applyRules(msgs, changed) {
    var touched = {};
    if (changed) touched[changed] = true;

    var jp = G.rules.jetpack;
    function isJ(slot) {
      if (slot === "hand_left") return state.hand_left === jp.hand_left;
      if (slot === "hand_right") return state.hand_right === jp.hand_right;
      return jp.propulsion.indexOf(state.propulsion) !== -1;
    }
    var members = ["hand_left", "hand_right", "propulsion"];
    if (changed && members.indexOf(changed) !== -1 && isJ(changed) && canJetpack(state.skin)) {
      var did = false;
      if (!isJ("hand_left")) { state.hand_left = jp.hand_left; touched.hand_left = true; did = true; }
      if (!isJ("hand_right")) { state.hand_right = jp.hand_right; touched.hand_right = true; did = true; }
      if (!isJ("propulsion")) { state.propulsion = pickJetpackProp(); touched.propulsion = true; did = true; }
      if (did) msgs.push({ t: "jetpack is a full rig — tanks + flame equipped" });
    } else {
      var on = members.filter(isJ);
      if (on.length > 0 && on.length < members.length) {
        on.forEach(function (m) { state[m] = "none"; touched[m] = true; });
        msgs.push({ t: "jetpack rig split — remaining pieces removed", warn: true });
      }
    }

    var reqs = G.rules.requires || [];
    // the user's pick has priority: rules IT triggers run first, so picking
    // one half of a pair completes that pair before the rules of whatever
    // was previously equipped get a chance to react (else e.g. stepping
    // from boxing gloves onto the watergun destroyed both hands)
    var ordered = reqs.slice().sort(function (x, y) {
      return (x["if"][0] === changed ? 0 : 1) - (y["if"][0] === changed ? 0 : 1);
    });
    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      for (var i = 0; i < ordered.length; i++) {
        var r = ordered[i];
        var A = r["if"][0], a = r["if"][1], B = r.then[0], b = r.then[1];
        if (state[A] !== a || state[B] === b) continue;
        var aLab = traitLabel(A, a);
        var canSetB = b === "none" || availableNow(B, b);
        // a completion may still fill a slot an earlier rule merely EMPTIED
        // (jetpack rig split, pair breakup) — only slots holding a real
        // value stay protected
        if (canSetB && B !== changed && (!touched[B] || state[B] === "none")) {
          state[B] = b;
          touched[B] = true;
          msgs.push({ t: b === "none"
            ? aLab + " leaves no room for " + SLOT_LABEL[B].toLowerCase() + " — cleared"
            : aLab + " comes as a pair — " + SLOT_LABEL[B].toLowerCase() + " matched" });
        } else {
          state[A] = slotRequired(A) ? requiredFallback(A, a) : "none";
          touched[A] = true;
          msgs.push({ t: b === "none"
            ? aLab + " needs an empty " + SLOT_LABEL[B].toLowerCase() + " — removed"
            : aLab + " lost its pair — removed", warn: true });
        }
        moved = true;
      }
      if (!moved) break;
    }

    // a ghost is never faceless: restore required slots unless a rule is
    // actively forcing them empty (the skull mask)
    Object.keys(REQUIRED).forEach(function (s) {
      if (state[s] !== "none") return;
      var forced = reqs.some(function (r) {
        return r.then[0] === s && r.then[1] === "none" && state[r["if"][0]] === r["if"][1];
      });
      if (!forced) {
        state[s] = requiredFallback(s, null);
        msgs.push({ t: SLOT_LABEL[s].toLowerCase() + " restored — every ghost needs " + (s === "eyes" ? "eyes" : "a mouth") });
      }
    });
  }

  function sameNeonStyle(a, b, slotA, slotB) {
    if (!a || !b || a === "none" || b === "none") return false;
    var ma = parseNeonVariant(a, slotA);
    var mb = parseNeonVariant(b, slotB);
    return ma.palette === mb.palette && ma.light === mb.light;
  }

  function matchingNeonPartner(slot, base, sourceId, sourceSlot) {
    var style = parseNeonVariant(sourceId, sourceSlot);
    return findNeonLayer(slot, base, style.palette, style.light);
  }

  function applyNeonRules(msgs, changed) {
    var touched = {};
    if (changed) touched[changed] = true;
    var reqs = (NEON.rules && NEON.rules.requires) || [];
    var ordered = reqs.slice().sort(function (x, y) {
      return (x["if"][0] === changed ? 0 : 1) - (y["if"][0] === changed ? 0 : 1);
    });

    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      for (var i = 0; i < ordered.length; i++) {
        var rule = ordered[i];
        var A = rule["if"][0], a = rule["if"][1], B = rule.then[0], b = rule.then[1];
        if (baseOf(state[A]) !== a) continue;
        var satisfied = b === "none"
          ? baseOf(state[B]) === "none"
          : baseOf(state[B]) === b && (!rule.matchStyle || sameNeonStyle(state[A], state[B], A, B));
        if (satisfied) continue;

        var genericPartner = optionsFor(B).filter(function (option) { return baseOf(option.id) === b; })[0];
        var target = b === "none" ? "none" : (rule.matchStyle
          ? matchingNeonPartner(B, b, state[A], A)
          : (genericPartner && genericPartner.id));
        var canSet = target && (target === "none" || availableNow(B, target));
        if (canSet && B !== changed && (!touched[B] || baseOf(state[B]) === "none")) {
          state[B] = target;
          touched[B] = true;
          msgs.push({ t: b === "none"
            ? traitLabel(A, state[A]) + " leaves no room for " + SLOT_LABEL[B].toLowerCase() + " — cleared"
            : traitLabel(A, state[A]) + " comes as a colour-matched pair" });
        } else {
          state[A] = slotRequired(A) ? requiredFallback(A, a) : "none";
          touched[A] = true;
          msgs.push({ t: titleWords(a) + " lost its required match — removed", warn: true });
        }
        moved = true;
      }
      if (!moved) break;
    }

    (NEON.rules.required || ["eyes", "mouth", "hand_right"]).forEach(function (slot) {
      if (baseOf(state[slot]) !== "none") return;
      var forced = reqs.some(function (rule) {
        return rule.then[0] === slot && rule.then[1] === "none" && baseOf(state[rule["if"][0]]) === rule["if"][1];
      });
      if (!forced) state[slot] = requiredFallback(slot, null);
    });
  }

  function reconcileNeonForSkin() {
    var skin = parseNeonVariant(state.skin, "skin");
    TRAIT_SLOTS.forEach(function (slot) {
      var id = state[slot];
      if (!id || id === "none") return;
      var base = baseOf(id);
      // Expressions and the relaxed hand are body artwork; accessories
      // retain the exact color and brightness the user chose.
      if ((NEON.bodyBases[slot] || []).indexOf(base) !== -1) {
        state[slot] = findNeonLayer(slot, base, skin.palette, skin.light) || "none";
        return;
      }
      if ((NEON.accentBases[slot] || []).indexOf(base) !== -1 && neonCell(slot, id) != null) return;
      state[slot] = "none";
    });
  }

  function neonUserSet(slot, id, dirHint) {
    if (state[slot] === id) return;
    clearFx();
    var msgs = [];
    if (!availableNow(slot, id)) {
      pushLog([{ t: "that Neon part is not available for this slot", warn: true }]);
      return;
    }
    var prev = snapshotLayers();
    state[slot] = id;
    if (slot === "skin") {
      reconcileNeonForSkin();
      msgs.unshift({ t: "Neon skin — " + skinLabel(state.skin) });
    }
    applyNeonRules(msgs, slot);
    syncRows();
    renderWithFlights(slot, prev, dirHint || "next");
    pushLog(msgs);
  }

  function userSet(slot, id, dirHint) {
    if (neonMode) {
      neonUserSet(slot, id, dirHint);
      return;
    }
    if (state[slot] === id) return;
    clearFx();
    var prev = snapshotLayers();
    var msgs = [];
    if (slot === "skin") {
      state.skin = id;
      TRAIT_SLOTS.forEach(function (s) {
        var b = state[s];
        if (b === "none" || availableNow(s, b)) return;
        if (REQUIRED[s]) {
          state[s] = requiredFallback(s, b);
          msgs.push({ t: traitLabel(s, b) + " — no " + skinLabel(id) + " version — swapped to " + traitLabel(s, state[s]), warn: true });
        } else {
          state[s] = "none";
          msgs.push({ t: traitLabel(s, b) + " — no " + skinLabel(id) + " version — dropped", warn: true });
        }
      });
      applyRules(msgs, null);
    } else {
      state[slot] = id;
      applyRules(msgs, slot);
    }
    syncRows();
    renderWithFlights(slot, prev, dirHint || "next");
    pushLog(msgs);
  }

  // ---------- render ------------------------------------------------------

  var renderToken = 0;
  function layerUrls(excludeSlots) {
    function skip(s) { return excludeSlots && excludeSlots.indexOf(s) !== -1; }
    var urls = [];
    var bgf = currentFile("bg");
    if (bgf && !skip("bg")) urls.push(assetUrl("bg", bgf));
    if (!skip("skin")) urls.push(assetUrl("skin", currentFile("skin")));
    TRAIT_SLOTS.forEach(function (slot) {
      if (skip(slot)) return;
      var f = currentFile(slot);
      if (f) urls.push(assetUrl(slot, f));
    });
    return urls;
  }

  function neonBackgroundFile(id) {
    var bg = NEON.backgrounds.filter(function (item) { return item.id === id; })[0];
    return bg ? bg.file : null;
  }

  // Build into an offscreen canvas from an immutable state snapshot. This
  // keeps an older background request from painting over a newer render when
  // someone flicks quickly or changes builder modes mid-load.
  function composeNeonCanvas(size, includeBg, excludeSlots, sourceState) {
    function skip(slot) { return excludeSlots && excludeSlots.indexOf(slot) !== -1; }
    var frame = document.createElement("canvas");
    frame.width = size; frame.height = size;
    var ctx = frame.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    var bgFile = neonBackgroundFile(sourceState.bg);
    var bgReady = includeBg && !skip("bg") && bgFile
      ? loadImg(assetUrl("bg", bgFile))
      : Promise.resolve(null);
    return bgReady.then(function (bg) {
      if (bg) ctx.drawImage(bg, 0, 0, size, size);
      (NEON.paintOrder || NEON_PAINT_ORDER).forEach(function (slot) {
        if (skip(slot) || sourceState[slot] === "none") return;
        var cell = neonCell(slot, sourceState[slot]);
        if (cell == null) throw new Error("missing Neon atlas cell: " + slot + "/" + sourceState[slot]);
        drawAtlasCell(ctx, cell, 0, 0, size, size);
      });
      return frame;
    });
  }

  function render(pop, excludeSlots) {
    var t = ++renderToken;
    if (neonMode) {
      var neonState = copyState(state);
      return composeNeonCanvas(47, !excludeSlots || excludeSlots.indexOf("bg") === -1, excludeSlots, neonState).then(function (frame) {
        if (t !== renderToken || !neonMode) return;
        var ncv = document.getElementById("ghost");
        var nctx = ncv.getContext("2d");
        nctx.clearRect(0, 0, 47, 47);
        nctx.imageSmoothingEnabled = false;
        nctx.drawImage(frame, 0, 0);
        var miniNeon = document.getElementById("mini");
        if (miniNeon) {
          var miniCtx = miniNeon.getContext("2d");
          miniCtx.clearRect(0, 0, 47, 47);
          miniCtx.drawImage(ncv, 0, 0);
        }
        if (pop) {
          var floater = document.getElementById("floater");
          floater.classList.remove("pop");
          void floater.offsetWidth;
          floater.classList.add("pop");
        }
        updateUnit();
      }).catch(function (err) {
        console.error("[ghostmaker neon]", err);
        if (t === renderToken) pushLog([{ t: "a Neon layer failed to load — flick again to retry", warn: true }]);
      });
    }
    var urls = layerUrls(excludeSlots);
    return Promise.all(urls.map(loadImg)).then(function (imgs) {
      if (t !== renderToken) return;
      var cv = document.getElementById("ghost");
      var ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, 47, 47);
      imgs.forEach(function (im) { ctx.drawImage(im, 0, 0, 47, 47); });
      var mini = document.getElementById("mini");
      if (mini) {
        var mctx = mini.getContext("2d");
        mctx.clearRect(0, 0, 47, 47);
        mctx.drawImage(cv, 0, 0);
      }
      if (pop) {
        var fl = document.getElementById("floater");
        fl.classList.remove("pop");
        void fl.offsetWidth;
        fl.classList.add("pop");
      }
      updateUnit();
    }).catch(function (err) {
      console.error("[ghostmaker]", err);
      if (t === renderToken) pushLog([{ t: "a layer failed to load — flick again to retry", warn: true }]);
    });
  }

  // ---------- part flights ------------------------------------------------
  // A stepped-in part flies from its shelf chip onto the ghost, growing from
  // chip scale to ghost scale and landing exactly where its art sits in the
  // 47px frame. Outgoing parts fly to the opposite shelf; cascade-dropped
  // parts fly off toward their own row's next shelf and fade.

  var motionPreference = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  var fxSeq = 0;
  var fxAnimations = [];
  var FX_MS = 360;

  function clearFx() {
    fxSeq++;
    // Invalidate pending image work as well as animations already on screen.
    renderToken++;
    fxAnimations.forEach(function (animation) { animation.cancel(); });
    fxAnimations = [];
    var host = document.getElementById("benchfx");
    if (host) host.textContent = "";
    var floater = document.getElementById("floater");
    if (floater) floater.classList.remove("is-flying");
  }

  // A resize can move the shelves relative to the ghost mid-flight. The
  // finished composite is already underneath, so reveal it at the new size.
  window.addEventListener("resize", function () {
    if (fxAnimations.length) clearFx();
  });
  if (motionPreference && motionPreference.addEventListener) {
    motionPreference.addEventListener("change", function () {
      if (motionPreference.matches && fxAnimations.length) clearFx();
    });
  }

  function snapshotLayers() {
    var out = { files: {}, cells: {}, paintOrder: neonMode
      ? ["bg"].concat(NEON.paintOrder || NEON_PAINT_ORDER)
      : ["bg", "skin"].concat(TRAIT_SLOTS) };
    ROW_ORDER.forEach(function (slot) {
      var file = currentFile(slot);
      out.files[slot] = file ? assetUrl(slot, file) : null;
      out.cells[slot] = neonMode && slot !== "bg" && state[slot] !== "none"
        ? neonCell(slot, state[slot]) : null;
    });
    return out;
  }

  function renderWithFlights(changedSlot, prev, dir) {
    var next = snapshotLayers();
    // Use compositor order, never shelf order. Stationary and moving layers
    // share this one stack for the entire flight, including skin variants
    // whose trait IDs stay the same and partners changed by the trait rules.
    var paintOrder = next.paintOrder;
    var layers = [];
    var flightCount = 0;
    paintOrder.forEach(function (slot) {
      var was = prev.files[slot], now = next.files[slot];
      var wasCell = prev.cells[slot], nowCell = next.cells[slot];
      if (was === now && wasCell === nowCell) {
        if (now || nowCell != null) layers.push({ slot: slot, url: now, cell: nowCell });
        return;
      }
      if (was || wasCell != null) layers.push({ slot: slot, url: was, cell: wasCell, kind: "out",
        side: slot === changedSlot && dir === "next" ? "prev" : "next" });
      if (now || nowCell != null) layers.push({ slot: slot, url: now, cell: nowCell, kind: "in", side: dir });
      flightCount++;
    });
    if (!flightCount || (motionPreference && motionPreference.matches) ||
        typeof document.getElementById("ghost").animate !== "function") {
      return render(true);
    }

    var seq = ++fxSeq;
    // Prepare every layer before replacing the visible composite. A cold
    // image load must not consume the animation's travel time or leave holes.
    return Promise.all(layers.map(function (layer) {
      // Neon artwork is already loaded in the atlas. Keep its exact cell
      // (including glow) while sharing Classic's timing and flight geometry.
      if (layer.cell != null) return [null, layer.kind ? neonBounds(layer.cell) : null];
      return Promise.all([loadImg(layer.url), layer.kind ? artBounds(layer.url) : null]);
    })).then(function (assets) {
      if (seq !== fxSeq) return;
      // The full-resolution final canvas also keeps downloads and the mini
      // preview current. Reveal it only after all visible flights finish.
      return render(false).then(function () {
        if (seq !== fxSeq || (motionPreference && motionPreference.matches)) return;
        var floater = document.getElementById("floater");
        floater.classList.remove("pop");
        var host = document.getElementById("benchfx");
        var hRect = host.getBoundingClientRect();
        var gRect = document.getElementById("ghost").getBoundingClientRect();
        if (hRect.width < 10 || gRect.width < 10) return;
        var moving = [];
        layers.forEach(function (layer, i) {
          var cv = document.createElement("canvas");
          // Retain all 47 × 47 pixels, including faint/transparent edges, so
          // the landing frame exactly matches the flattened ghost canvas.
          cv.width = 47; cv.height = 47;
          cv.className = "flight-layer";
          cv.dataset.slot = layer.slot;
          cv.style.left = (gRect.left - hRect.left) + "px";
          cv.style.top = (gRect.top - hRect.top) + "px";
          cv.style.width = gRect.width + "px";
          cv.style.height = gRect.height + "px";
          var ctx = cv.getContext("2d");
          ctx.imageSmoothingEnabled = false;
          if (layer.cell != null) drawAtlasCell(ctx, layer.cell, 0, 0, 47, 47);
          else ctx.drawImage(assets[i][0], 0, 0, 47, 47);
          host.appendChild(cv);
          if (layer.kind && assets[i][1]) {
            moving.push({ canvas: cv, layer: layer, bounds: assets[i][1] });
          }
        });
        floater.classList.add("is-flying");
        fxAnimations = moving.map(function (part) {
          return flyPart(part, gRect);
        });
        return Promise.all(fxAnimations.map(function (animation) { return animation.finished; }))
          .then(function () { if (seq === fxSeq) clearFx(); });
      });
    }).catch(function (err) {
      // Cancellation belongs to the newer action; it must never repaint it.
      if (seq !== fxSeq) return;
      clearFx();
      console.error("[ghostmaker flights]", err);
      return render(false);
    });
  }

  function flyPart(part, gRect) {
    var f = part.layer, bb = part.bounds;
    var row = rows[f.slot];
    var chip = f.side === "prev" ? row.prevChip : row.nextChip;
    var cRect = chip.getBoundingClientRect();
    var cs = chipScaleFor(bb);
    // Translate the full frame so its opaque art is centered in the shelf.
    var tx = cRect.left + (cRect.width - bb.w * cs) / 2 - bb.x * cs - gRect.left;
    var ty = cRect.top + (cRect.height - bb.h * cs) / 2 - bb.y * cs - gRect.top;
    var atChip = "translate(" + tx + "px, " + ty + "px) scale(" + (cs / (gRect.width / 47)) + ")";
    var atGhost = "translate(0, 0) scale(1)";
    var incoming = f.kind === "in";
    return part.canvas.animate([
      { transform: incoming ? atChip : atGhost, opacity: 1 },
      { transform: incoming ? atGhost : atChip, opacity: incoming ? 1 : 0 }
    ], {
      duration: FX_MS,
      delay: incoming ? 50 : 0,
      easing: "cubic-bezier(0.2, 0.8, 0.3, 1)",
      fill: "both"
    });
  }

  // ---------- part browser (the /studio trait picker, per slot) ----------

  var picker = null;

  function variantOf(slot, opt) {
    if (opt.variant) return opt.variant;
    if (!opt.file) return "base";
    var m = opt.file.match(/__([a-z0-9_]+)\.png$/);
    return m ? m[1].replace(/_/g, " ") : "base";
  }

  function ensurePicker() {
    if (picker) return picker;
    var backdrop = document.createElement("div");
    backdrop.className = "picker-backdrop";
    backdrop.innerHTML =
      '<section class="picker-sheet" role="dialog" aria-modal="true" aria-labelledby="gm-picker-title">' +
        '<header class="picker-head">' +
          '<div><span class="microlabel" id="gm-picker-micro"></span><h2 id="gm-picker-title"></h2></div>' +
          '<button class="picker-close" type="button" aria-label="Close part browser">×</button>' +
        "</header>" +
        '<div class="picker-tools">' +
          '<div class="gm-search-block">' +
            '<label class="trait-search"><span id="gm-search-label">SEARCH PARTS</span>' +
            '<input type="search" autocomplete="off" placeholder="Try crown, glasses, coffee, gold…"></label>' +
            '<div class="search-meta"><span id="gm-picker-status" role="status" aria-live="polite"></span>' +
            '<button type="button" class="gm-clear" hidden>CLEAR</button></div>' +
          '</div>' +
          '<div class="neon-skin-controls" id="gm-neon-skin-controls" hidden>' +
            '<div class="neon-choice" role="group" aria-label="Body light">' +
              '<span>BODY LIGHT</span><button type="button" data-neon-light="0">L0</button><button type="button" data-neon-light="20">L20</button>' +
              '<button type="button" data-neon-light="40">L40</button><button type="button" data-neon-light="60">L60</button><button type="button" data-neon-light="80">L80</button>' +
            '</div>' +
            '<div class="neon-choice" role="group" aria-label="Body glow">' +
              '<span>GLOW</span><button type="button" data-neon-bloom="0">0</button><button type="button" data-neon-bloom="40">40</button>' +
            '</div>' +
          '</div>' +
        "</div>" +
        '<div class="trait-browser-grid" id="gm-picker-grid"></div>' +
        '<div class="picker-empty" id="gm-picker-empty" hidden></div>' +
        '<footer class="picker-footer"><span>47PX NATIVE ART · NO AI GENERATION</span>' +
        '<button type="button" class="gm-cancel">Cancel</button></footer>' +
      "</section>";
    backdrop.style.display = "none";
    document.body.appendChild(backdrop);
    picker = {
      el: backdrop,
      sheet: backdrop.querySelector(".picker-sheet"),
      micro: backdrop.querySelector("#gm-picker-micro"),
      title: backdrop.querySelector("#gm-picker-title"),
      searchLabel: backdrop.querySelector("#gm-search-label"),
      input: backdrop.querySelector("input"),
      status: backdrop.querySelector("#gm-picker-status"),
      clear: backdrop.querySelector(".gm-clear"),
      grid: backdrop.querySelector("#gm-picker-grid"),
      empty: backdrop.querySelector("#gm-picker-empty"),
      skinControls: backdrop.querySelector("#gm-neon-skin-controls"),
      lightButtons: backdrop.querySelectorAll("[data-neon-light]"),
      bloomButtons: backdrop.querySelectorAll("[data-neon-bloom]"),
      skinLight: 0,
      skinBloom: 0,
      slot: null,
      prevFocus: null,
      prevOverflow: "",
      inerted: []
    };
    backdrop.addEventListener("mousedown", function (e) {
      if (e.target === backdrop) closePicker();
    });
    backdrop.querySelector(".picker-close").addEventListener("click", closePicker);
    backdrop.querySelector(".gm-cancel").addEventListener("click", closePicker);
    picker.input.addEventListener("input", renderPickerGrid);
    Array.prototype.forEach.call(picker.lightButtons, function (button) {
      button.addEventListener("click", function () {
        picker.skinLight = Number(button.getAttribute("data-neon-light"));
        applyPickerSkinStyle();
      });
    });
    Array.prototype.forEach.call(picker.bloomButtons, function (button) {
      button.addEventListener("click", function () {
        picker.skinBloom = Number(button.getAttribute("data-neon-bloom"));
        applyPickerSkinStyle();
      });
    });
    picker.clear.addEventListener("click", function () {
      picker.input.value = "";
      renderPickerGrid();
      picker.input.focus();
    });
    document.addEventListener("keydown", function (e) {
      if (picker.el.style.display === "none") return;
      if (e.key === "Escape") { closePicker(); return; }
      if (e.key !== "Tab") return;
      var focusable = Array.prototype.filter.call(
        picker.sheet.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
        function (el) { return !el.hidden && el.offsetParent !== null; }
      );
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !picker.sheet.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
    return picker;
  }

  function openPicker(slot) {
    ensurePicker();
    picker.slot = slot;
    picker.prevFocus = document.activeElement;
    var neonSkin = neonMode && slot === "skin";
    picker.el.classList.toggle("neon-skin-picker", neonSkin);
    picker.title.textContent = neonSkin ? "Neon skin" : SLOT_LABEL[slot];
    picker.searchLabel.textContent = neonSkin ? "SEARCH BODY COLORS" : "SEARCH PARTS";
    picker.input.placeholder = neonSkin
      ? "Try pink, purple cyan, orange…"
      : neonMode ? "Try horns blue, crown pink, coffee…" : "Try crown, glasses, coffee, gold…";
    picker.skinControls.hidden = !neonSkin;
    if (neonSkin) {
      var skinStyle = parseNeonVariant(state.skin, "skin");
      picker.skinLight = skinStyle.light;
      picker.skinBloom = skinStyle.bloom;
    }
    picker.input.value = "";
    picker.el.style.display = "flex";
    picker.sheet.scrollTop = 0;
    picker.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    picker.inerted = [];
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el === picker.el || el.inert) return;
      el.inert = true;
      picker.inerted.push(el);
    });
    renderPickerGrid();
    if (neonSkin) {
      setTimeout(function () {
        var current = picker.grid.querySelector(".current");
        if (current) current.scrollIntoView({ block: "nearest" });
      }, 0);
    }
    setTimeout(function () { picker.input.focus(); }, 0);
  }

  function closePicker() {
    if (!picker || picker.el.style.display === "none") return;
    picker.el.style.display = "none";
    document.body.style.overflow = picker.prevOverflow;
    picker.inerted.forEach(function (el) { el.inert = false; });
    picker.inerted = [];
    if (picker.prevFocus && picker.prevFocus.focus) picker.prevFocus.focus();
  }

  function applyPickerSkinStyle() {
    var palette = parseNeonVariant(state.skin, "skin").palette;
    var target = neonOptionsFor("skin").filter(function (option) {
      return option.palette === palette && option.light === picker.skinLight && option.bloom === picker.skinBloom;
    })[0];
    if (target && target.id !== state.skin) neonUserSet("skin", target.id);
    renderPickerGrid();
  }

  function renderPickerGrid() {
    var slot = picker.slot;
    var opts = optionsFor(slot);
    var neonSkin = neonMode && slot === "skin";
    if (neonSkin) {
      // One card per body palette, with brightness and glow controlled above.
      opts = opts.filter(function (option) {
        return option.light === picker.skinLight && option.bloom === picker.skinBloom;
      }).sort(function (a, b) {
        return a.label.localeCompare(b.label);
      });
      Array.prototype.forEach.call(picker.lightButtons, function (button) {
        button.setAttribute("aria-pressed", Number(button.getAttribute("data-neon-light")) === picker.skinLight ? "true" : "false");
      });
      Array.prototype.forEach.call(picker.bloomButtons, function (button) {
        button.setAttribute("aria-pressed", Number(button.getAttribute("data-neon-bloom")) === picker.skinBloom ? "true" : "false");
      });
    }
    picker.micro.textContent = neonMode
      ? (slot === "skin"
        ? NEON.skinPalettes.length + " BODY PALETTES · ACCESSORY COLORS ARE INDEPENDENT"
        : "OFFICIAL NEON ART · ALL 11 ACCESSORY COLORS · SEARCH BY PART OR COLOR")
      : "OFFICIAL DEAD PIXELS ART · " + opts.length + " ELIGIBLE FOR " + skinLabel(state.skin).toUpperCase();
    var terms = picker.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    var cur = stateIdFor(slot);
    var shown = opts.filter(function (o) {
      if (!terms.length) return true;
      var hay = (o.label + " " + variantOf(slot, o) + " " + o.id + " " + (o.file || "")).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
    var noun = neonSkin ? "PALETTE" : "PART";
    picker.status.textContent = shown.length + " MATCHING " + noun + (shown.length === 1 ? "" : "S");
    picker.clear.hidden = !picker.input.value;
    picker.grid.textContent = "";
    picker.empty.hidden = shown.length > 0;
    picker.empty.textContent = "NO " + (neonSkin ? "PALETTES" : "PARTS") + " MATCH “" + picker.input.value + "”";
    shown.forEach(function (o) {
      var btn = document.createElement("button");
      btn.type = "button";
      var v = variantOf(slot, o);
      btn.title = o.label + " · " + v;
      btn.setAttribute("aria-pressed", o.id === cur ? "true" : "false");
      if (o.id === cur) btn.className = "current";
      var prev = document.createElement("span");
      prev.className = "trait-preview";
      if (o.neon && o.cell != null) {
        var pcv = document.createElement("canvas");
        pcv.width = 47; pcv.height = 47;
        var pctx = pcv.getContext("2d");
        pctx.imageSmoothingEnabled = false;
        drawAtlasCell(pctx, o.cell, 0, 0, 47, 47);
        prev.appendChild(pcv);
      } else if (o.file && o.id !== "none") {
        var im = document.createElement("img");
        im.src = assetUrl(slot === "bg" ? "bg" : (slot === "skin" ? "skin" : slot), o.file);
        im.alt = "";
        im.loading = "lazy";
        prev.appendChild(im);
      } else {
        var no = document.createElement("span");
        no.className = "none";
        no.textContent = "∅";
        prev.appendChild(no);
      }
      var strong = document.createElement("strong");
      strong.textContent = o.label;
      var small = document.createElement("small");
      small.textContent = v + (o.minted ? " · " + num(o.minted) + " minted" : "");
      btn.appendChild(prev);
      btn.appendChild(strong);
      btn.appendChild(small);
      btn.addEventListener("click", function () {
        closePicker();
        userSet(slot, o.id, "next");
      });
      picker.grid.appendChild(btn);
    });
  }

  // ---------- readouts ----------------------------------------------------

  function unitId() {
    var s = ROW_ORDER.map(function (k) {
      var id = stateIdFor(k);
      // Ignore legacy recipe suffixes so identical artwork keeps its unit ID.
      if (neonMode && k === "skin") id = skinLayerId(id);
      return k + ":" + id;
    }).join("|");
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ("0000" + (h >>> 16).toString(16).toUpperCase()).slice(-4);
  }

  function updateUnit() {
    var unit = document.getElementById("unit");
    unit.textContent = neonMode ? "NEON " + unitId() : "UNIT " + unitId();
    var ghost = document.getElementById("ghost");
    var summary = ROW_ORDER.map(function (slot) {
      return SLOT_LABEL[slot] + ": " + traitLabel(slot, stateIdFor(slot));
    }).join("; ");
    ghost.setAttribute("aria-label", (neonMode ? "Neon ghost. " : "Assembled ghost. ") + summary);
    updateMintBadge();
    scheduleShareRender();
  }

  // ---------- circulation check -------------------------------------------
  // Is the ghost on the bench already a minted ghost (backdrop aside)?
  // Classic builds compare skin + the six trait bases against every classic
  // mint through the base-36 index baked into the data; Neon builds compare
  // exact Neon layer ids against the minted Neon blueprints. Competition
  // entries have to be new ghosts, so the badge under the bench says so.

  var circ = null;   // { classic: Map(sig -> [serials]), neon: Map(sig -> [serials]), codeOf }

  function addSerial(map, sig, serial) {
    var list = map.get(sig);
    if (list) list.push(serial); else map.set(sig, [serial]);
  }

  function buildCirculation() {
    circ = { classic: new Map(), neon: new Map(), codeOf: {} };
    var m = G.minted;
    if (m) {
      m.order.forEach(function (slot) {
        circ.codeOf[slot] = {};
        m.codes[slot].forEach(function (base, i) { circ.codeOf[slot][base] = i; });
      });
      var w = m.order.reduce(function (n, slot) { return n + m.widths[slot]; }, 0);
      var i = 0;
      m.serialRuns.forEach(function (run) {
        for (var serial = run[0]; serial <= run[1]; serial++, i++) {
          addSerial(circ.classic, m.sig.substr(i * w, w), serial);
        }
      });
    }
    if (MINTED && MINTED.ghosts) {
      (MINTED.neonSerials || []).forEach(function (serial) {
        var bp = MINTED.ghosts[String(serial)];
        if (bp) addSerial(circ.neon, neonSigOf(bp), serial);
      });
    }
  }

  function normNone(id) { return !id || baseOf(id) === "none" ? "none" : id; }

  // exact-layer signature; works for a minted blueprint or the bench state
  function neonSigOf(values) {
    return ["skin", "propulsion", "hand_left", "eyes", "mouth", "head", "hand_right"].map(function (slot) {
      return slot === "skin" ? skinLayerId(values[slot] || "") : normNone(values[slot]);
    }).join("|");
  }

  function classicSig() {
    var m = G.minted;
    if (!m) return null;
    var tok = "";
    for (var i = 0; i < m.order.length; i++) {
      var slot = m.order[i];
      var base = slot === "skin" ? state.skin : baseOf(state[slot]);
      var code = circ.codeOf[slot][base];
      if (code === undefined) return null;
      var s = code.toString(36);
      while (s.length < m.widths[slot]) s = "0" + s;
      tok += s;
    }
    return tok;
  }

  // serials already minted with the bench's traits (backdrop aside), or []
  function circulationSerials() {
    if (!circ) buildCirculation();
    if (neonMode) return circ.neon.get(neonSigOf(state)) || [];
    var sig = classicSig();
    return sig ? (circ.classic.get(sig) || []) : [];
  }

  function updateMintBadge() {
    var host = document.getElementById("mintbadge");
    if (!host || !G) return;
    var serials = circulationSerials();
    host.classList.toggle("taken", serials.length > 0);
    host.textContent = "";
    var pill = document.createElement("span");
    pill.className = "pill";
    pill.appendChild(document.createElement("i"));
    var sub = document.createElement("span");
    sub.className = "sub";
    if (serials.length) {
      var list = serials.map(function (s) { return "#" + s; });
      pill.appendChild(document.createTextNode("Already in circulation — ghost " +
        (list.length === 1 ? list[0] : list.slice(0, 2).join(" & ") + (list.length > 2 ? " +" + (list.length - 2) : ""))));
      sub.textContent = "same traits as a minted ghost, backdrop aside — competition entries must be new";
    } else {
      pill.appendChild(document.createTextNode("Not in circulation"));
      sub.textContent = neonMode ? "no minted Neon shares these layers" : "no minted ghost shares this trait combo";
    }
    host.appendChild(pill);
    host.appendChild(sub);
    updatePostButton(serials);
  }

  function updatePostButton(serials) {
    var btn = document.getElementById("btn-post-x");
    var hint = document.getElementById("xpost-hint");
    if (!btn || !hint) return;
    var taken = serials.length > 0;
    btn.disabled = taken;
    btn.title = taken ? "This ghost is already minted — change a trait to enter"
      : "Post this build to X as a Ghostmaker contest entry";
    hint.textContent = taken ? "already minted — change a trait to enter"
      : prefersShareSheet() ? "opens your share sheet — pick X"
      : "opens X with your entry · your ghost is copied, paste it in (" + pasteKeys() + ")";
  }

  // ---------- contest entry: post to X ------------------------------------
  // X's post links can prefill text but never attach media, so the image
  // travels separately: phones hand image + text to the X app through the
  // native share sheet; desktops get the image on the clipboard while X's
  // composer opens with the text filled in, ready for a paste. Every post
  // carries a link that reopens this exact build — how an entry is judged,
  // and minted trait for trait if it wins.

  var SITE = "https://www.deadpixels.club";
  var CLUB_HANDLE = "deadpixels_club";
  var CONTEST_TAG = "GhostmakerContest";
  var SHARE_PX = 47 * 24;   // an integer upscale keeps every pixel crisp
  var SHARE_KEYS = {
    bg: "bg", skin: "skin", head: "head", eyes: "eyes", mouth: "mouth",
    hand_left: "lh", hand_right: "rh", propulsion: "prop"
  };

  function shareQuery() {
    var parts = neonMode ? ["m=neon"] : [];
    ROW_ORDER.forEach(function (slot) {
      var id = neonMode && slot === "skin" ? skinLayerId(state.skin) : state[slot];
      if (!id || id === "none") return;
      // Every trait id is [a-z0-9_$]; "." stands in for "$" so the link
      // needs no percent-encoding and survives X's URL detection intact.
      parts.push(SHARE_KEYS[slot] + "=" + id.replace(/\$/g, "."));
    });
    return parts.join("&");
  }

  function shareUrl() { return SITE + "/ghostmaker?" + shareQuery(); }

  // {neon, values} from a ?skin=…&head=… query, or null if it isn't one
  function readSharedBuild(search) {
    var q = new URLSearchParams(search || "");
    if (!q.get("skin")) return null;
    var values = {};
    ROW_ORDER.forEach(function (slot) {
      var raw = q.get(SHARE_KEYS[slot]);
      values[slot] = raw && /^[a-z0-9_.]{1,96}$/.test(raw) ? raw.replace(/\./g, "$") : "none";
    });
    return { neon: q.get("m") === "neon", values: values };
  }

  // A shared link is only a request: every value is re-checked against the
  // vault and the rules, so a hand-edited link still lands on a legal ghost.
  function applySharedClassic(shared) {
    var v = shared.values;
    state.skin = G.skins.some(function (s) { return s.id === v.skin; }) ? v.skin : DEFAULT_STATE.skin;
    state.bg = G.backgrounds.some(function (b) { return b.id === v.bg; }) ? v.bg : DEFAULT_STATE.bg;
    TRAIT_SLOTS.forEach(function (slot) {
      state[slot] = v[slot] !== "none" && availableNow(slot, v[slot]) ? v[slot] : "none";
    });
    applyRules([], null);
  }

  function enterSharedNeon(shared) {
    var v = shared.values;
    var fallback = defaultNeonState();
    classicState = copyState(state);
    neonMode = true;
    document.body.classList.add("neon-builder");
    state.skin = NEON.layers.skin[v.skin] != null ? v.skin : fallback.skin;
    state.bg = NEON.backgrounds.some(function (b) { return b.id === v.bg; }) ? v.bg : fallback.bg;
    TRAIT_SLOTS.forEach(function (slot) {
      state[slot] = v[slot] !== "none" && availableNow(slot, v[slot]) ? v[slot] : "none";
    });
    applyNeonRules([], null);
    setNeonButton("active");
  }

  function openSharedNeon(shared) {
    var request = ++neonOpenRequest;
    pushLog([{ t: "opening a shared Neon build…" }]);
    ensureNeonLoaded().then(function () {
      if (request !== neonOpenRequest || neonMode) return;
      clearFx();
      enterSharedNeon(shared);
      syncRows();
      render(true);
      pushLog([{ t: "shared Neon build loaded" }]);
    }).catch(function (err) {
      console.error("[ghostmaker shared]", err);
      pushLog([{ t: "the shared Neon build couldn't load — tap the switch to retry", warn: true }]);
    });
  }

  var shareCache = { key: null, blob: null, pending: null };
  var shareTimer = 0;

  function shareKey() {
    return (neonMode ? "n" : "c") + "|" + ROW_ORDER.map(function (slot) { return state[slot]; }).join("|");
  }

  // the share image for the bench as it stands, rendered once per build
  function shareBlob() {
    var key = shareKey();
    if (shareCache.key === key) return shareCache.blob ? Promise.resolve(shareCache.blob) : shareCache.pending;
    var pending = composeCurrent(SHARE_PX, false).then(canvasBlob).then(function (blob) {
      if (shareCache.key === key) { shareCache.blob = blob; shareCache.pending = null; }
      return blob;
    });
    pending.catch(function () {
      if (shareCache.key === key) shareCache = { key: null, blob: null, pending: null };
    });
    shareCache = { key: key, blob: null, pending: pending };
    return pending;
  }

  // Render ahead of the click: iOS only opens the share sheet from inside the
  // tap itself, so the file has to exist before the user reaches the button.
  function scheduleShareRender() {
    clearTimeout(shareTimer);
    shareTimer = setTimeout(function () { shareBlob().catch(function () {}); }, 400);
  }

  function prefersShareSheet() {
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    if (typeof matchMedia !== "function" || !matchMedia("(pointer: coarse)").matches) return false;
    try {
      return navigator.canShare({ files: [new File([""], "ghost.png", { type: "image/png" })] });
    } catch (err) {
      return false;
    }
  }

  function pasteKeys() {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "") ? "⌘V" : "Ctrl+V";
  }

  function postText() {
    return "My " + (neonMode ? "Neon " : "") + "entry for the @" + CLUB_HANDLE + " Ghostmaker contest 👻\n\n" +
      shareUrl() + "\n\n#" + CONTEST_TAG;
  }

  function intentUrl(text) { return "https://x.com/intent/tweet?text=" + encodeURIComponent(text); }

  // a tap-able link in the hint, for when the browser won't open X for us
  function offerLink(label, href) {
    var hint = document.getElementById("xpost-hint");
    hint.textContent = "";
    var a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    hint.appendChild(a);
  }

  function postToX() {
    if (!G || circulationSerials().length) return;
    var text = postText();
    var intent = intentUrl(text);
    var name = "ghostmaker-" + (neonMode ? "neon-" : "") + unitId().toLowerCase() + ".png";
    var ready = shareCache.key === shareKey() ? shareCache.blob : null;

    if (prefersShareSheet()) {
      var sheet = function (blob) {
        return navigator.share({ files: [new File([blob], name, { type: "image/png" })], text: text });
      };
      var sent;
      try { sent = ready ? sheet(ready) : shareBlob().then(sheet); } catch (err) { sent = Promise.reject(err); }
      sent.then(function () {
        pushLog([{ t: "entry handed to your share sheet — good luck" }]);
      }).catch(function (err) {
        if (err && err.name === "AbortError") return;   // the sheet was closed
        // A sheet can refuse a file that finished rendering after the tap;
        // it's ready now, and X is one tap away either way.
        offerLink("open X with your entry text ↗", intent);
        pushLog([{ t: "the share sheet didn't open — tap Post again, or use the X link", warn: true }]);
      });
      return;
    }

    var copied;
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard || !navigator.clipboard.write) {
        throw new Error("no image clipboard");
      }
      copied = navigator.clipboard.write([new ClipboardItem({ "image/png": ready || shareBlob() })]);
    } catch (err) {
      copied = Promise.reject(err);
    }
    // Open X inside the click, before anything awaits, so pop-up blockers
    // see a direct user action.
    var win = window.open(intent, "_blank");
    if (win) {
      try { win.opener = null; } catch (err) {}
    } else {
      offerLink("pop-up blocked — open X with your entry ↗", intent);
    }
    copied.then(function () {
      pushLog([{ t: "ghost copied — paste it into your X post (" + pasteKeys() + ")" }]);
    }).catch(function () {
      shareBlob().then(function (blob) { saveBlob(blob, name); }).catch(function () {});
      pushLog([{ t: "couldn't copy the image here — it downloaded instead; attach it to your post", warn: true }]);
    });
  }

  function num(x) { return String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  var logLines = [];
  function pushLog(msgs) {
    if (!msgs.length) return;
    logLines = msgs.concat(logLines).slice(0, 3);
    var host = document.getElementById("log");
    host.textContent = "";
    logLines.forEach(function (m, i) {
      var d = document.createElement("div");
      d.className = "line" + (m.warn ? " warn" : "") + (i > 0 ? " old" : "");
      d.textContent = m.t;
      host.appendChild(d);
    });
  }

  // ---------- actions -----------------------------------------------------

  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function randomizeNeon() {
    clearFx();
    state.bg = rand(NEON.backgrounds).id;
    state.skin = rand(neonOptionsFor("skin")).id;
    TRAIT_SLOTS.forEach(function (slot) {
      var pool = optionsFor(slot);
      state[slot] = rand(pool).id;
    });
    applyNeonRules([], null);
    syncRows();
    render(true);
    pushLog([{ t: "random Neon — " + skinLabel(state.skin) }]);
  }

  // the baseline is Ghost #1; in the Neon lab it's the Neon default for the
  // palette currently on the body, so a reverted face stays colour-matched
  function baselineFor(slot) {
    if (!neonMode) return DEFAULT_STATE[slot];
    if (slot === "bg") return "starlight";
    if (slot === "skin") return defaultNeonState().skin;
    var base = slot === "eyes" ? "expression_eyes"
      : slot === "mouth" ? "expression_mouth"
      : slot === "hand_right" ? "gesture_relaxed" : null;
    if (!base) return "none";
    var body = parseNeonVariant(state.skin, "skin");
    return findNeonLayer(slot, base, body.palette, body.light) || requiredFallback(slot, null);
  }

  function revertSlot(slot) {
    var target = baselineFor(slot);
    if (!target) return;
    var name = SLOT_LABEL[slot].toLowerCase();
    if (state[slot] === target) {
      pushLog([{ t: name + " is already at the baseline" }]);
      return;
    }
    userSet(slot, target, "prev");
    pushLog([{ t: name + " — back to " + (neonMode ? "the Neon baseline" : "ghost #1's") }]);
  }

  function diceRoll(slot) {
    var pool = optionsFor(slot).filter(function (o) { return o.id !== stateIdFor(slot); });
    if (slot !== "skin" && slot !== "bg") {
      var noNone = pool.filter(function (o) { return o.id !== "none"; });
      if (noNone.length) pool = noNone;
    }
    if (!pool.length) return;
    userSet(slot, rand(pool).id, "next");
  }

  function randomizeAll() {
    if (neonMode) {
      randomizeNeon();
      return;
    }
    neonOpenRequest++;
    clearFx();
    state.bg = rand(G.backgrounds).id;
    state.skin = rand(G.skins).id;
    TRAIT_SLOTS.forEach(function (slot) {
      state[slot] = rand(optionsFor(slot, state.skin)).id;
    });
    // if any jetpack piece rolled, complete the rig; otherwise clear strays
    var jp = G.rules.jetpack;
    var anyJp = state.hand_left === jp.hand_left || state.hand_right === jp.hand_right ||
                jp.propulsion.indexOf(state.propulsion) !== -1;
    if (anyJp && canJetpack(state.skin)) {
      state.hand_left = jp.hand_left;
      state.hand_right = jp.hand_right;
      if (jp.propulsion.indexOf(state.propulsion) === -1) state.propulsion = pickJetpackProp();
    }
    applyRules([], null);   // enforce quietly — the roll itself is the story
    syncRows();
    render(true);
    pushLog([{ t: "randomized — unit " + unitId() }]);
  }

  function resetAll() {
    if (neonMode) {
      clearFx();
      restoreState(defaultNeonState());
      syncRows();
      render(true);
      pushLog([{ t: "Neon bench reset — purple → cyan" }]);
      return;
    }
    neonOpenRequest++;
    clearFx();
    Object.keys(DEFAULT_STATE).forEach(function (k) { state[k] = DEFAULT_STATE[k]; });
    syncRows();
    render(true);
    pushLog([{ t: "bench reset — ghost #1, as minted" }]);
  }

  // the bench's current build as a canvas, at any integer scale of 47px
  function composeCurrent(size, noBg) {
    if (neonMode) return composeNeonCanvas(size, !noBg, noBg ? ["bg"] : null, copyState(state));
    var urls = layerUrls(noBg ? ["bg"] : null);
    return Promise.all(urls.map(loadImg)).then(function (imgs) {
      var cv = document.createElement("canvas");
      cv.width = size; cv.height = size;
      var ctx = cv.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      imgs.forEach(function (im) { ctx.drawImage(im, 0, 0, size, size); });
      return cv;
    });
  }

  function canvasBlob(cv) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error("toBlob failed"));
      }, "image/png");
    });
  }

  function saveBlob(blob, filename) {
    var a = document.createElement("a");
    var href = URL.createObjectURL(blob);
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 1000);
    // iOS Safari dereferences the blob only after its download sheet is
    // confirmed — revoking early breaks it, so wait generously
    setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
  }

  function download(noBg) {
    var neon = neonMode;
    var filename = "ghostmaker-" + (neon ? "neon-" : "") + unitId().toLowerCase() + (noBg ? "-nobg" : "") + ".png";
    composeCurrent(470, noBg).then(canvasBlob).then(function (blob) {
      saveBlob(blob, filename);
    }).catch(function () {
      pushLog([{ t: "download failed — a " + (neon ? "Neon " : "") + "layer would not load", warn: true }]);
    });
  }

  // ---------- init --------------------------------------------------------

  var ready = Promise.all([
    fetch(DATA_URL).then(function (r) {
      if (!r.ok) throw new Error("data " + r.status);
      return r.json();
    }),
    fetch(MINTED_URL).then(function (r) {
      if (!r.ok) throw new Error("minted data " + r.status);
      return r.json();
    })
  ]).then(function (res) {
    G = res[0];
    MINTED = res[1];
    TRAIT_SLOTS = G.slots.filter(function (s) { return s !== "skin"; });
    Object.keys(DEFAULT_STATE).forEach(function (k) { state[k] = DEFAULT_STATE[k]; });

    var bench = document.getElementById("bench");
    ROW_ORDER.forEach(function (slot, i) {
      rows[slot] = new Row(slot, i + 1, bench);
    });
    syncRows();

    document.getElementById("mode-switch").addEventListener("click", toggleNeonBuilder);
    document.getElementById("btn-random").addEventListener("click", randomizeAll);
    document.getElementById("btn-reset").addEventListener("click", resetAll);
    document.getElementById("btn-save").addEventListener("click", function () { download(false); });
    document.getElementById("btn-save-nobg").addEventListener("click", function () { download(true); });
    document.getElementById("btn-post-x").addEventListener("click", postToX);
    ["btn-random", "btn-reset", "btn-save", "btn-save-nobg"].forEach(function (id) {
      document.getElementById(id).disabled = false;
    });
    setNeonButton("idle");

    // Mini preview when the stage scrolls out of view (mostly mobile). Hide it
    // again once the action bar arrives so the fixed canvas never covers a
    // download or mode button on a short/narrow screen.
    if (typeof IntersectionObserver !== "undefined") {
      var mini = document.getElementById("mini");
      var ghostVisible = true;
      var actionsVisible = false;
      var miniObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.target.id === "ghost") ghostVisible = entry.isIntersecting;
          else actionsVisible = entry.isIntersecting;
        });
        mini.classList.toggle("show", !ghostVisible && !actionsVisible);
      }, { threshold: 0 });
      miniObserver.observe(document.getElementById("ghost"));
      miniObserver.observe(document.querySelector(".actions"));
    }

    // A shared entry link (?skin=…) reopens that exact build; otherwise the
    // page lands on the competition default.
    var shared = readSharedBuild(location.search);
    if (shared && !shared.neon) {
      applySharedClassic(shared);
      syncRows();
    }
    render(false);
    if (shared && shared.neon) openSharedNeon(shared);
    else if (shared) pushLog([{ t: "shared build loaded" }]);
    else if (DEFAULT_TO_NEON) toggleNeonBuilder();
    else pushLog([{ t: "vault open — 9,412 minted ghosts · Neon lab available" }]);
  }).catch(function (err) {
    console.error("[ghostmaker] init failed", err);
    var log = document.getElementById("log");
    if (log) log.textContent = "TRAIT VAULT UNREACHABLE — RELOAD TO RETRY";
    ["mode-switch", "btn-random", "btn-reset", "btn-save", "btn-save-nobg"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = true;
    });
  });

  // Test hooks; finish() finalizes any in-flight parts.
  window.__gm = {
    ready: ready,
    get state() { return state; },
    get data() { return G; },
    get neonData() { return NEON; },
    get neonMode() { return neonMode; },
    loadNeon: ensureNeonLoaded,
    rows: rows,
    optionsFor: optionsFor,
    set: function (slot, id) { userSet(slot, id, "next"); },
    step: function (slot, dir) { rows[slot].step(dir); },
    randomizeAll: randomizeAll,
    toggleNeonBuilder: toggleNeonBuilder,
    reset: resetAll,
    unitId: unitId,
    shareUrl: shareUrl,
    postText: postText,
    postToX: postToX,
    shareBlob: shareBlob,
    // applies a share query exactly as page load does, without reloading
    loadShared: function (search) {
      var shared = readSharedBuild(search);
      if (!shared) return Promise.resolve(false);
      clearFx();
      var apply = function () {
        leaveNeonMode();
        if (shared.neon) enterSharedNeon(shared); else applySharedClassic(shared);
        syncRows();
        return render(false).then(function () { return true; });
      };
      return shared.neon ? ensureNeonLoaded().then(apply) : apply();
    },
    finish: function () {
      clearFx();
      return render(false);
    }
  };
})();
