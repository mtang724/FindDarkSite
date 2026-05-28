/**
 * FindDarkSite — Main Application Entry Point
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { findDarkSites } from './finder.js';
import { haversineDistance, formatDistance, sqmToBortle, bortleDescription, escapeHtml, safeHttpUrl } from './utils.js';
import { categorizePOI } from './poiSearch.js';

// ─── State ───────────────────────────────────────────────────────────────
let map, searchCircle, markersGroup;
let currentResults = null;
let scanFileData = null;       // File from <input type="file"> fallback
let selectedScanData = null;   // Parsed JSON from /data/<picked>.json dropdown
let availableScans = [];       // Loaded from /data/index.json
let userLat = null, userLng = null;
let favorites = JSON.parse(localStorage.getItem('darksite-favorites') || '[]');
let activePanel = 'search'; // 'search' | 'results' | 'favorites'
let currentAbortController = null;

// ─── Config (inline — user edits this or uses config.js) ─────────────────
// Try to load from config.js, fallback to empty
let CONFIG = {
  RIDB_API_KEY: '',
};

// Try loading config dynamically. config.js is gitignored and may not exist —
// import.meta.glob returns {} if it's missing, avoiding a hard build-time error.
try {
  const configModules = import.meta.glob('../config.js');
  const loader = Object.values(configModules)[0];
  if (loader) {
    const cfg = await loader();
    if (cfg?.CONFIG) CONFIG = { ...CONFIG, ...cfg.CONFIG };
  }
} catch (e) { /* no config file, that's ok */ }

// ─── Initialize Map ──────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [39.8283, -98.5795], // Center of US
    zoom: 5,
    zoomControl: true,
    attributionControl: true,
  });

  // Dark tile layer
  const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Satellite layer (toggle)
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri',
    maxZoom: 19,
  });

  // Layer control
  L.control.layers({
    'Dark': dark,
    'Satellite': satellite,
  }, {}, { position: 'topright' }).addTo(map);

  markersGroup = L.layerGroup().addTo(map);
}

// ─── UI Element References ───────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function initUI() {
  // Radius slider
  const radiusSlider = $('#input-radius');
  const radiusValue = $('#radius-value');
  radiusSlider.addEventListener('input', () => {
    radiusValue.textContent = radiusSlider.value;
  });

  // SQM slider
  const sqmSlider = $('#input-sqm');
  const sqmValue = $('#sqm-value');
  const bortleValue = $('#bortle-value');
  sqmSlider.addEventListener('input', () => {
    const sqm = parseFloat(sqmSlider.value);
    sqmValue.textContent = sqm.toFixed(1);
    const bortle = sqmToBortle(sqm);
    bortleValue.textContent = `Bortle ${bortle}`;
    bortleValue.className = `bortle-badge bortle-${bortle}`;
  });

  // Data source toggle
  $$('input[name="data-source"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const isPrecomputed = radio.value === 'precomputed' && radio.checked;
      $('#scan-file-group').style.display = isPrecomputed ? '' : 'none';
      $('#live-options').style.display = isPrecomputed ? 'none' : '';
    });
  });

  // File upload (fallback when no scan in public/data/, or user has a custom one)
  $('#input-scan-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      scanFileData = file;
      // File upload takes precedence — clear any dropdown pick
      selectedScanData = null;
      $('#input-scan-pick').value = '';
    }
  });

  // Scan picker dropdown
  $('#input-scan-pick').addEventListener('change', async (e) => {
    const filename = e.target.value;
    if (!filename) {
      selectedScanData = null;
      return;
    }
    // Clear uploaded file so dropdown takes precedence
    scanFileData = null;
    $('#input-scan-file').value = '';
    try {
      const resp = await fetch(`/data/${encodeURIComponent(filename)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      selectedScanData = await resp.json();
    } catch (err) {
      alert(`Failed to load scan: ${err.message}`);
      e.target.value = '';
      selectedScanData = null;
    }
  });

  // Geolocate button
  $('#btn-geolocate').addEventListener('click', geolocate);

  // Search button
  $('#btn-search').addEventListener('click', startSearch);

  // Back button
  $('#btn-back').addEventListener('click', () => showPanel('search'));

  // Favorites button
  $('#btn-favorites').addEventListener('click', () => {
    showPanel('favorites');
    renderFavorites();
  });

  // Back from favorites
  $('#btn-back-fav').addEventListener('click', () => {
    showPanel(currentResults ? 'results' : 'search');
  });
}

// ─── Panel Management ────────────────────────────────────────────────────
function showPanel(name) {
  activePanel = name;
  $('#search-panel').classList.toggle('hidden', name !== 'search');
  $('#results-panel').classList.toggle('hidden', name !== 'results');
  $('#favorites-panel').classList.toggle('hidden', name !== 'favorites');
}

// ─── Geolocation ─────────────────────────────────────────────────────────
function geolocate() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      $('#input-location').value = `${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;
      map.setView([userLat, userLng], 8);

      // Add user marker
      L.marker([userLat, userLng], {
        icon: L.divIcon({
          className: 'user-marker',
          html: '<div style="width:16px;height:16px;background:#818cf8;border:3px solid white;border-radius:50%;box-shadow:0 0 12px rgba(129,140,248,0.6);"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        })
      }).addTo(map).bindPopup('📍 Your Location');
    },
    (err) => {
      alert(`Geolocation error: ${err.message}`);
    },
    { enableHighAccuracy: true }
  );
}

// ─── Search ──────────────────────────────────────────────────────────────
const SEARCH_BTN_IDLE_HTML = '<span class="btn-icon">🔭</span> Find Dark Sites';
const SEARCH_BTN_CANCEL_HTML = '<span class="btn-icon">⏹</span> Cancel Scan';

async function startSearch() {
  // If a scan is in progress, treat this click as a cancel
  if (currentAbortController) {
    currentAbortController.abort();
    return;
  }

  // Parse location
  const locInput = $('#input-location').value.trim();
  if (!locInput) {
    alert('Please enter a location or click 📍 to use your current location.');
    return;
  }

  const coords = locInput.split(',').map(s => parseFloat(s.trim()));
  if (coords.length !== 2 || isNaN(coords[0]) || isNaN(coords[1])) {
    alert('Please enter coordinates as "latitude, longitude" (e.g. 34.05, -118.24)');
    return;
  }

  userLat = coords[0];
  userLng = coords[1];

  const radiusKm = parseInt($('#input-radius').value);
  const minSqm = parseFloat($('#input-sqm').value);
  const maxResults = parseInt($('#input-max-results').value);
  const dataSource = $('input[name="data-source"]:checked').value;
  const gridStepKm = parseInt($('input[name="grid-step"]:checked')?.value || '5');

  if (dataSource === 'precomputed' && !scanFileData && !selectedScanData) {
    alert('Please pick or upload a scan data file, or switch to "Live API" mode.');
    return;
  }

  // UI state — scanning
  const searchBtn = $('#btn-search');
  searchBtn.classList.add('scanning');
  searchBtn.innerHTML = SEARCH_BTN_CANCEL_HTML;
  $('#progress-container').classList.remove('hidden');

  currentAbortController = new AbortController();

  try {
    const result = await findDarkSites({
      centerLat: userLat,
      centerLng: userLng,
      radiusKm,
      minSqm,
      maxResults,
      ridbApiKey: CONFIG.RIDB_API_KEY,
      dataSource,
      scanFile: scanFileData,
      scanData: selectedScanData,
      gridStepKm,
      signal: currentAbortController.signal,
      onProgress: (done, total, text) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        $('#progress-fill').style.width = `${pct}%`;
        $('#progress-text').textContent = text;
      },
      onStageChange: (stage, text) => {
        $('#progress-text').textContent = text;
        if (stage === 'poi-search') {
          $('#progress-fill').style.width = '0%';
        }
      }
    });

    currentResults = result;
    renderResults(result);
    renderMapMarkers(result);
    showPanel('results');
  } catch (err) {
    if (err.name === 'AbortError') {
      $('#progress-text').textContent = 'Scan cancelled.';
    } else {
      console.error('Search error:', err);
      alert(`Search failed: ${err.message}`);
    }
  } finally {
    currentAbortController = null;
    searchBtn.classList.remove('scanning');
    searchBtn.innerHTML = SEARCH_BTN_IDLE_HTML;
    $('#progress-container').classList.add('hidden');
  }
}

// ─── Render Results ──────────────────────────────────────────────────────
function renderResults({ sites, stats }) {
  // Stats
  const statsHtml = `
    <div class="stat-card">
      <div class="stat-value">${sites.length}</div>
      <div class="stat-label">Sites Found</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.sitesWithFacilities}</div>
      <div class="stat-label">With Facilities</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.bestSqm?.toFixed(1) || '—'}</div>
      <div class="stat-label">Best SQM</div>
    </div>
  `;
  $('#results-stats').innerHTML = statsHtml;

  // Results list
  const listHtml = sites.map((site, index) => renderSiteCard(site, index)).join('');
  $('#results-list').innerHTML = listHtml || '<div class="empty-state"><p>No dark sites found matching your criteria.</p></div>';

  // Attach event listeners
  document.querySelectorAll('.result-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-btn')) return; // Don't trigger on button clicks
      const idx = parseInt(card.dataset.index);
      highlightSite(idx);
    });
  });

  document.querySelectorAll('.btn-navigate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lat = btn.dataset.lat;
      const lng = btn.dataset.lng;
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`, '_blank');
    });
  });

  document.querySelectorAll('.btn-save').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      toggleFavorite(sites[idx], btn);
    });
  });

  document.querySelectorAll('.btn-satellite').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lat = btn.dataset.lat;
      const lng = btn.dataset.lng;
      window.open(`https://www.google.com/maps/@${lat},${lng},15z/data=!3m1!1e1`, '_blank');
    });
  });
}

function renderSiteCard(site, index) {
  const isSaved = favorites.some(f => f.lat === site.lat && f.lng === site.lng);
  const poisHtml = site.pois.slice(0, 5).map(poi => {
    const cat = categorizePOI(poi.types);
    return `
      <div class="poi-item">
        <span class="poi-name">${cat.icon} ${escapeHtml(poi.name)}</span>
        <span class="poi-meta">${formatDistance(poi.distanceFromSeed)}</span>
      </div>
    `;
  }).join('');

  const amenitiesHtml = Object.entries(site.amenityCounts)
    .map(([label, count]) => `<span class="amenity-tag">${label}: ${count}</span>`)
    .join('');

  const noFacilitiesWarning = !site.hasNearbyFacilities
    ? '<div class="amenity-tag" style="color:var(--accent-warning)">⚠️ No nearby facilities — may be hard to reach</div>'
    : '';

  return `
    <div class="result-card" data-index="${index}" data-lat="${site.lat}" data-lng="${site.lng}">
      <div class="card-header">
        <div class="card-sqm">
          <span class="sqm-value">${site.sqm.toFixed(1)}</span>
          <span class="bortle-badge bortle-${site.bortle}">Bortle ${site.bortle}</span>
        </div>
        <span class="card-distance">${formatDistance(site.distance)} ${site.direction}</span>
      </div>
      <div class="card-coords">${site.lat.toFixed(4)}°, ${site.lng.toFixed(4)}°</div>
      <div class="card-amenities">
        ${amenitiesHtml}
        ${noFacilitiesWarning}
      </div>
      ${site.pois.length > 0 ? `
        <div class="card-pois">
          <div class="card-pois-title">Nearby Facilities (within 8km)</div>
          ${poisHtml}
          ${site.pois.length > 5 ? `<div class="poi-item"><span class="poi-meta">...and ${site.pois.length - 5} more</span></div>` : ''}
        </div>
      ` : ''}
      <div class="card-actions">
        <button class="card-btn btn-navigate" data-lat="${site.lat}" data-lng="${site.lng}">🧭 Navigate</button>
        <button class="card-btn btn-satellite" data-lat="${site.lat}" data-lng="${site.lng}">🛰️ Satellite</button>
        <button class="card-btn btn-save ${isSaved ? 'saved' : ''}" data-index="${index}">
          ${isSaved ? '⭐ Saved' : '☆ Save'}
        </button>
      </div>
    </div>
  `;
}

// ─── Map Markers ─────────────────────────────────────────────────────────
function renderMapMarkers({ sites }) {
  markersGroup.clearLayers();

  // Search radius circle
  if (searchCircle) map.removeLayer(searchCircle);
  const radiusKm = parseInt($('#input-radius').value);
  searchCircle = L.circle([userLat, userLng], {
    radius: radiusKm * 1000,
    color: '#818cf8',
    fillColor: '#818cf8',
    fillOpacity: 0.03,
    weight: 1,
    dashArray: '8 4',
  }).addTo(map);

  // Site markers
  sites.forEach((site, index) => {
    const color = bortleColor(site.bortle);
    const marker = L.circleMarker([site.lat, site.lng], {
      radius: 8,
      color: color,
      fillColor: color,
      fillOpacity: 0.7,
      weight: 2,
    }).addTo(markersGroup);

    marker.bindPopup(`
      <div class="popup-title">Dark Sky Site #${index + 1}</div>
      <div class="popup-sqm">SQM ${site.sqm.toFixed(1)} · Bortle ${site.bortle}</div>
      <div>${formatDistance(site.distance)} ${site.direction}</div>
      <div>${site.pois.length} nearby facilities</div>
      <a class="popup-link" href="https://www.google.com/maps/dir/?api=1&destination=${site.lat},${site.lng}&travelmode=driving" target="_blank">🧭 Navigate here</a>
      <br>
      <a class="popup-link" href="https://www.google.com/maps/@${site.lat},${site.lng},15z/data=!3m1!1e1" target="_blank">🛰️ View satellite</a>
    `);

    // POI markers (smaller)
    site.pois.forEach(poi => {
      const cat = categorizePOI(poi.types);
      const poiMarker = L.marker([poi.lat, poi.lng], {
        icon: L.divIcon({
          className: 'poi-marker',
          html: `<div style="font-size:14px;text-align:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))">${cat.icon}</div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        })
      }).addTo(markersGroup);

      const reservationHref = safeHttpUrl(poi.reservationUrl);
      poiMarker.bindPopup(`
        <div class="popup-title">${cat.icon} ${escapeHtml(poi.name)}</div>
        <div>${escapeHtml(poi.address || '')}</div>
        ${poi.rating ? `<div>⭐ ${escapeHtml(poi.rating)}</div>` : ''}
        ${reservationHref ? `<div><a class="popup-link" href="${escapeHtml(reservationHref)}" target="_blank" rel="noopener noreferrer">📋 Reserve</a></div>` : ''}
        <a class="popup-link" href="https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lng}&travelmode=driving" target="_blank" rel="noopener noreferrer">🧭 Navigate</a>
      `);
    });
  });

  // Fit map to results
  if (sites.length > 0) {
    const bounds = L.latLngBounds(sites.map(s => [s.lat, s.lng]));
    bounds.extend([userLat, userLng]);
    map.fitBounds(bounds, { padding: [50, 50] });
  }
}

function bortleColor(bortle) {
  const colors = {
    1: '#16213e', 2: '#16213e', 3: '#0f4c75',
    4: '#1b9aaa', 5: '#4ecdc4', 6: '#f7dc6f',
    7: '#f0932b', 8: '#eb4d4b', 9: '#ff6b6b'
  };
  return colors[bortle] || '#818cf8';
}

function highlightSite(index) {
  if (!currentResults) return;
  const site = currentResults.sites[index];

  // Scroll card into view
  const card = document.querySelector(`.result-card[data-index="${index}"]`);
  document.querySelectorAll('.result-card').forEach(c => c.classList.remove('active'));
  card?.classList.add('active');

  // Pan map to site
  map.setView([site.lat, site.lng], 12);
}

// ─── Favorites ───────────────────────────────────────────────────────────
function toggleFavorite(site, btn) {
  const idx = favorites.findIndex(f => f.lat === site.lat && f.lng === site.lng);
  if (idx >= 0) {
    favorites.splice(idx, 1);
    btn.classList.remove('saved');
    btn.innerHTML = '☆ Save';
  } else {
    favorites.push({
      lat: site.lat,
      lng: site.lng,
      sqm: site.sqm,
      bortle: site.bortle,
      distance: site.distance,
      direction: site.direction,
      pois: site.pois.slice(0, 3), // Save top 3 POIs
      savedAt: new Date().toISOString(),
    });
    btn.classList.add('saved');
    btn.innerHTML = '⭐ Saved';
  }
  localStorage.setItem('darksite-favorites', JSON.stringify(favorites));
}

function renderFavorites() {
  if (favorites.length === 0) {
    $('#favorites-list').innerHTML = '';
    $('#favorites-empty').classList.remove('hidden');
    return;
  }

  $('#favorites-empty').classList.add('hidden');

  const html = favorites.map((fav, index) => `
    <div class="result-card" data-lat="${fav.lat}" data-lng="${fav.lng}">
      <div class="card-header">
        <div class="card-sqm">
          <span class="sqm-value">${fav.sqm.toFixed(1)}</span>
          <span class="bortle-badge bortle-${fav.bortle}">Bortle ${fav.bortle}</span>
        </div>
        <span class="card-distance">${fav.distance ? formatDistance(fav.distance) : ''} ${fav.direction || ''}</span>
      </div>
      <div class="card-coords">${fav.lat.toFixed(4)}°, ${fav.lng.toFixed(4)}°</div>
      ${fav.pois?.length > 0 ? `
        <div class="card-pois">
          ${fav.pois.map(poi => `<div class="poi-item"><span class="poi-name">${escapeHtml(poi.name)}</span></div>`).join('')}
        </div>
      ` : ''}
      <div class="card-actions">
        <button class="card-btn btn-navigate" data-lat="${fav.lat}" data-lng="${fav.lng}">🧭 Navigate</button>
        <button class="card-btn btn-delete" data-fav-index="${index}">🗑️ Remove</button>
      </div>
    </div>
  `).join('');

  $('#favorites-list').innerHTML = html;

  // Delete handlers
  document.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.favIndex);
      favorites.splice(idx, 1);
      localStorage.setItem('darksite-favorites', JSON.stringify(favorites));
      renderFavorites();
    });
  });

  // Navigate handlers (favorites)
  document.querySelectorAll('#favorites-list .btn-navigate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lat = btn.dataset.lat;
      const lng = btn.dataset.lng;
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`, '_blank', 'noopener,noreferrer');
    });
  });

  // Card click → pan map
  document.querySelectorAll('#favorites-list .result-card').forEach(card => {
    card.addEventListener('click', () => {
      const lat = parseFloat(card.dataset.lat);
      const lng = parseFloat(card.dataset.lng);
      map.setView([lat, lng], 12);
    });
  });
}

// ─── Scan Discovery ──────────────────────────────────────────────────────
async function loadScanIndex() {
  try {
    const resp = await fetch('/data/index.json');
    if (!resp.ok) return;
    const data = await resp.json();
    availableScans = data.scans || [];
  } catch {
    availableScans = [];
  }

  const select = $('#input-scan-pick');
  if (availableScans.length === 0) {
    select.innerHTML = '<option value="">— None available —</option>';
    return;
  }

  select.innerHTML = '<option value="">— Select a scan —</option>' +
    availableScans.map(s => {
      const date = s.lastUpdated ? new Date(s.lastUpdated).toISOString().slice(0, 10) : '—';
      const label = `${s.centerLat?.toFixed(2)}, ${s.centerLng?.toFixed(2)} · ${s.radiusKm}km @ ${s.stepKm}km · ${date}`;
      return `<option value="${escapeHtml(s.filename)}">${escapeHtml(label)}</option>`;
    }).join('');
}

// ─── Initialize ──────────────────────────────────────────────────────────
initMap();
initUI();
loadScanIndex();
