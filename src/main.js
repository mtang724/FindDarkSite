/**
 * FindDarkSite — Main Application Entry Point
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { findDarkSites } from './finder.js';
import { haversineDistance, formatDistance, sqmToBortle, bortleDescription, escapeHtml, safeHttpUrl } from './utils.js';
import { categorizePOI } from './poiSearch.js';
import { moonSummary, darknessWindow, formatLocalTime } from './astronomy.js';
import { bestNight } from './weather.js';
import { formatDriveTime } from './routing.js';
import { exportFavorites, importFavorites, siteShareUrl, parseSharedSite, copyToClipboard } from './sharing.js';

// ─── State ───────────────────────────────────────────────────────────────
let map, searchCircle, markersGroup;
let siteMarkers = [];       // Leaflet markers indexed by site position in currentResults.sites
let activeSiteIndex = null;
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

  // Min-elevation slider
  const elevSlider = $('#input-min-elev');
  const elevValue = $('#elev-value');
  elevSlider.addEventListener('input', () => {
    elevValue.textContent = elevSlider.value;
  });

  // Re-pick scan + recompute moon when user edits location text
  $('#input-location').addEventListener('change', () => {
    const parsed = parseLocationInput();
    if (parsed) {
      userLat = parsed[0];
      userLng = parsed[1];
      updateMoonChip();
      autoSelectScan();
    }
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

  // Export favorites
  $('#btn-export-fav').addEventListener('click', () => {
    if (favorites.length === 0) {
      showToast('Nothing to export yet — save some sites first.');
      return;
    }
    exportFavorites(favorites);
    showToast(`Exported ${favorites.length} site${favorites.length === 1 ? '' : 's'}.`);
  });

  // Import favorites
  $('#input-import-fav').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { added, skipped, favorites: merged } = await importFavorites(file, favorites);
      favorites = merged;
      localStorage.setItem('darksite-favorites', JSON.stringify(favorites));
      renderFavorites();
      showToast(`Imported ${added} new, ${skipped} skipped.`);
    } catch (err) {
      showToast(`Import failed: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────
function parseLocationInput() {
  const loc = $('#input-location').value.trim();
  if (!loc) return null;
  const parts = loc.split(',').map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || !isFinite(parts[0]) || !isFinite(parts[1])) return null;
  return parts;
}

let toastTimer = null;
function showToast(text) {
  let toast = document.getElementById('toast');
  if (toast) toast.remove();
  toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = 'toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 2700);
}

// ─── Moon Chip ───────────────────────────────────────────────────────────
function updateMoonChip() {
  // Use user's coords if available, else map center (US default)
  const lat = userLat ?? 39.8283;
  const lng = userLng ?? -98.5795;
  const m = moonSummary(lat, lng);
  $('#moon-icon').textContent = m.phaseIcon;
  const pct = Math.round(m.illumination * 100);
  let text = `${m.phaseName} · ${pct}%`;
  if (m.moonset && m.moonrise && m.moonset < m.moonrise) {
    text += ` · sets ${formatLocalTime(m.moonset)}`;
  } else if (m.moonrise) {
    text += ` · rises ${formatLocalTime(m.moonrise)}`;
  }
  $('#moon-text').textContent = text;
  $('#moon-chip').title = `${m.phaseName} (${pct}% illuminated)\n` +
    `Moonrise: ${formatLocalTime(m.moonrise)}\nMoonset: ${formatLocalTime(m.moonset)}\n` +
    `Sunset: ${formatLocalTime(m.sunset)}\nSunrise: ${formatLocalTime(m.sunrise)}`;
}

// ─── Auto-Select Scan ────────────────────────────────────────────────────
async function autoSelectScan() {
  if (userLat == null || userLng == null) return;
  if (!availableScans.length) return;
  // Don't override an explicit user pick
  if ($('#input-scan-pick').value && selectedScanData) return;

  // Find the closest scan whose coverage circle contains the user
  let best = null;
  let bestDist = Infinity;
  for (const scan of availableScans) {
    const d = haversineDistance(userLat, userLng, scan.centerLat, scan.centerLng);
    if (d <= scan.radiusKm && d < bestDist) {
      bestDist = d;
      best = scan;
    }
  }
  if (!best) return;

  const select = $('#input-scan-pick');
  if (select.value === best.filename) return; // already selected
  select.value = best.filename;
  try {
    const resp = await fetch(`/data/${encodeURIComponent(best.filename)}`);
    if (resp.ok) {
      selectedScanData = await resp.json();
      showToast(`Auto-selected scan: ${best.filename}`);
    }
  } catch { /* ignore */ }
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

      updateMoonChip();
      autoSelectScan();
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
  const minElevationM = parseInt($('#input-min-elev').value) || 0;
  const enrichWeather = $('#opt-weather').checked;
  const enrichDriving = $('#opt-driving').checked;

  updateMoonChip();

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
      minElevationM,
      enrichWeather,
      enrichDriving,
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

  document.querySelectorAll('#results-list .btn-share').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      const site = sites[idx];
      const url = siteShareUrl(site);
      const ok = await copyToClipboard(url);
      showToast(ok ? '🔗 Share link copied!' : '🔗 Copy failed — link shown in console');
      if (!ok) console.log('Share URL:', url);
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

  // Meta row: elevation + drive time
  const metaParts = [];
  if (site.elevationM != null) {
    metaParts.push(`<span class="card-meta-item">⛰️ <strong>${Math.round(site.elevationM)} m</strong></span>`);
  }
  if (site.driving) {
    metaParts.push(`<span class="card-meta-item">🚗 <strong>${formatDriveTime(site.driving.durationSec)}</strong> drive · ${Math.round(site.driving.distanceKm)} km</span>`);
  }
  const metaHtml = metaParts.length
    ? `<div class="card-meta">${metaParts.join('')}</div>`
    : '';

  // Weather forecast strip
  const forecastHtml = renderForecast(site.forecast);

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
      ${metaHtml}
      ${forecastHtml}
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
        <button class="card-btn btn-share" data-index="${index}">🔗 Share</button>
        <button class="card-btn btn-save ${isSaved ? 'saved' : ''}" data-index="${index}">
          ${isSaved ? '⭐ Saved' : '☆ Save'}
        </button>
      </div>
    </div>
  `;
}

function renderForecast(nights) {
  if (!nights || nights.length === 0) return '';
  const best = bestNight(nights);
  const cells = nights.map(n => {
    const cc = n.cloudCover;
    const tone = cc == null ? '' : cc < 30 ? 'fc-good' : cc < 70 ? 'fc-ok' : 'fc-bad';
    const dayLabel = new Date(n.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
    const isBest = best && n.date === best.date && nights.length > 1;
    return `
      <div class="forecast-night ${isBest ? 'fn-best' : ''}" title="${escapeHtml(n.date)} · ${cc ?? '—'}% cloud · ${n.precipProb ?? 0}% precip">
        <div class="fn-day">${escapeHtml(dayLabel)}</div>
        <div class="fn-cloud ${tone}">${cc == null ? '—' : cc + '%'}</div>
        <div>${n.precipProb != null && n.precipProb > 20 ? '💧' + n.precipProb + '%' : '☁️'}</div>
      </div>
    `;
  }).join('');
  return `<div class="card-forecast" title="7-night cloud-cover forecast — best night highlighted">${cells}</div>`;
}

// ─── Map Markers ─────────────────────────────────────────────────────────
function renderMapMarkers({ sites }) {
  markersGroup.clearLayers();
  siteMarkers = [];
  activeSiteIndex = null;

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
    siteMarkers[index] = marker;

    // Clicking the marker should also activate the matching card
    marker.on('click', () => highlightSite(index, { fromMarker: true }));

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

function highlightSite(index, { fromMarker = false } = {}) {
  if (!currentResults) return;
  const site = currentResults.sites[index];
  if (!site) return;

  // 1. Card state
  const card = document.querySelector(`.result-card[data-index="${index}"]`);
  document.querySelectorAll('.result-card').forEach(c => c.classList.remove('active'));
  card?.classList.add('active');
  if (fromMarker) card?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // 2. Reset previously-active marker, emphasize the new one
  if (activeSiteIndex != null && siteMarkers[activeSiteIndex]) {
    const prev = siteMarkers[activeSiteIndex];
    const prevColor = bortleColor(currentResults.sites[activeSiteIndex].bortle);
    prev.setStyle({ radius: 8, weight: 2, color: prevColor, fillOpacity: 0.7 });
  }
  const marker = siteMarkers[index];
  if (marker) {
    marker.setStyle({
      radius: 14,
      weight: 4,
      color: '#a5b4fc',
      fillOpacity: 0.9,
    });
    marker.bringToFront();

    // Pulse ring — short-lived overlay so the eye catches the spot
    const pulse = L.circleMarker([site.lat, site.lng], {
      radius: 18,
      color: '#a5b4fc',
      fillColor: '#a5b4fc',
      fillOpacity: 0.25,
      weight: 2,
    }).addTo(markersGroup);
    let r = 18;
    const tick = setInterval(() => {
      r += 4;
      pulse.setRadius(r);
      pulse.setStyle({ fillOpacity: Math.max(0, 0.25 - (r - 18) / 80) });
      if (r > 50) {
        clearInterval(tick);
        markersGroup.removeLayer(pulse);
      }
    }, 50);
  }
  activeSiteIndex = index;

  // 3. Open the popup and pan map
  if (marker && !fromMarker) marker.openPopup();
  // Use panTo (not setView) so we keep the user's zoom level
  map.panTo([site.lat, site.lng], { animate: true });
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
      elevationM: site.elevationM ?? null,
      driving: site.driving || null,
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

  const html = favorites.map((fav, index) => {
    const metaParts = [];
    if (fav.elevationM != null) {
      metaParts.push(`<span class="card-meta-item">⛰️ <strong>${Math.round(fav.elevationM)} m</strong></span>`);
    }
    if (fav.driving) {
      metaParts.push(`<span class="card-meta-item">🚗 <strong>${formatDriveTime(fav.driving.durationSec)}</strong></span>`);
    }
    const metaHtml = metaParts.length ? `<div class="card-meta">${metaParts.join('')}</div>` : '';

    return `
    <div class="result-card" data-lat="${fav.lat}" data-lng="${fav.lng}">
      <div class="card-header">
        <div class="card-sqm">
          <span class="sqm-value">${fav.sqm.toFixed(1)}</span>
          <span class="bortle-badge bortle-${fav.bortle}">Bortle ${fav.bortle}</span>
        </div>
        <span class="card-distance">${fav.distance ? formatDistance(fav.distance) : ''} ${fav.direction || ''}</span>
      </div>
      <div class="card-coords">${fav.lat.toFixed(4)}°, ${fav.lng.toFixed(4)}°</div>
      ${metaHtml}
      ${fav.pois?.length > 0 ? `
        <div class="card-pois">
          ${fav.pois.map(poi => `<div class="poi-item"><span class="poi-name">${escapeHtml(poi.name)}</span></div>`).join('')}
        </div>
      ` : ''}
      <div class="card-actions">
        <button class="card-btn btn-navigate" data-lat="${fav.lat}" data-lng="${fav.lng}">🧭 Navigate</button>
        <button class="card-btn btn-share" data-fav-index="${index}">🔗 Share</button>
        <button class="card-btn btn-delete" data-fav-index="${index}">🗑️ Remove</button>
      </div>
    </div>
  `;
  }).join('');

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

  // Share handlers (favorites)
  document.querySelectorAll('#favorites-list .btn-share').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.favIndex);
      const url = siteShareUrl(favorites[idx]);
      const ok = await copyToClipboard(url);
      showToast(ok ? '🔗 Share link copied!' : '🔗 Copy failed — link shown in console');
      if (!ok) console.log('Share URL:', url);
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

// ─── Shared Site (URL hash) ──────────────────────────────────────────────
function handleSharedSiteHash() {
  const shared = parseSharedSite();
  if (!shared) return;
  userLat = userLat ?? shared.lat;
  userLng = userLng ?? shared.lng;
  $('#input-location').value = `${shared.lat.toFixed(4)}, ${shared.lng.toFixed(4)}`;
  map.setView([shared.lat, shared.lng], 11);

  const sqmLabel = shared.sqm != null ? `SQM ${shared.sqm.toFixed(1)} · Bortle ${sqmToBortle(shared.sqm)}` : '';
  L.marker([shared.lat, shared.lng], {
    icon: L.divIcon({
      className: 'shared-marker',
      html: '<div style="font-size:24px;filter:drop-shadow(0 0 6px rgba(129,140,248,0.8));">🔭</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
  }).addTo(map).bindPopup(`<div class="popup-title">🔗 Shared Dark Site</div>${sqmLabel ? `<div class="popup-sqm">${sqmLabel}</div>` : ''}<a class="popup-link" href="https://www.google.com/maps/dir/?api=1&destination=${shared.lat},${shared.lng}&travelmode=driving" target="_blank" rel="noopener">🧭 Navigate</a>`).openPopup();
  updateMoonChip();
}

// ─── Initialize ──────────────────────────────────────────────────────────
initMap();
initUI();
updateMoonChip();
loadScanIndex().then(() => {
  // Both `handleSharedSiteHash` and `autoSelectScan` may depend on the scan list
  handleSharedSiteHash();
  autoSelectScan();
});
