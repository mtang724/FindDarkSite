/**
 * FindDarkSite — Main Application Entry Point
 */

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { findDarkSites } from './finder.js';
import { haversineDistance, formatDistance, sqmToBortle, bortleDescription, escapeHtml, safeHttpUrl } from './utils.js';
import { categorizePOI, searchNearbyPOIsBatch } from './poiSearch.js';
import { moonSummary, darknessWindow, formatLocalTime } from './astronomy.js';
import { bestNight } from './weather.js';
import { formatDriveTime } from './routing.js';
import { nightScore, rankSiteNights } from './scoring.js';
import { renderHorizonSvg } from './horizon.js';
import { exportFavorites, importFavorites, siteShareUrl, parseSharedSite, copyToClipboard } from './sharing.js';

// ─── State ───────────────────────────────────────────────────────────────
let map, searchCircle, markersGroup;
let siteMarkers = [];       // Leaflet markers indexed by site position in currentResults.sites
let activeSiteIndex = null;
let currentResults = null;
let scanFileData = null;       // File from <input type="file"> fallback
let selectedScanData = null;   // Parsed JSON from /data/<picked>.json dropdown
let availableScans = [];       // Loaded from /data/index.json
let autoSelectedScan = null;   // The scan metadata picked by autoSelectScan, for the indicator
let userLat = null, userLng = null;
let favorites = JSON.parse(localStorage.getItem('darksite-favorites') || '[]');
let activePanel = 'search'; // 'search' | 'results' | 'favorites'
let resultsView = 'sites';  // 'sites' | 'nights'
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

  // Max-horizon slider
  const horSlider = $('#input-max-horizon');
  const horValue = $('#horizon-value');
  horSlider.addEventListener('input', () => {
    const v = parseInt(horSlider.value);
    horValue.textContent = v === 0 ? 'off' : `${v}°`;
  });

  // Re-pick scan + recompute moon when user edits location text
  $('#input-location').addEventListener('change', () => {
    const parsed = parseLocationInput();
    if (parsed) {
      userLat = parsed[0];
      userLng = parsed[1];
      updateMoonChip();
      autoSelectScan({ force: true });
    }
  });

  // Live API toggle (Advanced) — only relevant for areas outside CONUS
  $('#opt-live-scan').addEventListener('change', (e) => {
    $('#live-options').style.display = e.target.checked ? '' : 'none';
    updateSourceIndicator();
  });

  // File upload (Advanced) — overrides dropdown when set
  $('#input-scan-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      scanFileData = file;
      selectedScanData = null;
      $('#input-scan-pick').value = '__auto__';
      updateSourceIndicator();
    }
  });

  // Scan picker dropdown — '__auto__' means "let the app decide based on location"
  $('#input-scan-pick').addEventListener('change', async (e) => {
    const filename = e.target.value;
    // Clear uploaded file when user picks something explicit
    if (filename) {
      scanFileData = null;
      $('#input-scan-file').value = '';
    }
    if (!filename || filename === '__auto__') {
      selectedScanData = null;
      await autoSelectScan({ force: true });
      return;
    }
    try {
      const resp = await fetch(`/data/${encodeURIComponent(filename)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      selectedScanData = await resp.json();
      updateSourceIndicator();
    } catch (err) {
      alert(`Failed to load scan: ${err.message}`);
      e.target.value = '__auto__';
      selectedScanData = null;
      updateSourceIndicator();
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

function updateSourceIndicator() {
  const el = $('#source-indicator');
  if (!el) return;
  if ($('#opt-live-scan')?.checked) {
    el.classList.remove('warn');
    el.textContent = '🔴 Live API — will scan a fresh grid via the lightpollutionmap.info WMS (slow).';
    return;
  }
  if (scanFileData) {
    el.classList.remove('warn');
    el.textContent = `📂 Custom file: ${scanFileData.name}`;
    return;
  }
  const select = $('#input-scan-pick');
  const v = select?.value;
  if (v && v !== '__auto__') {
    const scan = availableScans.find(s => s.filename === v);
    el.classList.remove('warn');
    el.textContent = `✓ ${sourceLabel(scan)} (manual pick)`;
    return;
  }
  // Auto mode
  if (autoSelectedScan && selectedScanData) {
    el.classList.remove('warn');
    el.textContent = `✨ Auto: ${sourceLabel(autoSelectedScan)}`;
    return;
  }
  if (userLat == null || userLng == null) {
    el.classList.remove('warn');
    el.textContent = '✨ Auto — pick a location to lock in a source.';
    return;
  }
  el.classList.add('warn');
  el.textContent = '⚠️ No scan covers this location. Enable Live API in Advanced.';
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
function scanCoversLocation(scan, lat, lng) {
  const bbox = scanBbox(scan);
  if (bbox) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
  }
  // Centered scan: inside circular coverage
  if (scan.centerLat != null && scan.centerLng != null && scan.radiusKm != null) {
    return haversineDistance(lat, lng, scan.centerLat, scan.centerLng) <= scan.radiusKm;
  }
  return false;
}

// Lower = preferred. WorldAtlas resolves Bortle 1/2/3 so it should beat VIIRS
// when both cover the same point. National bbox scans get a slight penalty so
// a focused regional scan covering the same point is preferred (smaller payload).
function sourcePreference(scan) {
  let pref = 0;
  const tag = scanSourceTag(scan);
  if (tag.includes('WorldAtlas')) pref -= 50;   // prefer WorldAtlas
  if (scanBbox(scan)) pref += 30;               // mild penalty for national
  return pref;
}

function sourceLabel(scan) {
  if (!scan) return '';
  const tag = scanSourceTag(scan);
  const bbox = scanBbox(scan);
  if (bbox) return `${tag} National CONUS`;
  if (scan.centerLat != null) return `${tag} ${scan.centerLat.toFixed(2)}, ${scan.centerLng.toFixed(2)} · ${scan.radiusKm}km`;
  return `${tag} ${scan.filename}`;
}

function scanScore(scan, lat, lng) {
  // Lower = better. Centered scans beat national bbox scans because they're
  // already filtered to the right area (smaller payload, faster pipeline).
  if (scan.centerLat != null && scan.centerLng != null) {
    return haversineDistance(lat, lng, scan.centerLat, scan.centerLng);
  }
  const bbox = scanBbox(scan);
  if (bbox) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const cLng = (minLng + maxLng) / 2;
    const cLat = (minLat + maxLat) / 2;
    // Penalise bbox scans slightly so a focused centered scan covering the same
    // point is preferred (faster + less memory).
    return haversineDistance(lat, lng, cLat, cLng) + 10000;
  }
  return Infinity;
}

async function autoSelectScan({ force = false, silent = false } = {}) {
  if (!availableScans.length) {
    updateSourceIndicator();
    return;
  }
  const select = $('#input-scan-pick');
  // Honour an explicit non-Auto user pick unless asked to recompute
  if (!force && select.value && select.value !== '__auto__' && selectedScanData) return;

  // Score candidates that cover the user's location (if known). When the user
  // hasn't entered a location yet, fall back to the broadest available scan.
  let best = null;
  if (userLat != null && userLng != null) {
    let bestScore = Infinity;
    for (const scan of availableScans) {
      if (!scanCoversLocation(scan, userLat, userLng)) continue;
      const score = scanScore(scan, userLat, userLng) + sourcePreference(scan);
      if (score < bestScore) {
        bestScore = score;
        best = scan;
      }
    }
  }
  // No covering scan — prefer the national WorldAtlas/VIIRS bbox if either exists
  if (!best) {
    best = availableScans.find(s => scanBbox(s) && /worldatlas/i.test(s.filename))
        || availableScans.find(s => scanBbox(s))
        || null;
  }

  if (!best) {
    updateSourceIndicator();
    return;
  }

  try {
    const resp = await fetch(`/data/${encodeURIComponent(best.filename)}`);
    if (resp.ok) {
      selectedScanData = await resp.json();
      autoSelectedScan = best;
      // Keep the dropdown on "Auto" so the user knows the pick is automatic
      if (select.value !== '__auto__') select.value = '__auto__';
      updateSourceIndicator();
      if (!silent) showToast(`Source: ${sourceLabel(best)}`);
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
      autoSelectScan({ force: true });
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
  const useLive = $('#opt-live-scan').checked;
  const dataSource = useLive ? 'live' : 'precomputed';
  const gridStepKm = parseInt($('input[name="grid-step"]:checked')?.value || '5');
  const minElevationM = parseInt($('#input-min-elev').value) || 0;
  const maxHorizonDeg = parseInt($('#input-max-horizon').value) || 0;
  const enrichWeather = $('#opt-weather').checked;
  const enrichDriving = $('#opt-driving').checked;
  const enrichHorizon = $('#opt-horizon').checked;

  updateMoonChip();

  // Auto mode: if no scan is picked yet, try to pick one for this location
  if (dataSource === 'precomputed' && !scanFileData && !selectedScanData) {
    await autoSelectScan({ force: true });
  }

  if (dataSource === 'precomputed' && !scanFileData && !selectedScanData) {
    alert('No scan covers this location. Open Advanced and either upload a scan, or enable "Use Live API" for areas outside CONUS.');
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
      maxHorizonDeg,
      enrichWeather,
      enrichDriving,
      enrichHorizon,
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
    ${stats.overpassError ? `
      <div class="overpass-error">
        <strong>⚠️ Facility lookup failed.</strong>
        <div class="overpass-error-detail">${escapeHtml(stats.overpassError)}</div>
        <div class="overpass-error-hint">OpenStreetMap's Overpass API rejected the query (usually a transient rate-limit). Sites are listed by distance — try the retry button to reload facilities only.</div>
        <button id="btn-retry-overpass" class="text-btn">↻ Retry facilities</button>
      </div>
    ` : ''}
  `;
  $('#results-stats').innerHTML = statsHtml;
  if (stats.overpassError) {
    $('#btn-retry-overpass')?.addEventListener('click', retryOverpassOnly);
  }

  // View toggle (only meaningful when at least one site has a forecast)
  const anyForecast = sites.some(s => s.forecast?.length);
  const toggleHtml = anyForecast ? `
    <div class="view-toggle" role="tablist">
      <button class="view-toggle-btn ${resultsView === 'sites' ? 'active' : ''}" data-view="sites">By Site</button>
      <button class="view-toggle-btn ${resultsView === 'nights' ? 'active' : ''}" data-view="nights">Best Nights</button>
    </div>
  ` : '';

  let bodyHtml;
  if (resultsView === 'nights' && anyForecast) {
    const ranked = rankSiteNights(sites).slice(0, 25);
    bodyHtml = ranked.length
      ? ranked.map((row, i) => renderNightRow(row, i, sites)).join('')
      : '<div class="empty-state"><p>No scored nights yet — enable "Cloud forecast" on next search.</p></div>';
  } else {
    bodyHtml = sites.length
      ? sites.map((site, index) => renderSiteCard(site, index)).join('')
      : '<div class="empty-state"><p>No dark sites found matching your criteria.</p></div>';
  }

  $('#results-list').innerHTML = toggleHtml + bodyHtml;

  // Wire toggle
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      resultsView = btn.dataset.view;
      renderResults(currentResults);
    });
  });

  // In Nights view we need handlers for the per-row "Jump to site" action
  document.querySelectorAll('.night-row[data-site-index]').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.siteIndex);
      resultsView = 'sites';
      renderResults(currentResults);
      // Defer highlight to next tick so the cards are in the DOM
      requestAnimationFrame(() => highlightSite(idx));
    });
  });

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

async function retryOverpassOnly() {
  if (!currentResults?.sites?.length) return;
  const btn = $('#btn-retry-overpass');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Retrying...'; }
  try {
    const centers = currentResults.sites.map(s => ({ lat: s.lat, lng: s.lng }));
    const { pois, error } = await searchNearbyPOIsBatch(centers, 8000);
    const poiRadiusKm = 8;
    currentResults.sites.forEach(site => {
      const local = pois.filter(p => haversineDistance(site.lat, site.lng, p.lat, p.lng) <= poiRadiusKm)
        .map(p => ({ ...p, distanceFromSeed: haversineDistance(site.lat, site.lng, p.lat, p.lng) }))
        .sort((a, b) => a.distanceFromSeed - b.distanceFromSeed);
      site.pois = local;
      site.hasNearbyFacilities = local.length > 0;
    });
    currentResults.stats.sitesWithFacilities = currentResults.sites.filter(s => s.hasNearbyFacilities).length;
    currentResults.stats.overpassError = error;
    renderResults(currentResults);
    renderMapMarkers(currentResults);
    showToast(error ? `Retry still failed: ${error}` : 'Facilities reloaded.');
  } catch (err) {
    showToast(`Retry failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '↻ Retry facilities'; }
  }
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

  // Meta row: elevation + drive time + horizon summary
  const metaParts = [];
  if (site.elevationM != null) {
    metaParts.push(`<span class="card-meta-item">⛰️ <strong>${Math.round(site.elevationM)} m</strong></span>`);
  }
  if (site.driving) {
    metaParts.push(`<span class="card-meta-item">🚗 <strong>${formatDriveTime(site.driving.durationSec)}</strong> drive · ${Math.round(site.driving.distanceKm)} km</span>`);
  }
  if (site.horizon) {
    const tone = site.horizon.maxAngle < 5 ? 'good' : site.horizon.maxAngle < 15 ? 'ok' : 'bad';
    metaParts.push(`<span class="card-meta-item horizon-${tone}">🏔️ horizon <strong>${site.horizon.maxAngle.toFixed(1)}°</strong> ${escapeHtml(site.horizon.worstAzimuth || '')}</span>`);
  }
  const metaHtml = metaParts.length
    ? `<div class="card-meta">${metaParts.join('')}</div>`
    : '';

  // Polar horizon plot
  const horizonHtml = site.horizon
    ? `<div class="card-horizon" title="Horizon profile — worst obstruction ${site.horizon.maxAngle.toFixed(1)}° ${site.horizon.worstAzimuth || ''}">${renderHorizonSvg(site.horizon)}</div>`
    : '';

  // Weather forecast strip
  const forecastHtml = renderForecast(site);

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
      <div class="card-row-flex">
        <div class="card-row-flex-main">
          ${metaHtml}
          ${forecastHtml}
        </div>
        ${horizonHtml}
      </div>
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

function renderForecast(site) {
  const nights = site.forecast;
  if (!nights || nights.length === 0) return '';
  // Best = highest blended score (cloud + moon + precip), not just lowest cloud.
  let best = null;
  let bestScore = -Infinity;
  for (const n of nights) {
    const s = nightScore(site, n).score;
    if (s > bestScore) { bestScore = s; best = n; }
  }
  const cells = nights.map(n => {
    const cc = n.cloudCover;
    const tone = cc == null ? '' : cc < 30 ? 'fc-good' : cc < 70 ? 'fc-ok' : 'fc-bad';
    const dayLabel = new Date(n.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
    const isBest = best && n.date === best.date && nights.length > 1;
    const score = nightScore(site, n).score;
    return `
      <div class="forecast-night ${isBest ? 'fn-best' : ''}" title="${escapeHtml(n.date)} · ${cc ?? '—'}% cloud · ${n.precipProb ?? 0}% precip · score ${score}">
        <div class="fn-day">${escapeHtml(dayLabel)}</div>
        <div class="fn-cloud ${tone}">${cc == null ? '—' : cc + '%'}</div>
        <div>${n.precipProb != null && n.precipProb > 20 ? '💧' + n.precipProb + '%' : '☁️'}</div>
      </div>
    `;
  }).join('');
  return `<div class="card-forecast" title="7-night forecast — best night highlighted (blended cloud + moon + drive + sky score)">${cells}</div>`;
}

function renderNightRow(row, index, sites) {
  const { site, night, score, reasons, weakest } = row;
  const siteIdx = sites.indexOf(site);
  const dayLabel = new Date(night.date + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const tone = score >= 75 ? 'score-good' : score >= 55 ? 'score-ok' : 'score-bad';
  const reasonsHtml = reasons.slice(0, 4).map(r => `<span class="night-reason">${escapeHtml(r)}</span>`).join('');
  return `
    <div class="night-row" data-site-index="${siteIdx}" title="Tap to view this site">
      <div class="night-rank">${index + 1}</div>
      <div class="night-score ${tone}">${score}</div>
      <div class="night-body">
        <div class="night-line-1">
          <strong>${escapeHtml(dayLabel)}</strong>
          <span class="night-site">SQM ${site.sqm.toFixed(1)} · Bortle ${site.bortle} · ${formatDistance(site.distance)} ${site.direction}</span>
        </div>
        <div class="night-line-2">${reasonsHtml}</div>
        <div class="night-line-3 night-weakest">held back by: <strong>${escapeHtml(weakest)}</strong></div>
      </div>
    </div>
  `;
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

  select.innerHTML = '<option value="__auto__">Auto (best for your location)</option>' +
    availableScans.map(s => {
      const date = s.lastUpdated ? new Date(s.lastUpdated).toISOString().slice(0, 10) : '—';
      const src = scanSourceTag(s);
      const bbox = scanBbox(s);
      let where;
      if (bbox) {
        const pts = s.totalPoints ? ` · ${(s.totalPoints / 1000).toFixed(0)}K pts` : '';
        where = `National CONUS${pts}`;
      } else if (s.centerLat != null && s.centerLng != null) {
        where = `${s.centerLat.toFixed(2)}, ${s.centerLng.toFixed(2)} · ${s.radiusKm}km`;
      } else {
        where = s.filename;
      }
      const label = `${src} ${where} @ ${s.stepKm}km · ${date}`;
      return `<option value="${escapeHtml(s.filename)}">${escapeHtml(label)}</option>`;
    }).join('');
}

// The scanner emits `bbox` only inside the scan JSON, not in index.json.
// Parse it from the filename pattern so we can both label and auto-pick.
function scanBbox(s) {
  if (Array.isArray(s.bbox) && s.bbox.length === 4) return s.bbox;
  const m = /scan_bbox_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)/.exec(s.filename || '');
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
}

function scanSourceTag(s) {
  const layer = (s.layer || '').toLowerCase();
  if (s.filename?.includes('worldatlas') || layer.includes('worldatlas')) return '🌌 WorldAtlas';
  if (layer.includes('viirs')) return '🛰️ VIIRS';
  return '📡';
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

// ─── PWA: install prompt + offline indicator ─────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('#btn-install')?.classList.remove('hidden');
});
$('#btn-install')?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#btn-install')?.classList.add('hidden');
  if (outcome === 'accepted') showToast('Installed! Launch from your home screen.');
});
window.addEventListener('appinstalled', () => {
  $('#btn-install')?.classList.add('hidden');
});

function syncOfflineIndicator() {
  const chip = $('#offline-chip');
  if (!chip) return;
  chip.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', syncOfflineIndicator);
window.addEventListener('offline', syncOfflineIndicator);

// ─── Initialize ──────────────────────────────────────────────────────────
initMap();
initUI();
updateMoonChip();
updateSourceIndicator();
syncOfflineIndicator();
loadScanIndex().then(() => {
  // Both `handleSharedSiteHash` and `autoSelectScan` may depend on the scan list
  handleSharedSiteHash();
  autoSelectScan({ silent: true });
});
