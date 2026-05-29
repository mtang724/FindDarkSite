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
import { seeingLabel, transparencyLabel } from './astroWeather.js';
import { resolveLocation, parseCoords } from './geocode.js';
import { loadDarkSkyPlaces, placesNear, designationMeta } from './darkSkyPlaces.js';
import { loadSqmReports, reportsNear, bestNearbyMeasurement, sqmColor } from './sqmReports.js';
import { loadRedditLocations, nearestCoveredMetro, sentimentColor } from './redditLocations.js';
import { exportFavorites, importFavorites, siteShareUrl, parseSharedSite, copyToClipboard } from './sharing.js';

// ─── State ───────────────────────────────────────────────────────────────
let map, searchCircle, markersGroup;
let protectedLayer;          // L.layerGroup for protected-area polygons
let darkSkyLayer;            // L.layerGroup for IDA-certified Dark Sky Places
let darkSkyPlaces = [];      // cached list from /data/dark-sky-places.json
let sqmReportsLayer;         // L.layerGroup for GLOBE at Night user reports
let sqmReports = [];         // cached list from /data/sqm-reports.json
let redditLayer;             // L.layerGroup for Reddit "locals say" pins
let redditData = null;       // entire reddit-locations.json
let activeRedditMetro = null; // last surfaced metro entry
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
let resultsView = 'sites';  // 'sites' | 'nights' | 'reddit'
let expandedCards = new Set();    // indices of result cards currently expanded
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
  // Protected-area overlay (filled later by renderMapMarkers)
  protectedLayer = L.layerGroup();

  // IDA-certified Dark Sky Places overlay (populated once on load)
  darkSkyLayer = L.layerGroup();

  // GLOBE at Night citizen-science SQM reports (populated once on load)
  sqmReportsLayer = L.layerGroup();

  // Reddit "locals say" pins — populated per-search based on the user's nearest metro
  redditLayer = L.layerGroup();

  L.control.layers({
    'Dark': dark,
    'Satellite': satellite,
  }, {
    '🟢 Public lands': protectedLayer,
    '🌌 IDA Dark Sky Places': darkSkyLayer,
    '📍 SQM measurements (GLOBE at Night)': sqmReportsLayer,
    '🗣️ Reddit recommendations': redditLayer,
  }, { position: 'topright' }).addTo(map);

  markersGroup = L.layerGroup().addTo(map);
  // Show the IDA + Reddit overlays by default; SQM layer is opt-in (10k+ points).
  protectedLayer.addTo(map);
  darkSkyLayer.addTo(map);
  redditLayer.addTo(map);
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

  // Min-settlement-distance slider
  const setSlider = $('#input-min-settlement');
  const setValue = $('#settlement-value');
  setSlider.addEventListener('input', () => {
    const v = parseInt(setSlider.value);
    setValue.textContent = v === 0 ? 'off' : `${v} km`;
  });

  // Re-pick scan + recompute moon when user edits location text. Now async
  // because non-coord input (ZIP / city / address) goes through Nominatim.
  $('#input-location').addEventListener('change', () => { resolveAndUpdate(false); });

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

function setLocationHint(text, kind = '') {
  const el = $('#location-hint');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('error', 'loading');
  if (kind) el.classList.add(kind);
}

/**
 * Resolve whatever's in #input-location to (lat, lng), update userLat/userLng,
 * the moon chip, the source indicator, and trigger autoSelectScan.
 *
 * `force` = called from the Search button (we want to error out loudly if the
 * geocode fails). When false (typing/blur) we silently no-op on errors so the
 * user can keep typing.
 */
let currentGeocode = 0;
async function resolveAndUpdate(force) {
  const input = $('#input-location').value.trim();
  if (!input) {
    setLocationHint('');
    return null;
  }
  // Fast path: coords. Don't show "looking up..." just to land at the same line.
  const coords = parseCoords(input);
  if (coords) {
    userLat = coords.lat;
    userLng = coords.lng;
    setLocationHint(`→ ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
    updateMoonChip();
    await autoSelectScan({ force: true });
    return coords;
  }

  setLocationHint(`Looking up "${input}"…`, 'loading');
  const myToken = ++currentGeocode;
  try {
    const r = await resolveLocation(input);
    if (myToken !== currentGeocode) return null; // a newer call superseded us
    userLat = r.lat;
    userLng = r.lng;
    const label = r.displayName || `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`;
    setLocationHint(`→ ${label}  (${r.lat.toFixed(4)}, ${r.lng.toFixed(4)})`);
    updateMoonChip();
    await autoSelectScan({ force: true });
    return { lat: r.lat, lng: r.lng };
  } catch (err) {
    if (myToken !== currentGeocode) return null;
    setLocationHint(err.message || 'Could not resolve location.', 'error');
    if (force) throw err; // bubble up to startSearch so it can show an alert
    return null;
  }
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

  // Resolve location (coords / ZIP / city / address)
  const locInput = $('#input-location').value.trim();
  if (!locInput) {
    alert('Please enter a location, ZIP code, or click 📍 to use your current location.');
    return;
  }

  // resolveAndUpdate already sets userLat/userLng on success, or surfaces the
  // error via #location-hint. We re-throw above so a stale value isn't reused.
  let resolved;
  try {
    resolved = await resolveAndUpdate(true);
  } catch (err) {
    alert(`Could not resolve "${locInput}": ${err.message}`);
    return;
  }
  if (!resolved) return; // hint already shows the error

  const radiusKm = parseInt($('#input-radius').value);
  const minSqm = parseFloat($('#input-sqm').value);
  const maxResults = parseInt($('#input-max-results').value);
  const useLive = $('#opt-live-scan').checked;
  const dataSource = useLive ? 'live' : 'precomputed';
  const gridStepKm = parseInt($('input[name="grid-step"]:checked')?.value || '5');
  const minElevationM = parseInt($('#input-min-elev').value) || 0;
  const maxHorizonDeg = parseInt($('#input-max-horizon').value) || 0;
  const minSettlementKm = parseInt($('#input-min-settlement').value) || 0;
  const hideUnreachable = $('#opt-hide-unreachable').checked;
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
      minSettlementKm,
      hideUnreachable,
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

    // Find the nearest covered metro for this user and stash for renderResults
    // / map markers. Distance cap of 250 km keeps "covered" to the actual
    // surrounding metro area, not a tangentially-related one.
    if (redditData) {
      activeRedditMetro = nearestCoveredMetro(redditData, userLat, userLng, 250);
    }

    // Enrich each site with its nearest IDA-certified Dark Sky Place (if any
    // within 25 km). Cheap in-memory lookup, doesn't touch the network.
    if (darkSkyPlaces.length) {
      for (const s of result.sites) {
        const near = placesNear(darkSkyPlaces, s.lat, s.lng, 25);
        if (near.length) s.darkSkyPlace = near[0];
      }
    }
    // Attach the best nearby GLOBE-at-Night SQM measurement (within 15 km).
    // This is a real human/instrument reading that independently validates
    // (or contradicts) the satellite-derived SQM.
    if (sqmReports.length) {
      for (const s of result.sites) {
        const best = bestNearbyMeasurement(sqmReports, s.lat, s.lng, 15);
        if (best) s.sqmReport = best;
      }
    }
    // Attach the nearest Reddit-vetted spot (within 30 km) so the scorer can
    // bump community-validated sites in the Best Nights ranking.
    if (activeRedditMetro?.places?.length) {
      for (const s of result.sites) {
        let best = null;
        let bestD = Infinity;
        for (const p of activeRedditMetro.places) {
          if (p.lat == null || p.lng == null) continue;
          const d = haversineDistance(s.lat, s.lng, p.lat, p.lng);
          if (d < bestD && d <= 30) { bestD = d; best = p; }
        }
        if (best) s.nearestRedditSpot = { ...best, distanceKm: bestD };
      }
    }

    currentResults = result;
    expandedCards = new Set();   // fresh result set → re-seed auto-expand inside renderResults
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
      <div class="stat-value">${stats.sitesReachable ?? '—'}</div>
      <div class="stat-label">Reachable</div>
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

  // Reddit map pins are always drawn; the panel UI now lives inside the view
  // toggle as a third tab (no longer above the cards).
  ensureRedditMapPins();

  // Auto-expand the first two cards so the demo isn't hidden behind a click.
  // We only seed this on a fresh result set (when nothing is expanded yet).
  if (expandedCards.size === 0 && sites.length > 0) {
    expandedCards.add(0);
    if (sites.length > 1) expandedCards.add(1);
  }

  // View toggle: Sites · Best Nights · Locals
  const anyForecast = sites.some(s => s.forecast?.length);
  const anyReddit   = (activeRedditMetro?.places?.length || 0) > 0;
  // If the requested view isn't available, fall back to sites
  if (resultsView === 'nights' && !anyForecast) resultsView = 'sites';
  if (resultsView === 'reddit' && !anyReddit)   resultsView = 'sites';

  const tabs = [
    { id: 'sites',  label: 'By Site' },
    anyForecast ? { id: 'nights', label: 'Best Nights' } : null,
    anyReddit   ? { id: 'reddit', label: `Locals${activeRedditMetro ? ` · ${activeRedditMetro.metro}` : ''}` } : null,
  ].filter(Boolean);
  const toggleHtml = tabs.length > 1 ? `
    <div class="view-toggle" role="tablist">
      ${tabs.map(t => `
        <button class="view-toggle-btn ${resultsView === t.id ? 'active' : ''}" data-view="${t.id}">${escapeHtml(t.label)}</button>
      `).join('')}
    </div>
  ` : '';

  let bodyHtml;
  if (resultsView === 'nights' && anyForecast) {
    const ranked = rankSiteNights(sites).slice(0, 25);
    bodyHtml = ranked.length
      ? ranked.map((row, i) => renderNightRow(row, i, sites)).join('')
      : '<div class="empty-state"><p>No scored nights yet — enable "Cloud forecast" on next search.</p></div>';
  } else if (resultsView === 'reddit' && anyReddit) {
    bodyHtml = renderRedditTabBody();
  } else {
    bodyHtml = sites.length
      ? sites.map((site, index) => renderSiteCard(site, index, expandedCards.has(index))).join('')
      : '<div class="empty-state"><p>No dark sites found matching your criteria.</p></div>';
  }

  $('#results-list').innerHTML = toggleHtml + bodyHtml;

  // Reddit tab body needs click-to-pan handlers identical to the old section
  if (resultsView === 'reddit') {
    document.querySelectorAll('#results-list .reddit-row[data-lat]').forEach(a => {
      a.addEventListener('click', (e) => {
        const lat = parseFloat(a.dataset.lat);
        const lng = parseFloat(a.dataset.lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        map.setView([lat, lng], 11);
      });
    });
  }

  // Expand / collapse handlers on the result cards
  document.querySelectorAll('.btn-expand').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (expandedCards.has(idx)) expandedCards.delete(idx);
      else expandedCards.add(idx);
      renderResults(currentResults);
    });
  });

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

/**
 * Drop sentiment-coloured pins for every covered Reddit spot. Idempotent —
 * clears prior pins first. Called once per search; the map layer is always
 * available (toggle-able via Leaflet layer control).
 */
function ensureRedditMapPins() {
  redditLayer.clearLayers();
  if (!activeRedditMetro?.places?.length) return;
  for (const p of activeRedditMetro.places) {
    if (p.lat == null || p.lng == null) continue;
    const color = p.sentiment === 'positive' ? '#4ade80' : p.sentiment === 'negative' ? '#fb7185' : '#fbbf24';
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: 'reddit-marker',
        html: `<div style="background:${color};width:14px;height:14px;border:2px solid #050810;border-radius:50%;box-shadow:0 0 8px ${color};"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
    });
    marker.bindPopup(
      `<div class="popup-title">🗣️ ${escapeHtml(p.name)}</div>`
      + `<div style="font-style:italic;font-size:12px;color:#cbd5e1;margin:4px 0">${escapeHtml(p.why)}</div>`
      + (p.sourceUrl ? `<a class="popup-link" href="${escapeHtml(p.sourceUrl)}" target="_blank" rel="noopener">📄 Reddit thread</a>` : '')
    );
    marker.addTo(redditLayer);
  }
}

/**
 * Render the Reddit "Locals say" rows as the third tab's body (no longer a
 * fixed banner above the cards). Sorted positive → mixed → negative.
 */
function renderRedditTabBody() {
  if (!activeRedditMetro?.places?.length) return '';
  const rows = activeRedditMetro.places.slice().sort((a, b) =>
    (a.sentiment === 'positive' ? -1 : 1) - (b.sentiment === 'positive' ? -1 : 1)
  );
  return `
    <div class="reddit-section">
      <div class="reddit-section-header">
        🗣️ <strong>${escapeHtml(activeRedditMetro.metro)}, ${escapeHtml(activeRedditMetro.state)}</strong>
        <span class="reddit-section-meta">${rows.length} spots · r/${escapeHtml(activeRedditMetro.places[0]?.subreddit || activeRedditMetro.metro)}</span>
      </div>
      <div class="reddit-section-body">
        ${rows.map(p => `
          <a class="reddit-row" href="${escapeHtml(p.sourceUrl || '#')}" target="_blank" rel="noopener"
             data-lat="${p.lat ?? ''}" data-lng="${p.lng ?? ''}">
            <span class="reddit-dot" style="background:${p.sentiment === 'positive' ? '#4ade80' : p.sentiment === 'negative' ? '#fb7185' : '#fbbf24'}"></span>
            <span class="reddit-body">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="reddit-why">${escapeHtml(p.why)}</span>
            </span>
            <span class="reddit-meta">r/${escapeHtml(p.subreddit || '?')}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Pick THE single most important thing to say about this site — that one line
 * is the only colored signal on a collapsed card. Priority is "what would the
 * user most regret not knowing": real hazards first, then defining strengths,
 * then defining weaknesses, then a neutral fallback.
 *
 * Returns { icon, text, tone } where tone ∈ {danger, warn, feature, community, measured, neutral, good}
 */
function siteHeadline(site) {
  const today = new Date().toISOString().slice(0, 10);
  const tonight = site.forecast?.find(n => n.date >= today);

  // 1. Hazards — never hide these
  if (site.inMilitary) return { icon: '⛔', text: 'Inside military area — do not enter', tone: 'danger' };
  if (site.reachable === false) return { icon: '🚫', text: 'No drivable road within 800 m', tone: 'danger' };
  if (tonight?.dewMarginC != null && tonight.dewMarginC < 2) {
    return { icon: '💧', text: `Tonight: ${tonight.dewMarginC}°C dew margin — gear will wet`, tone: 'danger' };
  }

  // 2. Strong positives that define the spot
  if (site.darkSkyPlace && site.darkSkyPlace.distanceKm < 2) {
    return { icon: '🌲', text: `Inside IDA ${site.darkSkyPlace.name}`, tone: 'feature' };
  }
  const r = site.nearestRedditSpot;
  if (r && r.distanceKm < 8 && r.sentiment === 'positive') {
    return { icon: '🗣️', text: `Near r/${r.subreddit}'s ${r.name} — Reddit favorite`, tone: 'community' };
  }
  if (site.sqm >= 21.7) {
    return { icon: '🌌', text: `Pristine sky · SQM ${site.sqm.toFixed(1)}`, tone: 'measured' };
  }

  // 3. Defining warnings that aren't hazards
  if (site.horizon && site.horizon.maxAngle > 18) {
    return { icon: '🏔️', text: `${site.horizon.maxAngle.toFixed(0)}° horizon obstruction ${site.horizon.worstAzimuth || ''}`, tone: 'warn' };
  }
  if (site.nearestSettlementKm != null && site.nearestSettlementKm < 6) {
    return { icon: '🏘️', text: `Only ${site.nearestSettlementKm} km from ${site.nearestSettlementName || 'town'}`, tone: 'warn' };
  }

  // 4. Mild positives — useful but not headline-grabbing
  if (site.darkSkyPlace) {
    return { icon: '🌲', text: `${site.darkSkyPlace.distanceKm.toFixed(0)} km from IDA ${site.darkSkyPlace.name}`, tone: 'feature' };
  }
  if (site.horizon && site.horizon.maxAngle < 5) {
    return { icon: '🏔️', text: 'Horizon clear all around', tone: 'good' };
  }
  if (site.driving && site.driving.durationSec < 30 * 60) {
    return { icon: '🚗', text: `${formatDriveTime(site.driving.durationSec)} drive`, tone: 'good' };
  }

  // 5. Neutral fallback
  if (site.driving) {
    return { icon: '🚗', text: `${formatDriveTime(site.driving.durationSec)} · ${Math.round(site.driving.distanceKm)} km`, tone: 'neutral' };
  }
  return { icon: '📍', text: `${formatDistance(site.distance)} ${site.direction}`, tone: 'neutral' };
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

function renderSiteCard(site, index, isExpanded = false) {
  const isSaved = favorites.some(f => f.lat === site.lat && f.lng === site.lng);
  const headline = siteHeadline(site);
  const driveSummary = site.driving
    ? `<span class="card-distance">${formatDriveTime(site.driving.durationSec)} · ${formatDistance(site.distance)}</span>`
    : `<span class="card-distance">${formatDistance(site.distance)} ${site.direction}</span>`;

  // Always-on hero block — visible whether collapsed or expanded.
  const heroHtml = `
    <div class="card-header">
      <div class="card-sqm">
        <span class="sqm-value">${site.sqm.toFixed(1)}</span>
        <span class="bortle-badge bortle-${site.bortle}">Bortle ${site.bortle}</span>
      </div>
      ${driveSummary}
    </div>
    <div class="card-headline tone-${headline.tone}">
      <span class="card-headline-icon">${headline.icon}</span>
      <span class="card-headline-text">${escapeHtml(headline.text)}</span>
    </div>
  `;

  // Footer — always present so Save / Navigate are reachable without expanding.
  const actionsHtml = `
    <div class="card-actions">
      <button class="card-btn btn-expand" data-index="${index}" title="${isExpanded ? 'Hide details' : 'Show details'}">
        ${isExpanded ? '▴ Less' : '▾ More'}
      </button>
      <button class="card-btn btn-navigate" data-lat="${site.lat}" data-lng="${site.lng}">🧭 Navigate</button>
      <button class="card-btn btn-share" data-index="${index}">🔗 Share</button>
      <button class="card-btn btn-save ${isSaved ? 'saved' : ''}" data-index="${index}">
        ${isSaved ? '⭐ Saved' : '☆ Save'}
      </button>
    </div>
  `;

  if (!isExpanded) {
    return `
      <div class="result-card collapsed" data-index="${index}" data-lat="${site.lat}" data-lng="${site.lng}">
        ${heroHtml}
        ${actionsHtml}
      </div>
    `;
  }

  // ─── Expanded body (only built when this card is open) ─────────────────
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

  // Meta row: facts in neutral grey; only red for *hazards* the user must see
  // before driving. Everything else is colour-discipline plain.
  const metaParts = [];
  if (site.elevationM != null) {
    metaParts.push(`<span class="card-meta-item">⛰️ <strong>${Math.round(site.elevationM)} m</strong></span>`);
  }
  if (site.driving) {
    metaParts.push(`<span class="card-meta-item">🚗 <strong>${formatDriveTime(site.driving.durationSec)}</strong> · ${Math.round(site.driving.distanceKm)} km</span>`);
  }
  // Horizon — only the >15° "obstructed" case earns a colour. Clear/OK go neutral.
  if (site.horizon) {
    const isBlocked = site.horizon.maxAngle >= 15;
    const cls = isBlocked ? 'card-meta-item horizon-bad' : 'card-meta-item';
    metaParts.push(`<span class="${cls}">🏔️ horizon <strong>${site.horizon.maxAngle.toFixed(1)}°</strong> ${escapeHtml(site.horizon.worstAzimuth || '')}</span>`);
  }
  // Reachability: red on absence, neutral on presence.
  if (site.nearestRoadM != null) {
    if (site.reachable) {
      metaParts.push(`<span class="card-meta-item">🛣️ road <strong>${site.nearestRoadM} m</strong></span>`);
    } else {
      metaParts.push(`<span class="card-meta-item reach-bad">🛣️ <strong>no drivable road</strong></span>`);
    }
  } else if (site.reachable === false) {
    metaParts.push(`<span class="card-meta-item reach-bad">🛣️ <strong>no drivable road</strong></span>`);
  }
  if (site.nearestSettlementName) {
    metaParts.push(`<span class="card-meta-item">🏘️ ${escapeHtml(site.nearestSettlementName)} <strong>${site.nearestSettlementKm} km</strong></span>`);
  }
  if (site.inMilitary) {
    metaParts.push(`<span class="card-meta-item reach-bad">⛔ <strong>Inside military area</strong></span>`);
  } else if (site.protectedArea?.name || site.protectedArea?.boundary) {
    const a = site.protectedArea;
    const label = a.name || (a.boundary === 'national_park' ? 'National Park' : 'Protected area');
    metaParts.push(`<span class="card-meta-item" title="${escapeHtml([a.cls, a.ownership].filter(Boolean).join(' · '))}">🌲 ${escapeHtml(label)}</span>`);
  }
  if (darkSkyPlaces.length) {
    const near = placesNear(darkSkyPlaces, site.lat, site.lng, 25);
    if (near.length) {
      const closest = near[0];
      const meta = designationMeta(closest.designation);
      const dist = closest.distanceKm < 2 ? 'inside' : `${closest.distanceKm.toFixed(1)} km`;
      metaParts.push(`<span class="card-meta-item" title="IDA-certified ${meta.label}">${meta.icon} ${escapeHtml(closest.name)} <strong>${escapeHtml(dist)}</strong></span>`);
    }
  }
  if (site.sqmReport) {
    const r = site.sqmReport;
    const readingLabel = r.sqm != null ? `SQM <strong>${r.sqm.toFixed(2)}</strong>` : `NELM <strong>${r.limitingMag}</strong>`;
    const dKm = r.distanceKm?.toFixed(1) ?? '?';
    metaParts.push(`<span class="card-meta-item" title="GLOBE at Night observation${r.comment ? ': ' + r.comment.replace(/[<>"']/g, '') : ''}">📍 measured ${readingLabel} · ${dKm} km</span>`);
  }
  if (site.roadSurface) {
    metaParts.push(`<span class="card-meta-item">🛤️ ${escapeHtml(site.roadSurface)}</span>`);
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

  // Tonight-class astro chips — pick the first forecast night whose date
  // is today-or-later (Open-Meteo sometimes back-fills the previous evening).
  const today = new Date().toISOString().slice(0, 10);
  const tonight = site.forecast?.find(n => n.date >= today) || site.forecast?.[0];
  const astroChipsHtml = tonight ? renderAstroChips(tonight) : '';

  return `
    <div class="result-card expanded" data-index="${index}" data-lat="${site.lat}" data-lng="${site.lng}">
      ${heroHtml}
      <div class="card-coords">${site.lat.toFixed(4)}°, ${site.lng.toFixed(4)}°</div>
      <div class="card-row-flex">
        <div class="card-row-flex-main">
          ${metaHtml}
          ${astroChipsHtml}
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
        <button class="card-btn btn-expand" data-index="${index}" title="Hide details">▴ Less</button>
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

function renderAstroChips(n) {
  const chips = [];
  if (n.seeing != null) {
    const tone = n.seeing <= 2.5 ? 'good' : n.seeing <= 4 ? 'ok' : 'bad';
    chips.push(`<span class="astro-chip ${tone}" title="7Timer seeing scale 1=excellent .. 8=awful">👁️ seeing <strong>${seeingLabel(n.seeing)}</strong></span>`);
  }
  if (n.transparency != null) {
    const tone = n.transparency <= 2.5 ? 'good' : n.transparency <= 4 ? 'ok' : 'bad';
    chips.push(`<span class="astro-chip ${tone}" title="7Timer transparency 1=pristine .. 8=opaque">🔭 ${transparencyLabel(n.transparency)}</span>`);
  }
  if (n.dewMarginC != null) {
    const tone = n.dewMarginC >= 5 ? 'good' : n.dewMarginC >= 2 ? 'ok' : 'bad';
    chips.push(`<span class="astro-chip ${tone}" title="Temperature minus dewpoint. < 2°C = condensation likely.">💧 dew margin <strong>${n.dewMarginC}°</strong></span>`);
  }
  if (n.windKph != null) {
    const tone = n.windKph < 10 ? 'good' : n.windKph < 25 ? 'ok' : 'bad';
    chips.push(`<span class="astro-chip ${tone}" title="Open-Meteo wind 10m, max over the night window">💨 wind <strong>${n.windKph} kph</strong></span>`);
  }
  if (!chips.length) return '';
  return `<div class="astro-chips" title="Tonight's astro conditions">${chips.join('')}</div>`;
}

function renderForecast(site) {
  const today = new Date().toISOString().slice(0, 10);
  const nights = (site.forecast || []).filter(n => n.date >= today);
  if (nights.length === 0) return '';
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
function renderMapMarkers({ sites, protectedAreas }) {
  markersGroup.clearLayers();
  protectedLayer.clearLayers();
  siteMarkers = [];
  activeSiteIndex = null;

  // Protected-area polygons — drawn under the site markers
  if (Array.isArray(protectedAreas)) {
    for (const area of protectedAreas) {
      const color = area.boundary === 'national_park' ? '#34d399' : '#86efac';
      for (const ring of area.rings) {
        if (ring.length < 3) continue;
        const latlngs = ring.map(p => [p.lat, p.lon]);
        const poly = L.polygon(latlngs, {
          color, weight: 1.2, fillColor: color, fillOpacity: 0.10, dashArray: '4 4', interactive: true,
        });
        const title = area.name || (area.boundary === 'national_park' ? 'National Park' : 'Protected Area');
        const subtitle = [area.cls, area.ownership].filter(Boolean).join(' · ');
        poly.bindTooltip(`<strong>${escapeHtml(title)}</strong>${subtitle ? `<br><span style="opacity:0.75">${escapeHtml(subtitle)}</span>` : ''}`, { sticky: true });
        poly.addTo(protectedLayer);
      }
    }
  }

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

// Load Reddit "locals say" stargazing spots once on app start. The actual
// rendering of pins happens per-search, scoped to the nearest covered metro.
loadRedditLocations().then(d => { redditData = d; });

// Load + paint the GLOBE at Night citizen-science SQM reports. Hidden by
// default — user opts in via the layer control because the dataset is big.
loadSqmReports().then(reports => {
  sqmReports = reports;
  for (const r of reports) {
    const color = sqmColor(r.sqm);
    const m = L.circleMarker([r.lat, r.lng], {
      radius: 4,
      color,
      fillColor: color,
      fillOpacity: 0.7,
      weight: 1,
      pane: 'overlayPane',
    });
    const sqmLine = r.sqm != null ? `SQM ${r.sqm.toFixed(2)} mag/arcsec²` : `Naked-eye LM ${r.limitingMag}`;
    m.bindTooltip(
      `<strong>${sqmLine}</strong>`
      + (r.date ? `<br><span style="opacity:0.7">${r.date}</span>` : '')
      + (r.comment ? `<br><span style="opacity:0.85">${r.comment.replace(/[<>]/g, '')}</span>` : ''),
      { direction: 'top', offset: [0, -4] }
    );
    m.addTo(sqmReportsLayer);
  }
});

// Bake IDA-certified Dark Sky Places onto the map as soon as we have them.
loadDarkSkyPlaces().then(places => {
  darkSkyPlaces = places;
  for (const p of places) {
    const meta = designationMeta(p.designation);
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        className: 'darksky-marker',
        html: `<div style="font-size:18px;line-height:1;filter:drop-shadow(0 0 4px ${meta.color});">${meta.icon}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    });
    marker.bindPopup(
      `<div class="popup-title">${meta.icon} ${escapeHtml(p.name)}</div>`
      + `<div style="color:${meta.color};font-weight:600;margin-top:2px">${escapeHtml(meta.label)}</div>`
      + (p.country ? `<div style="font-size:11px;color:#94a3b8">${escapeHtml(p.country)}</div>` : '')
      + `<a class="popup-link" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving" target="_blank" rel="noopener">🧭 Navigate</a>`
    );
    marker.addTo(darkSkyLayer);
  }
});
