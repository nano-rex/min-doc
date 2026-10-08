(function () {
  'use strict';

  const { PDFDocument, PDFName, PDFBool, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = PDFLib;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LINE_HEIGHT = 1.2;
  const ASCENT = 0.8;
  const HIGHLIGHT_COLOR = '#ffe600';
  const HISTORY_LIMIT = 100;

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer');
  const pagesEl = $('pages');

  const state = {
    name: 'document.pdf',
    sources: [], // { name, bytes, pdf }
    pages: [], // { id, src, index, view, baseRot, rot, objs }
    images: {}, // id -> { dataUrl, w, h }
    forms: {}, // source index -> { field name: new value }
    scale: 1.25,
    tool: 'select',
    selected: null,
    dirty: false,
    undo: [],
    redo: [],
  };

  let views = []; // { page, el, sheet, canvas, svg, fields, token, task, key }
  let saveProblems = [];
  let drag = null;
  let editor = null;
  let suppressClick = false;
  let nextId = 1;
  const uid = () => 'o' + nextId++;

  // ---------- geometry ----------

  function totalRot(p) {
    return (p.baseRot + p.rot) % 360;
  }

  // Size of the page as displayed, in points.
  function viewSize(p) {
    const w = p.view[2] - p.view[0];
    const h = p.view[3] - p.view[1];
    return totalRot(p) % 180 === 0 ? { w, h } : { w: h, h: w };
  }

  // Displayed point (origin top left, y down) to PDF user space.
  function toPdf(p, x, y) {
    const [x1, y1, x2, y2] = p.view;
    switch (totalRot(p)) {
      case 90: return { x: x1 + y, y: y1 + x };
      case 180: return { x: x2 - x, y: y1 + y };
      case 270: return { x: x2 - y, y: y2 - x };
      default: return { x: x1 + x, y: y2 - y };
    }
  }

  // PDF user space to displayed point: the inverse of toPdf.
  function fromPdf(p, x, y) {
    const [x1, y1, x2, y2] = p.view;
    switch (totalRot(p)) {
      case 90: return { x: y - y1, y: x - x1 };
      case 180: return { x: x2 - x, y: y - y1 };
      case 270: return { x: y2 - y, y: x2 - x };
      default: return { x: x - x1, y: y2 - y };
    }
  }

  function bounds(o) {
    if (o.type === 'path') {
      const xs = o.pts.map((pt) => pt[0]);
      const ys = o.pts.map((pt) => pt[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    if (o.type === 'text') {
      const size = textSize(o);
      return { x: o.x, y: o.y, w: size.w, h: size.h };
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }

  const measureCtx = document.createElement('canvas').getContext('2d');

  function textSize(o) {
    const lines = o.text.split('\n');
    measureCtx.font = `${o.size}px Helvetica, Arial, sans-serif`;
    const w = Math.max(...lines.map((line) => measureCtx.measureText(line).width));
    return { w, h: lines.length * o.size * LINE_HEIGHT };
  }

  // ---------- status ----------

  let statusTimer = 0;

  function status(message, isError) {
    const el = $('status');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 2500);
  }

  function fail(err) {
    console.error(err);
    status(err && err.message ? err.message : String(err), true);
  }

  // ---------- history ----------

  function snapshot() {
    return JSON.stringify(state.pages);
  }

  function remember(snap) {
    state.undo.push(snap || snapshot());
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo = [];
    state.dirty = true;
  }

  function restore(from, to) {
    if (!from.length) return;
    commitEditor();
    to.push(snapshot());
    state.pages = JSON.parse(from.pop());
    state.selected = null;
    state.dirty = true;
    layout();
  }

  // ---------- loading ----------

  async function loadPdf(name, bytes, append) {
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: 'vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'vendor/pdfjs/standard_fonts/',
    });
    task.onPassword = (update, reason) => {
      const password = prompt(reason === 2 ? 'Wrong password. Try again:' : 'This PDF needs a password:');
      if (password === null) task.destroy();
      else update(password);
    };
    const pdf = await task.promise;
    const added = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      added.push({ id: uid(), src: 0, index: i, view: page.view.slice(), baseRot: page.rotate, rot: 0, objs: [] });
    }
    if (append) {
      remember();
    } else {
      commitEditor();
      state.sources.forEach((s) => s.pdf.destroy());
      Object.assign(state, { name, sources: [], pages: [], images: {}, forms: {}, selected: null, dirty: false, undo: [], redo: [] });
    }
    const src = state.sources.push({ name, bytes, pdf }) - 1;
    added.forEach((p) => { p.src = src; });
    state.pages.push(...added);
    layout();
    if (!append) {
      viewer.scrollTop = 0;
      fitWidth(true);
    }
    status(append ? `Added ${added.length} page(s) from ${name}` : `Opened ${name}`);
  }

  async function openFile(file, append) {
    if (!file) return;
    if (!append && state.dirty && !confirm('Discard the unsaved changes?')) return;
    try {
      await loadPdf(file.name, new Uint8Array(await file.arrayBuffer()), append);
    } catch (err) {
      fail(new Error(`Cannot open ${file.name}: ${err.message || err}`));
    }
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Not a readable image'));
        img.onload = () => {
          let dataUrl = reader.result;
          // pdf-lib embeds only PNG and JPEG, so convert everything else.
          if (!/^data:image\/(png|jpeg)/.test(dataUrl)) {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            dataUrl = canvas.toDataURL('image/png');
          }
          resolve({ dataUrl, w: img.naturalWidth, h: img.naturalHeight });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function placeImage(file) {
    if (!file || !state.pages.length) return;
    try {
      const image = await readImage(file);
      const p = state.pages[currentPage()];
      const size = viewSize(p);
      const fit = Math.min(1, (size.w * 0.5) / image.w, (size.h * 0.5) / image.h);
      const id = uid();
      state.images[id] = image;
      remember();
      const o = { id: uid(), type: 'image', img: id, w: image.w * fit, h: image.h * fit };
      o.x = (size.w - o.w) / 2;
      o.y = (size.h - o.h) / 2;
      p.objs.push(o);
      state.selected = o.id;
      setTool('select');
    } catch (err) {
      fail(err);
    }
  }

  // ---------- page layout and rendering ----------

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pv = views.find((v) => v.el === entry.target);
      if (!pv) continue;
      pv.visible = entry.isIntersecting;
      if (pv.visible) {
        renderPage(pv);
        buildFields(pv).catch(fail);
      } else {
        // Free the bitmap of pages far from the viewport.
        pv.token++;
        pv.key = null;
        pv.canvas.width = pv.canvas.height = 0;
      }
    }
  }, { root: viewer, rootMargin: '800px 0px' });

  function pageButton(label, title, disabled, action) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', action);
    return b;
  }

  function layout() {
    observer.disconnect();
    views.forEach((pv) => { pv.token++; if (pv.task) pv.task.cancel(); });
    pagesEl.textContent = '';
    views = state.pages.map((p, i) => {
      const el = document.createElement('section');
      el.className = 'page';
      const bar = document.createElement('div');
      bar.className = 'page-bar';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `Page ${i + 1}`;
      bar.append(
        label,
        pageButton('↑', 'Move page up', i === 0, () => movePage(i, -1)),
        pageButton('↓', 'Move page down', i === state.pages.length - 1, () => movePage(i, 1)),
        pageButton('⟲', 'Rotate left', false, () => rotatePage(i, 270)),
        pageButton('⟳', 'Rotate right', false, () => rotatePage(i, 90)),
        pageButton('+', 'Insert a blank page after this one', false, () => insertBlank(i)),
        pageButton('✕', 'Delete page', state.pages.length < 2, () => deletePage(i)),
      );
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      const size = viewSize(p);
      sheet.style.width = `${size.w * state.scale}px`;
      sheet.style.height = `${size.h * state.scale}px`;
      const canvas = document.createElement('canvas');
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
      sheet.append(canvas, svg);
      el.append(bar, sheet);
      el.dataset.tool = state.tool;
      pagesEl.append(el);
      const pv = { page: p, el, sheet, canvas, svg, fields: null, token: 0, task: null, key: null, visible: false };
      svg.addEventListener('pointerdown', (e) => onPointerDown(e, pv));
      svg.addEventListener('pointermove', (e) => onPointerMove(e, pv));
      svg.addEventListener('pointerup', (e) => onPointerUp(e, pv));
      svg.addEventListener('pointercancel', (e) => onPointerUp(e, pv));
      svg.addEventListener('click', (e) => onClick(e, pv));
      svg.addEventListener('dblclick', (e) => onDoubleClick(e, pv));
      drawOverlay(pv);
      observer.observe(el);
      return pv;
    });
    updateUi();
  }

  async function renderPage(pv) {
    const p = pv.page;
    const key = `${state.scale}/${totalRot(p)}`;
    if (pv.key === key || p.src === null) return;
    pv.key = key;
    const token = ++pv.token;
    try {
      const page = await state.sources[p.src].pdf.getPage(p.index + 1);
      if (token !== pv.token) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: state.scale * dpr, rotation: totalRot(p) });
      // Render off screen so the visible canvas never shows a half drawn page.
      const buffer = document.createElement('canvas');
      buffer.width = Math.ceil(viewport.width);
      buffer.height = Math.ceil(viewport.height);
      if (pv.task) pv.task.cancel();
      // The form fields are drawn as live inputs by buildFields, not on the canvas.
      pv.task = page.render({ canvasContext: buffer.getContext('2d'), viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
      await pv.task.promise;
      if (token !== pv.token) return;
      pv.canvas.width = buffer.width;
      pv.canvas.height = buffer.height;
      pv.canvas.getContext('2d').drawImage(buffer, 0, 0);
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      if (token === pv.token) pv.key = null;
      fail(err);
    }
  }

  // ---------- form fields of the PDF ----------

  function setField(src, name, value, origin) {
    (state.forms[src] = state.forms[src] || {})[name] = value;
    state.dirty = true;
    // Other widgets of the same field: radio groups, fields repeated on several pages.
    for (const el of pagesEl.querySelectorAll('.fields [data-field]')) {
      if (el !== origin && Number(el.dataset.src) === src && el.dataset.field === name) showField(el, value);
    }
    updateUi();
  }

  function showField(el, value) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = value === el.dataset.on;
    } else if (el.tagName === 'SELECT') {
      for (const option of el.options) option.selected = value.includes(option.value);
    } else {
      el.value = value;
    }
  }

  function fieldElement(p, a) {
    const src = p.src;
    const name = a.fieldName;
    let el;
    let value;
    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      if (a.maxLen) el.maxLength = a.maxLen;
      el.spellcheck = false;
      value = a.fieldValue || '';
      el.addEventListener('input', () => setField(src, name, el.value, el));
    } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
      el = document.createElement('input');
      el.type = a.checkBox ? 'checkbox' : 'radio';
      el.dataset.on = a.checkBox ? a.exportValue : a.buttonValue;
      value = a.fieldValue || 'Off';
      el.addEventListener('change', () => setField(src, name, el.checked ? el.dataset.on : 'Off', el));
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      el.multiple = !!a.multiSelect;
      if (!a.combo) el.size = Math.max(2, a.options.length);
      const chosen = [].concat(a.fieldValue || []);
      value = a.options.filter((o) => chosen.includes(o.exportValue)).map((o) => o.displayValue);
      if (a.combo && !value.length) el.append(new Option('', ''));
      a.options.forEach((o) => el.append(new Option(o.displayValue, o.displayValue)));
      el.addEventListener('change', () => {
        setField(src, name, [...el.selectedOptions].map((o) => o.value).filter(Boolean), el);
      });
    } else {
      return null;
    }
    el.dataset.src = src;
    el.dataset.field = name;
    el.title = a.alternativeText || name;
    el.disabled = !!a.readOnly;
    const stored = state.forms[src] && state.forms[src][name];
    showField(el, stored === undefined ? value : stored);
    return el;
  }

  async function buildFields(pv) {
    const p = pv.page;
    if (pv.fields || p.src === null) return;
    pv.fields = document.createElement('div');
    pv.fields.className = 'fields';
    pv.sheet.append(pv.fields);
    const page = await state.sources[p.src].pdf.getPage(p.index + 1);
    for (const a of await page.getAnnotations()) {
      if (a.subtype !== 'Widget' || a.hidden || !a.fieldName) continue;
      const el = fieldElement(p, a);
      if (!el) continue;
      const c1 = fromPdf(p, a.rect[0], a.rect[1]);
      const c2 = fromPdf(p, a.rect[2], a.rect[3]);
      const w = Math.abs(c2.x - c1.x);
      const h = Math.abs(c2.y - c1.y);
      el.style.left = `${Math.min(c1.x, c2.x) * state.scale}px`;
      el.style.top = `${Math.min(c1.y, c2.y) * state.scale}px`;
      el.style.width = `${w * state.scale}px`;
      el.style.height = `${h * state.scale}px`;
      // Auto sized fields are saved with text that fills the field height.
      const auto = a.multiLine || el.size > 1 ? 10 : Math.max(6, h * 0.75);
      const size = (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || auto;
      el.style.fontSize = `${size * state.scale}px`;
      pv.fields.append(el);
    }
  }

  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.append(el);
    return el;
  }

  function drawOverlay(pv) {
    const { svg, page } = pv;
    svg.textContent = '';
    svg.setAttribute('class', `overlay tool-${state.tool}`);
    for (const o of page.objs) {
      const g = svgEl('g', { 'data-id': o.id }, svg);
      if (o.type === 'path') {
        const points = o.pts.length > 1 ? o.pts : [o.pts[0], o.pts[0]];
        const d = points.map((pt) => pt.join(',')).join(' ');
        const line = { points: d, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        svgEl('polyline', { ...line, stroke: o.color, 'stroke-width': o.width }, g);
        // Wider invisible stroke so thin lines are easy to pick.
        svgEl('polyline', { ...line, stroke: 'transparent', 'stroke-width': o.width + 8 }, g);
      } else if (o.type === 'highlight') {
        svgEl('rect', { class: 'highlight', x: o.x, y: o.y, width: o.w, height: o.h, fill: o.color, 'fill-opacity': 0.35 }, g);
      } else if (o.type === 'whiteout') {
        svgEl('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: '#ffffff' }, g);
      } else if (o.type === 'image') {
        svgEl('image', { x: o.x, y: o.y, width: o.w, height: o.h, href: state.images[o.img].dataUrl, preserveAspectRatio: 'none' }, g);
      } else if (o.type === 'text') {
        if (editor && editor.obj.id === o.id) continue;
        const text = svgEl('text', { fill: o.color, 'font-size': o.size }, g);
        o.text.split('\n').forEach((line, i) => {
          const span = svgEl('tspan', { x: o.x, y: o.y + o.size * (ASCENT + i * LINE_HEIGHT) }, text);
          span.textContent = line || ' ';
        });
        // Transparent box so the whole text block can be grabbed.
        const size = textSize(o);
        svgEl('rect', { x: o.x, y: o.y, width: size.w, height: size.h, fill: 'transparent' }, g);
      }
    }
    const sel = page.objs.find((o) => o.id === state.selected);
    if (sel && !(editor && editor.obj.id === sel.id)) {
      const b = bounds(sel);
      const pad = 3 / state.scale;
      svgEl('rect', { class: 'selection', x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad }, svg);
      if (sel.type !== 'path' && sel.type !== 'text') {
        const r = 5 / state.scale;
        svgEl('rect', { class: 'handle', x: b.x + b.w - r, y: b.y + b.h - r, width: 2 * r, height: 2 * r }, svg);
      }
    }
  }

  function redraw() {
    views.forEach((pv) => {
      pv.el.dataset.tool = state.tool;
      drawOverlay(pv);
    });
    updateUi();
  }

  function findSelected() {
    for (const p of state.pages) {
      const o = p.objs.find((x) => x.id === state.selected);
      if (o) return { page: p, obj: o };
    }
    return null;
  }

  function updateUi() {
    const has = state.pages.length > 0;
    $('empty').hidden = has;
    $('save').disabled = $('append').disabled = $('page-no').disabled = !has;
    $('undo').disabled = !state.undo.length;
    $('redo').disabled = !state.redo.length;
    $('delete').disabled = !findSelected();
    $('zoom-label').textContent = `${Math.round(state.scale * 100)}%`;
    $('page-count').textContent = `/ ${state.pages.length}`;
    $('page-no').max = state.pages.length;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
    document.title = `${state.dirty ? '* ' : ''}${has ? state.name + ' - ' : ''}min-doc`;
  }

  // Index of the page nearest the top of the viewport.
  function currentPage() {
    const top = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    for (let i = 0; i < views.length; i++) {
      if (views[i].el.getBoundingClientRect().bottom > top) return i;
    }
    return Math.max(0, views.length - 1);
  }

  function goToPage(i) {
    const pv = views[Math.min(Math.max(i, 0), views.length - 1)];
    if (pv) pv.el.scrollIntoView({ block: 'start' });
  }

  function setScale(scale) {
    commitEditor();
    const keep = currentPage();
    state.scale = Math.min(6, Math.max(0.2, scale));
    layout();
    goToPage(keep);
  }

  function fitWidth(shrinkOnly) {
    if (!state.pages.length) return;
    const widest = Math.max(...state.pages.map((p) => viewSize(p).w));
    const fit = (viewer.clientWidth - 40) / widest;
    if (shrinkOnly && fit >= state.scale) return;
    setScale(fit);
  }

  // ---------- page operations ----------

  function movePage(i, delta) {
    commitEditor();
    remember();
    const [p] = state.pages.splice(i, 1);
    state.pages.splice(i + delta, 0, p);
    layout();
    goToPage(i + delta);
  }

  function rotatePage(i, by) {
    commitEditor();
    const p = state.pages[i];
    remember();
    // Keep the added items where they are on the page content.
    const size = viewSize(p);
    const turn = (x, y) => (by === 90 ? [size.h - y, x] : [y, size.w - x]);
    for (const o of p.objs) {
      if (o.type === 'path') {
        o.pts = o.pts.map((pt) => turn(pt[0], pt[1]));
      } else {
        const b = bounds(o);
        const c = turn(b.x + b.w / 2, b.y + b.h / 2);
        if (o.type !== 'text') [o.w, o.h] = [o.h, o.w];
        const nb = bounds(o);
        o.x = c[0] - nb.w / 2;
        o.y = c[1] - nb.h / 2;
      }
    }
    p.rot = (p.rot + by) % 360;
    layout();
    goToPage(i);
  }

  function insertBlank(i) {
    commitEditor();
    remember();
    const size = viewSize(state.pages[i]);
    state.pages.splice(i + 1, 0, { id: uid(), src: null, index: 0, view: [0, 0, size.w, size.h], baseRot: 0, rot: 0, objs: [] });
    layout();
    goToPage(i + 1);
  }

  function deletePage(i) {
    if (state.pages.length < 2) return;
    commitEditor();
    remember();
    state.pages.splice(i, 1);
    state.selected = null;
    layout();
    goToPage(Math.min(i, state.pages.length - 1));
  }

  function deleteSelected() {
    const found = findSelected();
    if (!found) return;
    remember();
    found.page.objs = found.page.objs.filter((o) => o !== found.obj);
    state.selected = null;
    redraw();
  }

  // ---------- pointer tools ----------

  function pointOf(e, pv) {
    const r = pv.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
  }

  function onPointerDown(e, pv) {
    if (e.button > 0) return;
    if (editor) {
      suppressClick = true;
      commitEditor();
      return;
    }
    suppressClick = false;
    const pt = pointOf(e, pv);
    const tool = state.tool;
    if (tool === 'text') return;
    if (tool === 'select') {
      const group = e.target.closest('[data-id]');
      const onHandle = e.target.classList.contains('handle');
      const obj = onHandle
        ? pv.page.objs.find((o) => o.id === state.selected)
        : group && pv.page.objs.find((o) => o.id === group.dataset.id);
      if (!obj) {
        if (state.selected) { state.selected = null; redraw(); }
        return;
      }
      state.selected = obj.id;
      drag = { kind: onHandle ? 'resize' : 'move', obj, start: pt, orig: JSON.parse(JSON.stringify(obj)), snap: snapshot(), moved: false };
      syncInputs(obj);
    } else if (tool === 'draw') {
      const obj = { id: uid(), type: 'path', pts: [[pt.x, pt.y]], color: $('color').value, width: Number($('pen').value) || 2 };
      drag = { kind: 'draw', obj, snap: snapshot(), moved: true };
      pv.page.objs.push(obj);
    } else {
      const obj = { id: uid(), type: tool, x: pt.x, y: pt.y, w: 0, h: 0, color: HIGHLIGHT_COLOR };
      drag = { kind: 'rect', obj, start: pt, snap: snapshot(), moved: false };
      pv.page.objs.push(obj);
    }
    pv.svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    redraw();
  }

  function onPointerMove(e, pv) {
    if (!drag) return;
    const pt = pointOf(e, pv);
    const o = drag.obj;
    if (drag.kind === 'draw') {
      const last = o.pts[o.pts.length - 1];
      if (Math.hypot(pt.x - last[0], pt.y - last[1]) < 0.7) return;
      o.pts.push([pt.x, pt.y]);
    } else if (drag.kind === 'rect') {
      o.x = Math.min(drag.start.x, pt.x);
      o.y = Math.min(drag.start.y, pt.y);
      o.w = Math.abs(pt.x - drag.start.x);
      o.h = Math.abs(pt.y - drag.start.y);
      drag.moved = true;
    } else {
      const dx = pt.x - drag.start.x;
      const dy = pt.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) * state.scale < 3) return;
      drag.moved = true;
      if (drag.kind === 'resize') {
        o.w = Math.max(4, drag.orig.w + dx);
        o.h = o.type === 'image' ? o.w * (drag.orig.h / drag.orig.w) : Math.max(4, drag.orig.h + dy);
      } else if (o.type === 'path') {
        o.pts = drag.orig.pts.map((p) => [p[0] + dx, p[1] + dy]);
      } else {
        o.x = drag.orig.x + dx;
        o.y = drag.orig.y + dy;
      }
    }
    drawOverlay(pv);
  }

  function onPointerUp(e, pv) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'rect' && (d.obj.w < 2 || d.obj.h < 2)) {
      pv.page.objs = pv.page.objs.filter((o) => o !== d.obj);
    } else if (d.moved) {
      remember(d.snap);
    }
    redraw();
  }

  function onClick(e, pv) {
    if (state.tool !== 'text' || suppressClick || editor) return;
    const pt = pointOf(e, pv);
    const size = Number($('size').value) || 14;
    const obj = { id: uid(), type: 'text', x: pt.x, y: pt.y - size * ASCENT, size, color: $('color').value, text: '' };
    startEditor(pv, obj, true);
  }

  function onDoubleClick(e, pv) {
    if (state.tool !== 'select') return;
    const group = e.target.closest('[data-id]');
    const obj = group && pv.page.objs.find((o) => o.id === group.dataset.id);
    if (obj && obj.type === 'text') startEditor(pv, obj, false);
  }

  // ---------- text editing ----------

  function startEditor(pv, obj, isNew) {
    commitEditor();
    const area = document.createElement('textarea');
    area.className = 'text-editor';
    area.value = obj.text;
    area.spellcheck = false;
    area.style.left = `${obj.x * state.scale}px`;
    area.style.top = `${obj.y * state.scale}px`;
    area.style.fontSize = `${obj.size * state.scale}px`;
    area.style.color = obj.color;
    const grow = () => {
      const lines = area.value.split('\n');
      area.rows = lines.length;
      area.cols = Math.max(2, ...lines.map((l) => l.length + 1));
    };
    area.addEventListener('input', grow);
    area.addEventListener('blur', commitEditor);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') area.blur();
      e.stopPropagation();
    });
    grow();
    editor = { pv, obj, isNew, area };
    pv.sheet.append(area);
    drawOverlay(pv);
    area.focus();
  }

  function commitEditor() {
    if (!editor) return;
    const { pv, obj, isNew, area } = editor;
    editor = null;
    const text = area.value.replace(/\s+$/, '');
    area.remove();
    const page = pv.page;
    if (text !== obj.text) {
      remember();
      if (isNew && text) page.objs.push(obj);
      if (!text) page.objs = page.objs.filter((o) => o !== obj);
      obj.text = text;
    }
    state.selected = text ? obj.id : null;
    redraw();
  }

  // ---------- tools and inputs ----------

  function setTool(tool) {
    commitEditor();
    state.tool = tool;
    if (tool !== 'select') state.selected = null;
    redraw();
  }

  function syncInputs(o) {
    if (o.color && o.type !== 'whiteout') $('color').value = o.color;
    if (o.type === 'text') $('size').value = o.size;
    if (o.type === 'path') $('pen').value = o.width;
  }

  function applyInput(key, value, types) {
    const found = findSelected();
    if (!found || !types.includes(found.obj.type) || !value) return;
    remember();
    found.obj[key] = value;
    redraw();
  }

  // ---------- saving ----------

  function hexColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  function dataUrlBytes(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Text the built in font cannot encode (for example Chinese) is drawn as an image.
  function rasterText(o) {
    const k = 4;
    const size = textSize(o);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(size.w * k) + 2;
    canvas.height = Math.ceil(size.h * k) + 2;
    const ctx = canvas.getContext('2d');
    ctx.font = `${o.size * k}px Helvetica, Arial, sans-serif`;
    ctx.fillStyle = o.color;
    o.text.split('\n').forEach((line, i) => ctx.fillText(line, 0, o.size * k * (ASCENT + i * LINE_HEIGHT)));
    return { dataUrl: canvas.toDataURL('image/png'), w: canvas.width / k, h: canvas.height / k };
  }

  function fillForm(lib, values) {
    const form = lib.getForm();
    for (const name of Object.keys(values)) {
      const value = values[name];
      try {
        const field = form.getField(name);
        if (field instanceof PDFLib.PDFTextField) field.setText(value || undefined);
        else if (field instanceof PDFLib.PDFCheckBox) value === 'Off' ? field.uncheck() : field.check();
        else if (field instanceof PDFLib.PDFRadioGroup) {
          // The value is the on state of one button; pdf-lib selects by the option label at the same position.
          const at = field.acroField.getOnValues().findIndex((on) => on && on.decodeText() === value);
          if (value === 'Off') field.clear();
          else field.select(field.getOptions()[at]);
        }
        else if (value.length) field.select(value);
        else field.clear();
      } catch (err) {
        console.warn(err);
        saveProblems.push(name);
      }
    }
    return form;
  }

  // Take every page out of the page tree so they can be put back in a new order.
  function detachPages(doc) {
    const pages = doc.getPages();
    for (const page of pages) {
      // Values inherited from the old parent would be lost with it.
      for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
        const name = PDFName.of(key);
        const value = page.node.get(name) ? null : page.node.getInheritableAttribute(name);
        if (value) page.node.set(name, value);
      }
    }
    for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
    return pages;
  }

  async function buildPdf() {
    commitEditor();
    saveProblems = [];
    const libs = [];
    for (let s = 0; s < state.sources.length; s++) {
      if (!state.pages.some((p) => p.src === s)) continue;
      const lib = await PDFDocument.load(state.sources[s].bytes, { ignoreEncryption: true });
      if (lib.isEncrypted) {
        throw new Error(`${state.sources[s].name} is encrypted. It can be viewed but not saved.`);
      }
      libs[s] = lib;
    }

    // The first file is edited in place, so its form fields, bookmarks and
    // properties stay as they are. Pages of added files are copied into it.
    const out = libs[0] || await PDFDocument.create();
    let form = null;
    const copies = new Map();
    for (let s = 0; s < libs.length; s++) {
      const lib = libs[s];
      if (!lib) continue;
      const values = state.forms[s] || {};
      const used = state.pages.filter((p) => p.src === s);
      let pages;
      if (lib === out) {
        if (Object.keys(values).length) form = fillForm(lib, values);
        const own = detachPages(lib);
        pages = used.map((p) => own[p.index]);
      } else {
        // Field names of two files can clash, so added files get their values printed on the page.
        if (lib.getForm().getFields().length) {
          try { fillForm(lib, values).flatten(); } catch (err) { console.warn(err); saveProblems.push(state.sources[s].name); }
        }
        // One call per file so shared fonts and images are written once.
        pages = await out.copyPages(lib, used.map((p) => p.index));
      }
      used.forEach((p, i) => copies.set(p, pages[i]));
    }

    let font = null;
    const helvetica = async () => font || (font = await out.embedFont(StandardFonts.Helvetica));

    const embedded = {};
    const embed = async (key, dataUrl) => {
      if (!embedded[key]) {
        const bytes = dataUrlBytes(dataUrl);
        embedded[key] = await (dataUrl.startsWith('data:image/jpeg') ? out.embedJpg(bytes) : out.embedPng(bytes));
      }
      return embedded[key];
    };

    for (const p of state.pages) {
      const page = p.src === null ? out.addPage([p.view[2], p.view[3]]) : out.addPage(copies.get(p));
      const rot = totalRot(p);
      page.setRotation(degrees(rot));
      const rotate = degrees(rot);
      const drawImage = async (key, dataUrl, box) => {
        const at = toPdf(p, box.x, box.y + box.h);
        page.drawImage(await embed(key, dataUrl), { x: at.x, y: at.y, width: box.w, height: box.h, rotate });
      };
      for (const o of p.objs) {
        if (o.type === 'path') {
          const pts = o.pts.map((pt) => toPdf(p, pt[0], pt[1]));
          if (pts.length === 1) pts.push(pts[0]);
          for (let i = 1; i < pts.length; i++) {
            page.drawLine({ start: pts[i - 1], end: pts[i], thickness: o.width, color: hexColor(o.color), lineCap: LineCapStyle.Round });
          }
        } else if (o.type === 'highlight' || o.type === 'whiteout') {
          const at = toPdf(p, o.x, o.y + o.h);
          const style = o.type === 'highlight'
            ? { color: hexColor(o.color), opacity: 0.35, blendMode: BlendMode.Multiply }
            : { color: rgb(1, 1, 1) };
          page.drawRectangle({ x: at.x, y: at.y, width: o.w, height: o.h, rotate, ...style });
        } else if (o.type === 'image') {
          await drawImage(o.img, state.images[o.img].dataUrl, o);
        } else if (o.type === 'text') {
          const lines = o.text.split('\n');
          const font = await helvetica();
          let encodable = true;
          try { lines.forEach((line) => font.encodeText(line)); } catch (err) { encodable = false; }
          if (encodable) {
            lines.forEach((line, i) => {
              const at = toPdf(p, o.x, o.y + o.size * (ASCENT + i * LINE_HEIGHT));
              page.drawText(line, { x: at.x, y: at.y, size: o.size, font, color: hexColor(o.color), rotate });
            });
          } else {
            const image = rasterText(o);
            await drawImage(o.id, image.dataUrl, { x: o.x, y: o.y, w: image.w, h: image.h });
          }
        }
      }
    }
    if (form) {
      try {
        form.updateFieldAppearances();
      } catch (err) {
        // For example text the built in font cannot draw: let the PDF reader draw the fields.
        console.warn(err);
        form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
      }
    }
    return out.save({ updateFieldAppearances: false });
  }

  async function save() {
    if (!state.pages.length) return;
    try {
      status('Saving...');
      const bytes = await buildPdf();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      link.download = state.name.replace(/\.pdf$/i, '') + '-edited.pdf';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      state.dirty = false;
      updateUi();
      if (saveProblems.length) fail(new Error(`Saved, but these form fields could not be written: ${saveProblems.join(', ')}`));
      else status(`Saved ${link.download}`);
    } catch (err) {
      fail(err);
    }
  }

  // ---------- wiring ----------

  $('open').addEventListener('click', () => $('file-open').click());
  $('append').addEventListener('click', () => $('file-append').click());
  $('image').addEventListener('click', () => $('file-image').click());
  $('file-open').addEventListener('change', (e) => { openFile(e.target.files[0], false); e.target.value = ''; });
  $('file-append').addEventListener('change', (e) => { openFile(e.target.files[0], true); e.target.value = ''; });
  $('file-image').addEventListener('change', (e) => { placeImage(e.target.files[0]); e.target.value = ''; });
  $('save').addEventListener('click', save);
  $('undo').addEventListener('click', () => restore(state.undo, state.redo));
  $('redo').addEventListener('click', () => restore(state.redo, state.undo));
  $('delete').addEventListener('click', deleteSelected);
  $('zoom-in').addEventListener('click', () => setScale(state.scale * 1.2));
  $('zoom-out').addEventListener('click', () => setScale(state.scale / 1.2));
  $('zoom-fit').addEventListener('click', () => fitWidth(false));
  $('page-no').addEventListener('change', (e) => goToPage(Number(e.target.value) - 1));
  $('color').addEventListener('change', (e) => applyInput('color', e.target.value, ['text', 'path', 'highlight']));
  $('size').addEventListener('change', (e) => applyInput('size', Number(e.target.value), ['text']));
  $('pen').addEventListener('change', (e) => applyInput('width', Number(e.target.value), ['path']));
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  let scrollQueued = false;
  viewer.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      if (document.activeElement !== $('page-no')) $('page-no').value = currentPage() + 1;
    });
  });

  viewer.addEventListener('dragover', (e) => { e.preventDefault(); viewer.classList.add('dragover'); });
  viewer.addEventListener('dragleave', () => viewer.classList.remove('dragover'));
  viewer.addEventListener('drop', (e) => {
    e.preventDefault();
    viewer.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.type.startsWith('image/')) placeImage(file);
    else openFile(file, false);
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') { e.preventDefault(); save(); }
    else if (mod && key === 'o') { e.preventDefault(); $('file-open').click(); }
    else if (typing) return;
    else if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); restore(state.undo, state.redo); }
    else if (mod && (key === 'y' || key === 'z')) { e.preventDefault(); restore(state.redo, state.undo); }
    else if (key === 'delete' || key === 'backspace') { e.preventDefault(); deleteSelected(); }
    else if (key === 'escape') setTool('select');
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  updateUi();

  // Used by tests/test_editor.py.
  window.minDoc = { state, loadPdf, buildPdf };
})();
