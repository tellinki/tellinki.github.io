/* Tellinki.com — map application logic */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const BOUNDS = L.latLngBounds(L.latLng(60.089, 24.459), L.latLng(60.330, 25.514));
  const DEFAULT_VIEW = { center: [60.2097412, 24.98643], zoom: 12 };
  const MIN_ZOOM = 12;
  const MAX_ZOOM = 18;

  // Live city-bike availability — CityBikes API, free, no key, CORS-enabled.
  const CITYBIKES_URL = 'https://api.citybik.es/v2/networks/citybikes-helsinki' +
    '?fields=stations.name,stations.latitude,stations.longitude,' +
    'stations.free_bikes,stations.empty_slots,stations.timestamp';
  const CITYBIKES_REFRESH_MS = 60 * 1000;

  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  const PARKING_TYPES_FI = {
    stands: 'Runkolukitusteline',
    rack: 'Runkolukitustuki',
    safe_loops: '"Safe Loop"',
    'two-tier': 'Kaksitasoinen'
  };
  const COVERED_FI = { yes: 'Kyllä', partial: 'Osittain' };
  const SERVICES_FI = {
    'service:bicycle:chain_tool':  'Ketjutyökalu',
    'service:bicycle:cleaning':    'Pesupaikka',
    'service:bicycle:diy':         'Tee-se-itse',
    'service:bicycle:pump':        'Pumppu',
    'service:bicycle:screwdriver': 'Ruuvimeisseli',
    'service:bicycle:stand':       'Teline',
    'service:bicycle:tools':       'Työkalut'
  };

  // ── Shared SVG bodies (map markers + popups) ──────────────────────────────
  const SVG = {
    water: '<circle cx="10" cy="10" r="9" fill="#0050aa"/>' +
           '<path d="M10 4.5c0 0-4.5 4.5-4.5 7a4.5 4.5 0 0 0 9 0c0-2.5-4.5-7-4.5-7z" fill="white"/>',
    mech:  '<circle cx="10" cy="10" r="9" fill="#0050aa"/>' +
           '<path d="M13.2 6.8a2.8 2.8 0 0 0-3.6 3.6L5.5 14.5l.8.8 4.1-4.1a2.8 2.8 0 0 0 3.6-3.6l-1.6 1.6-1.2-1.2 1.6-1.6z" fill="white" fill-rule="evenodd"/>',
    check: '<circle cx="6" cy="6" r="6" fill="#0050aa"/>' +
           '<path d="M3.5 6l2 2 3-3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    bike:  '<circle cx="10" cy="10" r="9" fill="#1e9e50"/>' +
           '<path d="M6 13.5a2.5 2.5 0 1 1 0-.01M14 13.5a2.5 2.5 0 1 1 0-.01M6 11l2.2-4h3.6L13 11m-2.8-5.2L9 11" stroke="white" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
  };

  // ── Small utilities ───────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function loadJSON(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} – ${url}`);
      return r.json();
    });
  }

  function svgIcon(innerSVG, size) {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">${innerSVG}</svg>`;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    return L.icon({ iconUrl: url, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function svgTag(body, size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  }

  function lineWeight(z) { return z >= 15 ? 6 : z >= 12 ? 4 : 2; }

  // Direct iD-editor link when we know the OSM element, else center on the spot.
  function osmEditUrl(props, lat, lon) {
    const id = props && typeof props.id === 'string' && props.id.includes('/')
      ? props.id.split('/') : null;
    if (id) return `https://www.openstreetmap.org/edit?editor=id&${id[0]}=${id[1]}`;
    return `https://www.openstreetmap.org/edit?editor=id#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`;
  }

  function osmDirectionsUrl(lat, lon) {
    return `https://www.openstreetmap.org/directions?to=${lat.toFixed(6)}%2C${lon.toFixed(6)}`;
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function toast(msg, ms = 6000) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.classList.remove('hidden-fade');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden-fade');
      setTimeout(() => { toastEl.hidden = true; }, 350);
    }, ms);
  }

  // ── Map ───────────────────────────────────────────────────────────────────
  // Layer visibility is encoded in the URL hash after the view, using one
  // letter per layer: #12/60.21/24.98/p,b,w  ('-' = all off, omitted = default)
  const LAYER_CODES = [
    ['p', 'parking'], ['b', 'baana'], ['w', 'water'], ['m', 'mech'], ['c', 'citybikes']
  ];
  const DEFAULT_LAYERS_ON = 'p,b';

  function viewFromHash() {
    const m = location.hash.match(
      /^#\/?(\d{1,2})\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)(?:\/([pbwmc,\-]+))?$/
    );
    if (!m) return null;
    const zoom = parseInt(m[1], 10);
    const lat = parseFloat(m[2]);
    const lng = parseFloat(m[3]);
    if (zoom < MIN_ZOOM || zoom > MAX_ZOOM || !BOUNDS.contains([lat, lng])) return null;
    const layers = m[4] === undefined
      ? null
      : new Set(m[4] === '-' ? [] : m[4].split(','));
    return { center: [lat, lng], zoom, layers };
  }

  // Segment for the current toggle states; empty when nothing differs from
  // the defaults, so plain view URLs stay short.
  function currentLayerSegment() {
    const on = [];
    for (const [code, key] of LAYER_CODES) {
      const cb = document.getElementById('toggle-' + key);
      if (cb && cb.checked) on.push(code);
    }
    const s = on.join(',');
    return s === DEFAULT_LAYERS_ON ? '' : '/' + (s || '-');
  }

  function updateHash() {
    const c = map.getCenter();
    history.replaceState(null, '',
      `#${map.getZoom()}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}${currentLayerSegment()}`);
  }

  // Flip toggles to match a set from the URL. Dispatching 'change' reuses the
  // normal handlers: row styling, add/remove, lazy city-bike fetch.
  function applyLayerState(onSet) {
    for (const [code, key] of LAYER_CODES) {
      const cb = document.getElementById('toggle-' + key);
      if (!cb) continue;
      const want = onSet.has(code);
      if (cb.checked !== want) {
        cb.checked = want;
        cb.dispatchEvent(new Event('change'));
      }
    }
  }

  const map = L.map('map', { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM });
  const start = viewFromHash() || DEFAULT_VIEW;
  map.setView(start.center, start.zoom);
  map.setMaxBounds(BOUNDS);

  const tiles = L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors, © CARTO'
  }).addTo(map);

  // Keep the view and layer state in the URL so any spot is shareable.
  map.on('moveend', updateHash);

  // Follow hash changes without a reload (e.g. user pastes a shared link).
  window.addEventListener('hashchange', () => {
    const v = viewFromHash();
    if (!v) return;
    if (v.layers) applyLayerState(v.layers);
    if (map.getZoom() !== v.zoom ||
        map.getCenter().distanceTo(L.latLng(v.center)) > 1) {
      map.setView(v.center, v.zoom);
    }
  });

  L.control.locate({
    position: 'topleft',
    strings: { title: 'Näytä sijaintini' }
  }).addTo(map);

  // ── Icons ─────────────────────────────────────────────────────────────────
  const ICONS = {
    rack:     L.icon({ iconUrl: 'images/icons/icon-rack.png',     iconSize: [32, 32], iconAnchor: [16, 16] }),
    stand:    L.icon({ iconUrl: 'images/icons/icon-stand.png',    iconSize: [32, 32], iconAnchor: [16, 16] }),
    twotier:  L.icon({ iconUrl: 'images/icons/icon-twotier.png',  iconSize: [32, 32], iconAnchor: [16, 16] }),
    safeloop: L.icon({ iconUrl: 'images/icons/icon-safeloop.png', iconSize: [32, 32], iconAnchor: [16, 16] }),
    water:    svgIcon(SVG.water, 26),
    mech:     svgIcon(SVG.mech, 26)
  };
  const ICON_MAP = {
    stands: ICONS.stand, rack: ICONS.rack,
    safe_loops: ICONS.safeloop, 'two-tier': ICONS.twotier
  };
  // Cargo-capable parking gets an orange ring around the same icon.
  const CARGO_ICON_MAP = {};
  function parkingIcon(type, isCargo) {
    if (!isCargo) return ICON_MAP[type];
    if (!CARGO_ICON_MAP[type]) {
      CARGO_ICON_MAP[type] = L.icon({ ...ICON_MAP[type].options, className: 'cargo-icon' });
    }
    return CARGO_ICON_MAP[type];
  }

  // ── Layer refs (null until loaded) ────────────────────────────────────────
  const layers = { parking: null, baana: null, water: null, mech: null, citybikes: null };

  // ── Parking ───────────────────────────────────────────────────────────────
  let parkingCluster = null;
  let parkingMarkers = [];
  let coveredOnly = false;
  let cargoOnly = false;

  function parkingPopupHTML(props, lat, lon) {
    const type = PARKING_TYPES_FI[props.bicycle_parking] || 'Pyöräpysäköinti';
    const rows = [];
    if (props.capacity != null) {
      rows.push(`<div class="popup-service">Kapasiteetti: <strong>${props.capacity}</strong></div>`);
    }
    if (props.covered) {
      rows.push(`<div class="popup-service">Katettu: <strong>${COVERED_FI[props.covered]}</strong></div>`);
    }
    if (props['capacity:cargo_bike'] != null) {
      rows.push(`<div class="popup-service">Tavarapyöräpaikat: <strong>${props['capacity:cargo_bike']}</strong></div>`);
    }
    if (props.access === 'private') {
      rows.push('<div class="popup-muted">Yksityinen paikka.</div>');
    }
    if (props.name) {
      rows.push(`<div class="popup-service">${escapeHtml(props.name)}</div>`);
    }
    return `<div class="popup-title">${svgTag(SVG.check, 16)} ${type}</div>` +
      (rows.join('') || '<span class="popup-muted">Ei lisätietoja.</span>') +
      `<div class="popup-actions">
         <a href="${osmDirectionsUrl(lat, lon)}" target="_blank" rel="noopener">Reititys</a>
         <a href="${osmEditUrl(props, lat, lon)}" target="_blank" rel="noopener">Muokkaa OSM:ssä</a>
       </div>`;
  }

  function parkingVisible(m) {
    return (!coveredOnly || m._covered) && (!cargoOnly || m._cargo);
  }

  function refreshParkingCluster() {
    if (!parkingCluster) return;
    parkingCluster.clearLayers();
    parkingCluster.addLayers(parkingMarkers.filter(parkingVisible));
  }

  function loadParking() {
    return loadJSON('parking.json').then(json => {
      parkingCluster = L.markerClusterGroup({
        maxClusterRadius: 200,
        disableClusteringAtZoom: 17,
        spiderfyOnMaxZoom: false,
        chunkedLoading: true
      });
      parkingMarkers = [];
      for (const f of json.features) {
        const p = f.properties;
        const [lon, lat] = f.geometry.coordinates;
        const icon = parkingIcon(p.bicycle_parking, p['capacity:cargo_bike'] > 0);
        if (!icon || typeof lat !== 'number' || typeof lon !== 'number') continue;
        const mark = L.marker([lat, lon], { icon });
        if (p.access === 'private') mark.setOpacity(0.5);
        mark._covered = p.covered === 'yes' || p.covered === 'partial';
        mark._cargo = p['capacity:cargo_bike'] > 0;
        if (p.capacity != null) {
          mark.bindTooltip(String(p.capacity), {
            permanent: true, direction: 'right', className: 'marker-label'
          });
        }
        mark.bindPopup(parkingPopupHTML(p, lat, lon), { maxWidth: 240 });
        parkingMarkers.push(mark);
      }
      refreshParkingCluster();
      layers.parking = parkingCluster;
      if (document.getElementById('toggle-parking').checked) map.addLayer(parkingCluster);
    }).catch(e => {
      console.warn('Parking:', e);
      toast('Pyöräpysäköintiaineiston lataus epäonnistui. Yritä päivittää sivu.');
    });
  }

  // ── Repair stations ───────────────────────────────────────────────────────
  function loadMech() {
    return loadJSON('mech.geojson').then(data => {
      const layer = L.geoJSON(data, {
        pointToLayer(feature) {
          const [lon, lat] = feature.geometry.coordinates;
          const p = feature.properties;
          const marker = L.marker(L.latLng(lat, lon), { icon: ICONS.mech });

          const rows = Object.entries(SERVICES_FI)
            .filter(([key]) => p[key] === 'yes')
            .map(([, label]) =>
              `<div class="popup-service">${svgTag(SVG.check, 12)} ${label}</div>`
            ).join('');
          const addr = [p['addr:street'], p['addr:housenumber']]
            .filter(Boolean).map(escapeHtml).join(' ');

          marker.bindPopup(
            `<div class="popup-title">${svgTag(SVG.mech, 18)} Huoltopiste</div>` +
            (p.name ? `<div class="popup-name">${escapeHtml(p.name)}</div>` : '') +
            (addr ? `<div class="popup-service">${addr}</div>` : '') +
            (rows || '<span class="popup-muted">Ei tietoja palveluista.</span>') +
            `<div class="popup-actions">
               <a href="${osmDirectionsUrl(lat, lon)}" target="_blank" rel="noopener">Reititys</a>
               <a href="${osmEditUrl(p, lat, lon)}" target="_blank" rel="noopener">Muokkaa OSM:ssä</a>
             </div>`,
            { maxWidth: 240 }
          );
          return marker;
        }
      });
      layers.mech = layer;
      // Off by default — add only if the user has already flipped the toggle
      // on while the data was still loading.
      if (document.getElementById('toggle-mech').checked) map.addLayer(layer);
    }).catch(e => {
      console.warn('Mech:', e);
      toast('Huoltopisteiden lataus epäonnistui.');
    });
  }

  // ── Water points ──────────────────────────────────────────────────────────
  function loadWater() {
    return loadJSON('water.geojson').then(data => {
      const layer = L.geoJSON(data, {
        pointToLayer(feature) {
          const [lon, lat] = feature.geometry.coordinates;
          const p = feature.properties;
          const marker = L.marker(L.latLng(lat, lon), { icon: ICONS.water });
          marker.bindPopup(
            `<div class="popup-title">${svgTag(SVG.water, 18)} Vesipiste</div>` +
            (p.name ? `<div class="popup-name">${escapeHtml(p.name)}</div>` : '') +
            (p.seasonal === 'yes' ? '<div class="popup-muted">Käytössä vain kesäisin.</div>' : '') +
            `<div class="popup-actions">
               <a href="${osmDirectionsUrl(lat, lon)}" target="_blank" rel="noopener">Reititys</a>
               <a href="${osmEditUrl(p, lat, lon)}" target="_blank" rel="noopener">Muokkaa OSM:ssä</a>
             </div>`,
            { maxWidth: 200 }
          );
          return marker;
        }
      });
      layers.water = layer;
      // Off by default — add only if the user has already flipped the toggle
      // on while the data was still loading.
      if (document.getElementById('toggle-water').checked) map.addLayer(layer);
    }).catch(e => {
      console.warn('Water:', e);
      toast('Vesipisteiden lataus epäonnistui.');
    });
  }

  // ── Pyöräbaana ────────────────────────────────────────────────────────────
  // Lines AND ref shields live in one layer group, so the legend toggle
  // shows/hides both.
  function shieldLatLng(geom) {
    const parts = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
    if (!parts || !parts.length) return null;
    const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), []);
    const mid = longest[Math.floor(longest.length / 2)];
    return mid ? L.latLng(mid[1], mid[0]) : null;
  }

  function loadBaana() {
    return loadJSON('baanat.geojson').then(data => {
      const group = L.layerGroup();
      const lines = L.geoJSON(data, {
        filter: f =>
          f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString',
        style: () => ({ color: '#EF9F27', weight: lineWeight(map.getZoom()), opacity: 1 }),
        onEachFeature(feature, layer) {
          if (feature.properties && feature.properties.name) {
            layer.bindTooltip(feature.properties.name, {
              permanent: false, direction: 'center', className: 'line-tooltip'
            });
          }
        }
      });
      group.addLayer(lines);

      for (const f of data.features) {
        const ref = f.properties && f.properties.ref;
        if (!ref) continue;
        const pos = shieldLatLng(f.geometry);
        if (!pos) continue;
        group.addLayer(L.marker(pos, {
          icon: L.divIcon({
            className: 'road-icon',
            html: `<div class="road-shield">${escapeHtml(ref)}</div>`,
            iconSize: [26, 26], iconAnchor: [13, 13]
          })
        }));
      }

      if (document.getElementById('toggle-baana').checked) group.addTo(map);
      map.on('zoomend', () => lines.setStyle({ weight: lineWeight(map.getZoom()) }));
      layers.baana = group;
    }).catch(e => {
      console.warn('Baana:', e);
      toast('Baanojen lataus epäonnistui.');
    });
  }

  // ── City bikes (live) ─────────────────────────────────────────────────────
  let cbCluster = null;
  let cbFailedOnce = false;

  function cbIcon(free) {
    const cls = free > 5 ? 'cb-ok' : free > 0 ? 'cb-low' : 'cb-empty';
    return L.divIcon({
      className: 'cb-wrap',
      html: `<div class="cb-marker ${cls}">${free}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }

  function loadCitybikes(silent) {
    return loadJSON(CITYBIKES_URL).then(d => {
      const stations = (d.network && d.network.stations) || [];
      if (!cbCluster) {
        cbCluster = L.markerClusterGroup({
          maxClusterRadius: 60,
          disableClusteringAtZoom: 16,
          chunkedLoading: true
        });
        layers.citybikes = cbCluster;
        map.addLayer(cbCluster);
      }
      cbCluster.clearLayers();
      let updated = null;
      for (const s of stations) {
        const marker = L.marker([s.latitude, s.longitude], { icon: cbIcon(s.free_bikes) });
        marker.bindPopup(
          `<div class="popup-title">${svgTag(SVG.bike, 18)} Kaupunkipyöräasema</div>
           <div class="popup-name">${escapeHtml(s.name)}</div>
           <div class="popup-service">Pyöriä vapaana: <strong>${s.free_bikes}</strong></div>
           <div class="popup-service">Paikkoja vapaana: <strong>${s.empty_slots}</strong></div>`,
          { maxWidth: 200 }
        );
        cbCluster.addLayer(marker);
        if (!updated && s.timestamp) updated = new Date(s.timestamp);
      }
      return updated;
    }).catch(e => {
      if (!silent && !cbFailedOnce) {
        cbFailedOnce = true;
        console.warn('Citybikes:', e);
        toast('Kaupunkipyörien reaaliaikatietojen lataus epäonnistui.');
      }
      return null;
    });
  }

  // Refresh availability while the layer is visible.
  setInterval(() => {
    if (cbCluster && map.hasLayer(cbCluster)) loadCitybikes(true);
  }, CITYBIKES_REFRESH_MS);

  // ── Data freshness stamp ──────────────────────────────────────────────────
  function loadMeta() {
    return loadJSON('data-meta.json').then(meta => {
      if (meta && meta.updated) {
        document.getElementById('data-updated').textContent = meta.updated;
      }
    }).catch(() => { /* keep the date baked into the HTML */ });
  }

  // ── Layer toggles ─────────────────────────────────────────────────────────
  function wireToggles() {
    [
      ['toggle-parking', 'parking', 'row-parking'],
      ['toggle-baana',   'baana',   'row-baana'],
      ['toggle-water',   'water',   'row-water'],
      ['toggle-mech',    'mech',    'row-mech']
    ].forEach(([checkId, layerKey, rowId]) => {
      const cb = document.getElementById(checkId);
      const row = document.getElementById(rowId);
      if (!cb) return;
      cb.addEventListener('change', () => {
        row.classList.toggle('layer-off', !cb.checked);
        const layer = layers[layerKey];
        if (layer) { // null = still loading; the loader checks the toggle
          if (cb.checked) {
            map.addLayer(layer);
          } else {
            map.removeLayer(layer);
          }
        }
        updateHash();
      });
    });

    // City bikes are off by default and fetched lazily on first activation.
    const cbToggle = document.getElementById('toggle-citybikes');
    const cbRow = document.getElementById('row-citybikes');
    cbToggle.addEventListener('change', async () => {
      if (cbToggle.checked) {
        cbRow.classList.remove('layer-off');
        if (layers.citybikes) {
          map.addLayer(layers.citybikes);
        } else {
          await loadCitybikes(false);
          if (!layers.citybikes) {
            // Initial fetch failed — flip the toggle back off.
            cbToggle.checked = false;
            cbRow.classList.add('layer-off');
          }
        }
      } else {
        cbRow.classList.add('layer-off');
        if (layers.citybikes) map.removeLayer(layers.citybikes);
      }
      updateHash();
    });

    const coveredCb = document.getElementById('covered-filter');
    coveredCb.addEventListener('change', () => {
      coveredOnly = coveredCb.checked;
      refreshParkingCluster();
    });

    const cargoCb = document.getElementById('cargo-filter');
    cargoCb.addEventListener('change', () => {
      cargoOnly = cargoCb.checked;
      refreshParkingCluster();
    });
  }

  // ── Legend collapse (collapsed by default on small screens) ───────────────
  const legend = document.getElementById('legend');
  const legendBtn = document.getElementById('legend-toggle');
  if (window.matchMedia('(max-width: 480px)').matches) {
    legend.classList.add('collapsed');
    legendBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleLegend() {
    const collapsed = legend.classList.toggle('collapsed');
    legendBtn.setAttribute('aria-expanded', String(!collapsed));
  }
  legendBtn.addEventListener('click', toggleLegend);
  legendBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLegend(); }
  });

  // ── Address search (Nominatim) ────────────────────────────────────────────
  const SearchControl = L.Control.extend({
    onAdd() {
      const c = L.DomUtil.create('div', 'search-control leaflet-bar');
      c.innerHTML =
        '<input id="search-input" type="search" autocomplete="off" ' +
        'placeholder="Hae osoitteella…" aria-label="Hae osoitteella">' +
        '<ul class="search-results" id="search-results" role="listbox" hidden></ul>';
      L.DomEvent.disableClickPropagation(c);
      L.DomEvent.disableScrollPropagation(c);
      return c;
    }
  });
  map.addControl(new SearchControl({ position: 'topleft' }));

  (function initSearch() {
    const input = document.getElementById('search-input');
    const list = document.getElementById('search-results');
    let debounce = null;
    let abort = null;
    let results = [];
    let resultMarker = null;

    function closeList() {
      list.hidden = true;
      list.innerHTML = '';
      results = [];
    }

    function pick(r) {
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      map.flyTo([lat, lon], 17);
      if (resultMarker) resultMarker.remove();
      resultMarker = L.circleMarker([lat, lon], {
        radius: 10, color: '#EF9F27', weight: 3, fill: false
      }).addTo(map);
      closeList();
      input.blur();
    }

    async function search(q) {
      if (abort) abort.abort();
      abort = new AbortController();
      const params = new URLSearchParams({
        format: 'jsonv2', limit: '5', countrycodes: 'fi',
        bounded: '1', 'accept-language': 'fi',
        viewbox: '24.459,60.330,25.514,60.089',
        q
      });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 8000);
      try {
        const r = await fetch(`${NOMINATIM_URL}?${params}`, { signal: abort.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        results = await r.json();
        if (!results.length) { closeList(); return; }
        list.innerHTML = results
          .map((res, i) => `<li role="option" data-i="${i}">${escapeHtml(res.display_name)}</li>`)
          .join('');
        list.hidden = false;
      } catch (e) {
        if (e.name === 'AbortError' && !timedOut) return; // superseded by a newer keystroke
        console.warn('Search:', e);
        toast('Osoitehaku ei toimi juuri nyt. Yritä myöhemmin uudelleen.');
      } finally {
        clearTimeout(timeout);
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 3) { closeList(); return; }
      debounce = setTimeout(() => search(q), 500);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && results.length) { e.preventDefault(); pick(results[0]); }
      if (e.key === 'Escape') { closeList(); input.blur(); }
    });
    list.addEventListener('click', e => {
      const li = e.target.closest('li');
      if (li) pick(results[parseInt(li.dataset.i, 10)]);
    });
    map.on('click', closeList);
  })();

  // ── Nearest parking ───────────────────────────────────────────────────────
  (function initNearest() {
    const nearestGroup = L.layerGroup();
    let nearestActive = false;
    let locating = false;
    let btn = null;

    const NearestControl = L.Control.extend({
      onAdd() {
        const bar = L.DomUtil.create('div', 'leaflet-bar');
        btn = L.DomUtil.create('button', 'nearest-btn', bar);
        btn.type = 'button';
        btn.title = 'Etsi 3 lähintä parkkipaikkaa';
        btn.setAttribute('aria-label', 'Etsi 3 lähintä parkkipaikkaa');
        btn.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="7" stroke="#0050aa" stroke-width="2"/>' +
          '<circle cx="12" cy="12" r="2.5" fill="#0050aa"/>' +
          '<path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="#0050aa" stroke-width="2" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(btn, 'click', onButtonClick);
        return bar;
      }
    });
    map.addControl(new NearestControl({ position: 'topleft' }));

    function clearNearest() {
      nearestGroup.clearLayers();
      nearestActive = false;
      btn.classList.remove('active');
    }

    function onButtonClick() {
      if (nearestActive) { clearNearest(); return; }
      if (locating) return;
      if (!parkingMarkers.length) {
        toast('Parkkiaineistoa ei ole vielä ladattu. Odota hetki.');
        return;
      }
      locating = true;
      map.locate({ setView: false, enableHighAccuracy: true, maximumAge: 30000 });
    }

    map.on('locationfound', e => {
      if (!locating) return;
      locating = false;

      const ranked = parkingMarkers
        .filter(parkingVisible) // respect the covered/cargo filters
        .map(m => ({ m, d: map.distance(e.latlng, m.getLatLng()) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);

      if (!ranked.length) {
        toast('Ei pyöräpaikkoja valituilla suodattimilla.');
        return;
      }

      nearestGroup.clearLayers();
      nearestGroup.addLayer(L.marker(e.latlng, {
        interactive: false,
        icon: L.divIcon({ className: 'nearest-wrap', html: '<div class="nearest-user"></div>', iconSize: [14, 14], iconAnchor: [7, 7] })
      }));

      const fitPoints = [e.latlng];
      ranked.forEach(({ m, d }, i) => {
        const ll = m.getLatLng();
        fitPoints.push(ll);
        const distTxt = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`;
        const hl = L.marker(ll, {
          zIndexOffset: 1000, // stay clickable above the parking marker itself
          icon: L.divIcon({
            className: 'nearest-wrap',
            html: `<div class="nearest-marker">${i + 1}</div>`,
            iconSize: [26, 26], iconAnchor: [13, 13]
          })
        });
        hl.bindPopup(
          `<div class="popup-title">${i + 1}. lähin – ${distTxt}</div>` +
          (m.getPopup() ? m.getPopup().getContent() : ''),
          { maxWidth: 240 }
        );
        nearestGroup.addLayer(hl);
      });

      nearestGroup.addTo(map);
      nearestActive = true;
      btn.classList.add('active');
      map.fitBounds(L.latLngBounds(fitPoints).pad(0.35));
      toast('3 lähintä parkkipaikkaa korostettu kartalla.');
    });

    map.on('locationerror', () => {
      if (!locating) return;
      locating = false;
      toast('Sijaintia ei saatu selville. Tarkista sijaintiluvat.');
    });
  })();

  // ── Boot: load everything, hide the overlay early ─────────────────────────
  wireToggles();
  if (start.layers) applyLayerState(start.layers); // layer state from the URL

  const tilesReady = new Promise(res => tiles.once('load', res));
  const parkingDone = loadParking();
  loadMech();
  loadWater();
  loadBaana();
  loadMeta();

  const timeout = new Promise(res => setTimeout(res, 9000));
  Promise.race([Promise.all([tilesReady, parkingDone]), timeout]).then(() => {
    const ov = document.getElementById('loading');
    ov.classList.add('hidden');
    setTimeout(() => ov.remove(), 500);
  });

  // ── Service worker ────────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();
