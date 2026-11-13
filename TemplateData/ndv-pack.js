// Builds a .unitypackage in the browser when the user presses Download.
//
// A .unitypackage is a gzip-compressed tar with one folder per asset, named by the asset GUID:
//   <guid>/asset        the file itself (folders have none)
//   <guid>/asset.meta   its .meta (GUID + import settings)
//   <guid>/pathname     "Assets/..." path
// The build (NDVVFXWebPackages.cs) copies every asset once to assets/<guid>/ and writes vfx-deps.json
// (effect id -> GUIDs it depends on, same list as Unity's ExportPackage + IncludeDependencies).
(function () {
  'use strict';

  var enc = new TextEncoder();
  var depsPromise = null;

  function loadDeps() {
    if (!depsPromise) {
      depsPromise = fetch('vfx-deps.json').then(function (r) {
        if (!r.ok) throw new Error('vfx-deps.json: HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        d.byId = {};
        d.effects.forEach(function (e) { d.byId[e.id] = e; });
        d.isFolder = {};
        d.folders.forEach(function (i) { d.isFolder[i] = true; });
        return d;
      });
      depsPromise.catch(function () { depsPromise = null; }); // allow a retry
    }
    return depsPromise;
  }

  function fetchBytes(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
  }

  // ---------------------------------------------------------------- tar (ustar)

  function octal(n, width) { // width digits, then NUL
    var s = n.toString(8);
    while (s.length < width) s = '0' + s;
    return s + '\0';
  }

  function header(name, size, type) {
    var h = new Uint8Array(512);
    function put(str, offset, len) {
      var b = enc.encode(str);
      h.set(b.subarray(0, len), offset);
    }
    put(name, 0, 100);
    put(octal(type === '5' ? 493 : 420, 6), 100, 8);  // mode 0755 / 0644
    put(octal(0, 6), 108, 8);                          // uid
    put(octal(0, 6), 116, 8);                          // gid
    put(octal(size, 11), 124, 12);                     // size
    put(octal(Math.floor(Date.now() / 1000), 11), 136, 12); // mtime
    put('        ', 148, 8);                           // checksum placeholder (spaces)
    put(type, 156, 1);                                 // '0' file, '5' directory
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    var sum = 0;
    for (var i = 0; i < 512; i++) sum += h[i];
    put(octal(sum, 6) + ' ', 148, 8);
    return h;
  }

  function addFile(parts, name, data) {
    parts.push(header(name, data.length, '0'), data);
    var pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }

  // ---------------------------------------------------------------- package

  // Fetch the files of every GUID (a few at a time).
  function fetchAssets(deps, indices, onProgress) {
    var results = new Array(indices.length);
    var next = 0, done = 0;
    function worker() {
      if (next >= indices.length) return Promise.resolve();
      var slot = next++;
      var idx = indices[slot];
      var guid = deps.guids[idx];
      var base = 'assets/' + guid + '/';
      var folder = !!deps.isFolder[idx];
      return Promise.all([
        fetchBytes(base + 'asset.meta'),
        fetchBytes(base + 'pathname'),
        folder ? Promise.resolve(null) : fetchBytes(base + 'asset'),
      ]).then(function (f) {
        results[slot] = { guid: guid, meta: f[0], pathname: f[1], asset: f[2] };
        done++;
        if (onProgress) onProgress(done, indices.length);
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(8, indices.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  function build(id, onProgress) {
    if (typeof CompressionStream === 'undefined')
      return Promise.reject(new Error('This browser cannot build packages (no CompressionStream). Use a recent Chrome, Edge, Firefox or Safari.'));
    return loadDeps().then(function (deps) {
      var fx = deps.byId[id];
      if (!fx) throw new Error('Unknown effect: ' + id);
      return fetchAssets(deps, fx.g, onProgress).then(function (assets) {
        var parts = [];
        assets.forEach(function (a) {
          parts.push(header(a.guid + '/', 0, '5'));
          if (a.asset) addFile(parts, a.guid + '/asset', a.asset);
          addFile(parts, a.guid + '/asset.meta', a.meta);
          addFile(parts, a.guid + '/pathname', a.pathname);
        });
        parts.push(new Uint8Array(1024)); // end of archive
        var gz = new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'));
        return new Response(gz).blob();
      }).then(function (blob) {
        return { blob: blob, file: fx.file, count: fx.g.length };
      });
    });
  }

  // ---------------------------------------------------------------- UI

  var toastEl = null, toastTimer = 0;
  function toast(text, error) {
    if (typeof document === 'undefined') return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;right:16px;top:16px;z-index:10;padding:10px 14px;border-radius:6px;' +
        'font:600 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;max-width:60vw;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;transition:opacity .3s';
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.style.background = error ? '#b3261e' : '#2b2f3a';
    toastEl.style.opacity = '1';
    if (text.indexOf('...') < 0) toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, error ? 6000 : 2500);
  }

  var busy = false;
  function download(id, fileName) {
    if (busy) return;
    busy = true;
    toast('Packing ' + (fileName || id) + '...');
    build(id, function (done, total) { toast('Packing ' + (fileName || id) + '... ' + done + '/' + total); })
      .then(function (r) {
        var url = URL.createObjectURL(r.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName || r.file;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        toast('Downloaded ' + a.download + ' (' + r.count + ' assets, ' + (r.blob.size / 1024).toFixed(0) + ' KB)');
      })
      .catch(function (e) { toast('Download failed: ' + e.message, true); })
      .then(function () { busy = false; });
  }

  var api = { download: download, build: build };
  if (typeof window !== 'undefined') window.NDVPack = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
