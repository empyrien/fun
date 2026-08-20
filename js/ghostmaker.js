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
  var DATA_URL = "/ghost-assets/ghostmaker-data.json?v=11";
  var ROW_ORDER = ["bg", "skin", "head", "eyes", "mouth", "hand_left", "hand_right", "propulsion"];
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
  // mouth. The collection agrees: 0 of 9,308 minted ghosts lack eyes, and
  // the only 86 without a mouth are exactly the skull-mask ghosts.
  var REQUIRED = { eyes: true, mouth: true };

  var G = null;                 // data file
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

  function skinLabel(id) {
    for (var i = 0; i < G.skins.length; i++) if (G.skins[i].id === id) return G.skins[i].label;
    return id;
  }

  function traitLabel(slot, base) {
    if (slot === "bg") {
      for (var i = 0; i < G.backgrounds.length; i++) if (G.backgrounds[i].id === base) return G.backgrounds[i].label;
      return base;
    }
    if (slot === "skin") return skinLabel(base);
    var o = G.traits[slot][base];
    return o ? o.label : base;
  }

  function currentFile(slot) {
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

  function optionsFor(slot, skin) {
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
      '<span class="rowval" aria-live="polite"></span></div>' +
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
    this.meta.addEventListener("keydown", function (e) {
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
    var minted = 0;
    if (this.slot === "skin") {
      minted = (G.skins.filter(function (s) { return s.id === cur; })[0] || {}).minted || 0;
    } else if (this.slot !== "bg" && cur !== "none" && G.traits[this.slot][cur]) {
      minted = G.traits[this.slot][cur].minted;
    }
    this.count.textContent = minted ? num(minted) + " minted" : (cur === "none" ? "" : (this.slot === "bg" ? "" : "vault only"));
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
    chip.setAttribute("aria-label", "Put on " + word + " " + SLOT_LABEL[this.slot].toLowerCase() + ": " + opt.label);
    chip.title = "Put on " + opt.label;
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
    for (var pass = 0; pass < 4; pass++) {
      var moved = false;
      for (var i = 0; i < reqs.length; i++) {
        var r = reqs[i];
        var A = r["if"][0], a = r["if"][1], B = r.then[0], b = r.then[1];
        if (state[A] !== a || state[B] === b) continue;
        var aLab = traitLabel(A, a);
        var canSetB = b === "none" || availableNow(B, b);
        if (canSetB && !touched[B]) {
          state[B] = b;
          touched[B] = true;
          msgs.push({ t: b === "none"
            ? aLab + " leaves no room for " + SLOT_LABEL[B].toLowerCase() + " — cleared"
            : aLab + " comes as a pair — " + SLOT_LABEL[B].toLowerCase() + " matched" });
        } else {
          state[A] = REQUIRED[A] ? requiredFallback(A, a) : "none";
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

  function userSet(slot, id, dirHint) {
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

  function render(pop, excludeSlots) {
    var t = ++renderToken;
    var urls = layerUrls(excludeSlots);
    return Promise.all(urls.map(loadImg)).then(function (imgs) {
      if (t !== renderToken) return;
      var cv = document.getElementById("ghost");
      var ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, 47, 47);
      imgs.forEach(function (im) { ctx.drawImage(im, 0, 0); });
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

  var REDUCED_MOTION = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fxSeq = 0;
  var FX_MS = 360;

  function clearFx() {
    fxSeq++;
    ["benchfx", "benchfx-back"].forEach(function (id) {
      var host = document.getElementById(id);
      if (host) host.textContent = "";
    });
  }

  function snapshotLayers() {
    var out = { files: {}, ids: {} };
    ROW_ORDER.forEach(function (s) {
      var f = currentFile(s);
      out.files[s] = f ? assetUrl(s === "bg" ? "bg" : (s === "skin" ? "skin" : s), f) : null;
      out.ids[s] = stateIdFor(s);
    });
    return out;
  }

  function renderWithFlights(changedSlot, prev, dir) {
    var fx = [];
    if (!REDUCED_MOTION) {
      ROW_ORDER.forEach(function (s) {
        var nowId = stateIdFor(s);
        var wasId = prev.ids[s];
        if (nowId === wasId) return;
        var f = currentFile(s);
        var nowFile = f ? assetUrl(s === "bg" ? "bg" : (s === "skin" ? "skin" : s), f) : null;
        var wasFile = prev.files[s];
        if (s === changedSlot) {
          // outgoing part exits toward the shelf the new one did NOT come from
          if (wasId !== "none" && wasFile) fx.push({ slot: s, url: wasFile, kind: "out", side: dir === "next" ? "prev" : "next", fade: false });
          if (nowId !== "none" && nowFile) fx.push({ slot: s, url: nowFile, kind: "in", side: dir });
        } else if (wasId !== "none" && wasFile && nowId === "none") {
          fx.push({ slot: s, url: wasFile, kind: "out", side: "next", fade: true });
        }
      });
    }
    if (!fx.length) { render(true); return; }
    var seq = ++fxSeq;
    var inSlots = fx.filter(function (f) { return f.kind === "in"; }).map(function (f) { return f.slot; });
    render(false, inSlots.length ? inSlots : null);
    fx.forEach(function (f, i) { flyPart(f, i, seq); });
    setTimeout(function () {
      if (seq !== fxSeq) return;
      render(false).then(function () {
        if (seq === fxSeq) clearFx();
      });
    }, FX_MS + fx.length * 50 + 40);
  }

  function flyPart(f, i, seq) {
    Promise.all([loadImg(f.url), artBounds(f.url)]).then(function (r) {
      if (seq !== fxSeq || !r[1]) return;
      var im = r[0], bb = r[1];
      var bench = document.getElementById("bench");
      var bRect = bench.getBoundingClientRect();
      if (bRect.width < 10) return;   // hidden/unmeasured pane — skip cosmetics
      var gRect = document.getElementById("ghost").getBoundingClientRect();
      var scale = gRect.width / 47;
      var fw = bb.w * scale, fh = bb.h * scale;
      var fx0 = gRect.left - bRect.left + bb.x * scale;
      var fy0 = gRect.top - bRect.top + bb.y * scale;
      var row = rows[f.slot];
      var chip = f.side === "prev" ? row.prevChip : row.nextChip;
      var cRect = chip.getBoundingClientRect();
      var cs = chipScaleFor(bb);
      var cw = bb.w * cs, ch = bb.h * cs;
      var cx0 = cRect.left - bRect.left + (cRect.width - cw) / 2;
      var cy0 = cRect.top - bRect.top + (cRect.height - ch) / 2;

      var cv = document.createElement("canvas");
      cv.width = bb.w; cv.height = bb.h;
      cv.className = "flypart";
      cv.style.left = fx0 + "px";
      cv.style.top = fy0 + "px";
      cv.style.width = fw + "px";
      cv.style.height = fh + "px";
      var ctx = cv.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(im, bb.x, bb.y, bb.w, bb.h, 0, 0, bb.w, bb.h);
      document.getElementById(f.slot === "bg" ? "benchfx-back" : "benchfx").appendChild(cv);

      var atChip = "translate(" + (cx0 - fx0) + "px, " + (cy0 - fy0) + "px) scale(" + (cw / fw) + ")";
      cv.style.transitionDelay = (i * 50) + "ms";
      if (f.kind === "in") {
        cv.style.transform = atChip;
        void cv.offsetWidth;
        cv.classList.add("fly");
        cv.style.transform = "translate(0, 0) scale(1)";
      } else {
        cv.style.transform = "translate(0, 0) scale(1)";
        void cv.offsetWidth;
        cv.classList.add("fly");
        cv.style.transform = atChip;
        if (f.fade) cv.style.opacity = "0";
      }
    }).catch(function () {});
  }

  // ---------- part browser (the /studio trait picker, per slot) ----------

  var picker = null;

  function variantOf(slot, opt) {
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
        '<div class="gm-search-block">' +
          '<label class="trait-search"><span>SEARCH PARTS</span>' +
          '<input type="search" autocomplete="off" placeholder="Try crown, glasses, coffee, gold…"></label>' +
          '<div class="search-meta"><span id="gm-picker-status" role="status" aria-live="polite"></span>' +
          '<button type="button" class="gm-clear" hidden>CLEAR</button></div>' +
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
      input: backdrop.querySelector("input"),
      status: backdrop.querySelector("#gm-picker-status"),
      clear: backdrop.querySelector(".gm-clear"),
      grid: backdrop.querySelector("#gm-picker-grid"),
      empty: backdrop.querySelector("#gm-picker-empty"),
      slot: null,
      prevFocus: null
    };
    backdrop.addEventListener("mousedown", function (e) {
      if (e.target === backdrop) closePicker();
    });
    backdrop.querySelector(".picker-close").addEventListener("click", closePicker);
    backdrop.querySelector(".gm-cancel").addEventListener("click", closePicker);
    picker.input.addEventListener("input", renderPickerGrid);
    picker.clear.addEventListener("click", function () {
      picker.input.value = "";
      renderPickerGrid();
      picker.input.focus();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && picker.el.style.display !== "none") closePicker();
    });
    return picker;
  }

  function openPicker(slot) {
    ensurePicker();
    picker.slot = slot;
    picker.prevFocus = document.activeElement;
    picker.title.textContent = SLOT_LABEL[slot];
    picker.input.value = "";
    picker.el.style.display = "flex";
    document.body.style.overflow = "hidden";
    renderPickerGrid();
    setTimeout(function () { picker.input.focus(); }, 0);
  }

  function closePicker() {
    if (!picker || picker.el.style.display === "none") return;
    picker.el.style.display = "none";
    document.body.style.overflow = "";
    if (picker.prevFocus && picker.prevFocus.focus) picker.prevFocus.focus();
  }

  function renderPickerGrid() {
    var slot = picker.slot;
    var opts = optionsFor(slot);
    picker.micro.textContent = "OFFICIAL DEAD PIXELS ART · " + opts.length + " ELIGIBLE FOR " + skinLabel(state.skin).toUpperCase();
    var terms = picker.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    var cur = stateIdFor(slot);
    var shown = opts.filter(function (o) {
      if (!terms.length) return true;
      var hay = (o.label + " " + variantOf(slot, o) + " " + o.id + " " + (o.file || "")).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
    picker.status.textContent = shown.length + " MATCHING PART" + (shown.length === 1 ? "" : "S");
    picker.clear.hidden = !picker.input.value;
    picker.grid.textContent = "";
    picker.empty.hidden = shown.length > 0;
    picker.empty.textContent = "NO PARTS MATCH “" + picker.input.value + "”";
    shown.forEach(function (o) {
      var btn = document.createElement("button");
      btn.type = "button";
      var v = variantOf(slot, o);
      btn.title = o.label + " · " + v;
      if (o.id === cur) btn.className = "current";
      var prev = document.createElement("span");
      prev.className = "trait-preview";
      if (o.file && o.id !== "none") {
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
    var s = ROW_ORDER.map(function (k) { return k + ":" + stateIdFor(k); }).join("|");
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ("0000" + (h >>> 16).toString(16).toUpperCase()).slice(-4);
  }

  function updateUnit() {
    document.getElementById("unit").textContent = "UNIT " + unitId();
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
    clearFx();
    Object.keys(DEFAULT_STATE).forEach(function (k) { state[k] = DEFAULT_STATE[k]; });
    syncRows();
    render(true);
    pushLog([{ t: "bench reset — ghost #1, as minted" }]);
  }

  function download(noBg) {
    var urls = layerUrls(noBg ? ["bg"] : null);
    Promise.all(urls.map(loadImg)).then(function (imgs) {
      var cv = document.createElement("canvas");
      cv.width = 470; cv.height = 470;
      var ctx = cv.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      imgs.forEach(function (im) { ctx.drawImage(im, 0, 0, 470, 470); });
      cv.toBlob(function (blob) {
        var a = document.createElement("a");
        var href = URL.createObjectURL(blob);
        a.href = href;
        a.download = "ghostmaker-" + unitId().toLowerCase() + (noBg ? "-nobg" : "") + ".png";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); }, 1000);
        // iOS Safari dereferences the blob only after its download sheet is
        // confirmed — revoking early breaks it, so wait generously
        setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
      }, "image/png");
    }).catch(function () {
      pushLog([{ t: "download failed — a layer would not load", warn: true }]);
    });
  }

  // ---------- init --------------------------------------------------------

  var ready = fetch(DATA_URL).then(function (r) {
    if (!r.ok) throw new Error("data " + r.status);
    return r.json();
  }).then(function (data) {
    G = data;
    TRAIT_SLOTS = G.slots.filter(function (s) { return s !== "skin"; });
    Object.keys(DEFAULT_STATE).forEach(function (k) { state[k] = DEFAULT_STATE[k]; });

    var bench = document.getElementById("bench");
    ROW_ORDER.forEach(function (slot, i) {
      rows[slot] = new Row(slot, i + 1, bench);
    });
    syncRows();

    document.getElementById("btn-random").addEventListener("click", randomizeAll);
    document.getElementById("btn-reset").addEventListener("click", resetAll);
    document.getElementById("btn-save").addEventListener("click", function () { download(false); });
    document.getElementById("btn-save-nobg").addEventListener("click", function () { download(true); });

    // mini preview when the stage scrolls out of view (mostly mobile)
    if (typeof IntersectionObserver !== "undefined") {
      var mini = document.getElementById("mini");
      new IntersectionObserver(function (entries) {
        mini.classList.toggle("show", !entries[0].isIntersecting);
      }, { threshold: 0.1 }).observe(document.getElementById("ghost"));
    }

    render(false);
    pushLog([{ t: "vault open — 9,308 ghosts of precedent" }]);
  }).catch(function (err) {
    console.error("[ghostmaker] init failed", err);
    var log = document.getElementById("log");
    if (log) log.textContent = "TRAIT VAULT UNREACHABLE — RELOAD TO RETRY";
    ["btn-random", "btn-reset", "btn-save", "btn-save-nobg"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = true;
    });
  });

  // test hooks (synchronous where possible; the browser pane throttles
  // rAF/CSS transitions — finish() finalizes any in-flight parts)
  window.__gm = {
    ready: ready,
    get state() { return state; },
    get data() { return G; },
    rows: rows,
    optionsFor: optionsFor,
    set: function (slot, id) { userSet(slot, id, "next"); },
    step: function (slot, dir) { rows[slot].step(dir); },
    randomizeAll: randomizeAll,
    reset: resetAll,
    unitId: unitId,
    finish: function () {
      clearFx();
      return render(false);
    }
  };
})();
