#!/usr/bin/env python3
"""
FindDarkSite — Standalone Grid Scanner

Scans a grid of coordinates for light pollution data via lightpollutionmap.info
GeoServer WMS endpoint and saves results to a JSON file that can be loaded
by the web app.

Usage:
    python scan_grid.py --lat 34.05 --lng -118.24 --radius 200 --step 5
    python scan_grid.py --lat 34.05 --lng -118.24 --radius 200 --step 5 --output my-scan.json
    python scan_grid.py --resume my-scan.json   # resume an interrupted scan

Rate limiting: ~2 requests/sec to be respectful.
    200km radius @ 5km step ≈ 5,000 points ≈ ~42 min
    300km radius @ 5km step ≈ 11,300 points ≈ ~95 min

Requirements: Python 3.6+ (no external dependencies)
"""

import argparse
import json
import math
import os
import signal
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Where the web app looks for pre-computed scans (relative to repo root).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DATA_DIR = os.path.join(REPO_ROOT, "public", "data")
INDEX_FILE = os.path.join(PUBLIC_DATA_DIR, "index.json")

# ─── Constants ────────────────────────────────────────────────────────────────

EARTH_RADIUS_KM = 6371
WMS_BASE = "https://www.lightpollutionmap.info/geoserver/gwc/service/wms"
DEFAULT_LAYER = "VIIRS_2023"
DEFAULT_DELAY_SEC = 0.5  # 2 req/sec
SAVE_INTERVAL = 100      # save every N points
REQUEST_TIMEOUT = 15     # seconds


# ─── Geo Utilities ────────────────────────────────────────────────────────────

def haversine_distance(lat1, lng1, lat2, lng2):
    """Haversine distance between two coordinates in km."""
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lng / 2) ** 2)
    return EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def generate_grid_points(center_lat, center_lng, radius_km, step_km):
    """Generate grid points within a circular area."""
    points = []
    lat_step = math.degrees(step_km / EARTH_RADIUS_KM)
    lat_min = center_lat - math.degrees(radius_km / EARTH_RADIUS_KM)
    lat_max = center_lat + math.degrees(radius_km / EARTH_RADIUS_KM)

    lat = lat_min
    while lat <= lat_max:
        cos_lat = math.cos(math.radians(lat))
        if cos_lat == 0:
            lat += lat_step
            continue

        lng_step = math.degrees(step_km / (EARTH_RADIUS_KM * cos_lat))
        lng_range = math.degrees(radius_km / (EARTH_RADIUS_KM * cos_lat))
        lng_min = center_lng - lng_range
        lng_max = center_lng + lng_range

        lng = lng_min
        while lng <= lng_max:
            if haversine_distance(center_lat, center_lng, lat, lng) <= radius_km:
                points.append({
                    "lat": round(lat, 5),
                    "lng": round(lng, 5),
                })
            lng += lng_step
        lat += lat_step

    return points


# ─── Light Pollution API ─────────────────────────────────────────────────────

# The lightpollutionmap.info GeoServer WMS returns grayscale pixel values (0-255).
# This maps pixel brightness to approximate VIIRS radiance (nW/cm²/sr) using a
# logarithmic scale fitted so pixel 6 -> 0.01 nW and pixel 250 -> 100 nW:
#   pixel <=5  => 0 nW     (no artificial light — Bortle 1-2)
#   pixel  50  => ~0.05 nW (rural — Bortle 3)
#   pixel 128  => ~1.0 nW  (suburban — Bortle 5)
#   pixel 250  => ~100 nW  (city — Bortle 9)
# Note: this is an approximate fit to the site's rendering, not VIIRS truth.

def pixel_to_radiance(pixel):
    """Convert WMS pixel intensity (0-255) to approximate radiance (nW/cm²/sr)."""
    if pixel <= 5:
        return 0     # darkest reading — no artificial light
    # Logarithmic mapping from pixel 6-255 to radiance 0.01-100 nW
    # radiance = 0.01 * 10^(k * (pixel - 6))  where pixel=250 → 100 nW
    # k = log10(100 / 0.01) / (250 - 6) = 4 / 244 ≈ 0.01639
    k = 4.0 / (250 - 6)
    return round(0.01 * (10 ** (k * (pixel - 6))), 4)


def radiance_to_sqm(radiance):
    """Convert VIIRS radiance (nW/cm²/sr) to SQM (mag/arcsec²)."""
    if radiance <= 0:
        return 22.0
    sqm = 22.0 - 2.5 * math.log10(1 + radiance / 0.171)
    return min(22.0, max(16.0, round(sqm, 2)))


def sqm_to_bortle(sqm):
    """Convert SQM value to Bortle class (1-9)."""
    if sqm >= 21.99: return 1
    if sqm >= 21.89: return 2
    if sqm >= 21.69: return 3
    if sqm >= 20.49: return 4
    if sqm >= 19.50: return 5
    if sqm >= 18.94: return 6
    if sqm >= 18.38: return 7
    if sqm >= 17.50: return 8
    return 9


def query_radiance(lat, lng, layer=DEFAULT_LAYER):
    """Query light pollution via WMS GetFeatureInfo for a single point."""
    d = 0.005  # ~0.5km at mid-latitudes
    bbox = "{},{},{},{}".format(lng - d, lat - d, lng + d, lat + d)

    url = (
        WMS_BASE +
        "?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo"
        "&LAYERS=PostGIS:{layer}"
        "&QUERY_LAYERS=PostGIS:{layer}"
        "&INFO_FORMAT=application/json"
        "&SRS=EPSG:4326"
        "&BBOX={bbox}"
        "&WIDTH=256&HEIGHT=256&X=128&Y=128"
    ).format(layer=layer, bbox=bbox)

    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; FindDarkSite-Scanner/1.0)",
            "Accept": "application/json, */*",
        })
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        features = data.get("features", [])
        if not features:
            return {"radiance": -1, "sqm": -1, "bortle": -1, "raw": "no features"}

        props = features[0].get("properties", {})
        # Distinguish "missing key" (no data) from a legitimate pixel value of 0
        raw_pixel = props.get("RED_BAND")
        if raw_pixel is None:
            raw_pixel = props.get("GRAY_INDEX")
        if raw_pixel is None:
            return {"radiance": -1, "sqm": -1, "bortle": -1, "error": "no pixel"}
        try:
            pixel = float(raw_pixel)
        except (TypeError, ValueError):
            return {"radiance": -1, "sqm": -1, "bortle": -1, "error": "bad pixel"}
        if pixel < 0:
            return {"radiance": -1, "sqm": -1, "bortle": -1, "error": "bad pixel"}

        radiance = pixel_to_radiance(pixel)
        sqm = radiance_to_sqm(radiance)
        bortle = sqm_to_bortle(sqm)
        return {"radiance": radiance, "sqm": sqm, "bortle": bortle, "pixel": pixel}

    except Exception as e:
        return {"radiance": -1, "sqm": -1, "bortle": -1, "error": str(e)}


# ─── Progress & Save ─────────────────────────────────────────────────────────

def format_duration(seconds):
    """Format seconds into human-readable duration."""
    sec = int(seconds)
    hr, sec = divmod(sec, 3600)
    mn, sec = divmod(sec, 60)
    if hr > 0:
        return "{}h {}m {}s".format(hr, mn, sec)
    if mn > 0:
        return "{}m {}s".format(mn, sec)
    return "{}s".format(sec)


def print_progress(done, total, start_time, last_result):
    """Print a single-line progress update."""
    pct = (done / total) * 100
    elapsed = time.time() - start_time
    rate = done / elapsed if elapsed > 0 else 0
    eta = (total - done) / rate if rate > 0 else 0
    sqm_val = last_result.get("sqm", -1) if last_result else -1
    sqm_str = "SQM={}".format(sqm_val) if sqm_val > 0 else "n/a"

    sys.stdout.write(
        "\r[{}/{}] {:.1f}% | {} | "
        "{:.1f} pts/sec | ETA: {}    ".format(done, total, pct, sqm_str, rate, format_duration(eta))
    )
    sys.stdout.flush()


def save_results(output_file, metadata, results):
    """Save scan results to JSON file and refresh the public/data index."""
    data = {
        "metadata": dict(
            list(metadata.items()) + [
                ("lastUpdated", datetime.now(timezone.utc).isoformat()),
                ("totalPoints", len(results)),
                ("validPoints", sum(1 for r in results if r.get("sqm", -1) > 0)),
            ]
        ),
        "results": results,
    }
    os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)
    with open(output_file, "w") as f:
        json.dump(data, f, indent=2)

    # Refresh index.json only when writing into the web app's data dir
    output_dir = os.path.dirname(os.path.abspath(output_file))
    if os.path.abspath(output_dir) == os.path.abspath(PUBLIC_DATA_DIR):
        rebuild_index(output_dir)


def rebuild_index(data_dir):
    """Scan a directory for scan_*.json files and write index.json next to them."""
    scans = []
    for name in sorted(os.listdir(data_dir)):
        if name == "index.json" or not name.endswith(".json"):
            continue
        path = os.path.join(data_dir, name)
        try:
            with open(path) as f:
                payload = json.load(f)
            meta = payload.get("metadata", {})
        except (OSError, ValueError):
            continue
        scans.append({
            "filename": name,
            "centerLat": meta.get("centerLat"),
            "centerLng": meta.get("centerLng"),
            "radiusKm": meta.get("radiusKm"),
            "stepKm": meta.get("stepKm"),
            "layer": meta.get("layer"),
            "lastUpdated": meta.get("lastUpdated"),
            "totalPoints": meta.get("totalPoints"),
            "validPoints": meta.get("validPoints"),
        })
    with open(os.path.join(data_dir, "index.json"), "w") as f:
        json.dump({"scans": scans}, f, indent=2)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="FindDarkSite Grid Scanner — scans light pollution data and saves to JSON.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Scan 200km around Los Angeles at 5km resolution
  python scan_grid.py --lat 34.05 --lng -118.24 --radius 200 --step 5

  # Scan 100km with finer resolution
  python scan_grid.py --lat 40.71 --lng -74.01 --radius 100 --step 3

  # Resume an interrupted scan
  python scan_grid.py --resume scan_34.05_-118.24_200km.json
        """,
    )
    parser.add_argument("--lat", type=float, help="Center latitude")
    parser.add_argument("--lng", type=float, help="Center longitude")
    parser.add_argument("--radius", type=float, default=200, help="Search radius in km (default: 200)")
    parser.add_argument("--step", type=float, default=5, help="Grid step in km (default: 5)")
    parser.add_argument("--output", type=str, help="Output JSON filename")
    parser.add_argument("--resume", type=str, help="Resume scan from existing JSON file")
    parser.add_argument("--layer", type=str, default=DEFAULT_LAYER,
                        help="VIIRS layer (default: {})".format(DEFAULT_LAYER))
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SEC,
                        help="Delay between requests in seconds (default: {})".format(DEFAULT_DELAY_SEC))

    args = parser.parse_args()

    # ── Resume or New Scan ────────────────────────────────────────────────
    if args.resume:
        print("Resume from {}...".format(args.resume))
        with open(args.resume) as f:
            existing = json.load(f)

        metadata = existing["metadata"]
        results = existing["results"]
        output_file = args.resume

        all_points = generate_grid_points(
            metadata["centerLat"], metadata["centerLng"],
            metadata["radiusKm"], metadata["stepKm"],
        )
        scanned = set("{},{}".format(r["lat"], r["lng"]) for r in results)
        all_points = [p for p in all_points if "{},{}".format(p["lat"], p["lng"]) not in scanned]
        start_index = len(results)
        print("Found {} existing results, {} remaining".format(len(results), len(all_points)))

    else:
        if args.lat is None or args.lng is None:
            parser.error("--lat and --lng are required (or use --resume)")

        metadata = {
            "centerLat": args.lat,
            "centerLng": args.lng,
            "radiusKm": args.radius,
            "stepKm": args.step,
            "layer": args.layer,
            "startedAt": datetime.now(timezone.utc).isoformat(),
        }

        default_name = "scan_{}_{}_{:.0f}km.json".format(args.lat, args.lng, args.radius)
        output_file = args.output or os.path.join(PUBLIC_DATA_DIR, default_name)
        all_points = generate_grid_points(args.lat, args.lng, args.radius, args.step)
        results = []
        start_index = 0

        est_time = format_duration(len(all_points) * args.delay)

        print("FindDarkSite Grid Scanner")
        print("=" * 40)
        print("Center: {}, {}".format(args.lat, args.lng))
        print("Radius: {} km | Step: {} km".format(args.radius, args.step))
        print("Total grid points: {}".format(len(all_points)))
        print("Output: {}".format(output_file))
        print("Est. time: {}".format(est_time))
        print("=" * 40)
        print()

    # ── Scan Loop ─────────────────────────────────────────────────────────
    total_points = start_index + len(all_points)
    start_time = time.time()
    error_count = 0
    interrupted = False

    def handle_sigint(sig, frame):
        nonlocal interrupted
        if interrupted:
            sys.exit(1)
        interrupted = True
        print("\n\nInterrupted! Saving progress...")
        save_results(output_file, metadata, results)
        print("Saved {} results to {}".format(len(results), output_file))
        print("Resume with: python scan_grid.py --resume {}".format(output_file))
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_sigint)

    for i, point in enumerate(all_points):
        if interrupted:
            break

        result = query_radiance(point["lat"], point["lng"], metadata.get("layer", DEFAULT_LAYER))
        results.append(dict(list({"lat": point["lat"], "lng": point["lng"]}.items()) + list(result.items())))

        if "error" in result:
            error_count += 1

        print_progress(start_index + i + 1, total_points, start_time, result)

        if (i + 1) % SAVE_INTERVAL == 0:
            save_results(output_file, metadata, results)

        if i < len(all_points) - 1:
            time.sleep(args.delay)

    # ── Final Save & Stats ────────────────────────────────────────────────
    save_results(output_file, metadata, results)

    elapsed = time.time() - start_time
    valid_results = [r for r in results if r.get("sqm", -1) > 0]

    print("\n")
    print("=" * 40)
    print("Scan complete!")
    print("Total: {} points | Valid: {} | Errors: {}".format(len(results), len(valid_results), error_count))
    print("Duration: {}".format(format_duration(elapsed)))
    print("Saved to: {}".format(output_file))

    if valid_results:
        sqms = sorted([r["sqm"] for r in valid_results], reverse=True)
        print("\nSQM Stats:")
        print("   Best:    {} (Bortle {})".format(sqms[0], sqm_to_bortle(sqms[0])))
        print("   Median:  {} (Bortle {})".format(sqms[len(sqms) // 2], sqm_to_bortle(sqms[len(sqms) // 2])))
        print("   Worst:   {} (Bortle {})".format(sqms[-1], sqm_to_bortle(sqms[-1])))

        bortle_counts = {}
        for r in valid_results:
            b = r["bortle"]
            bortle_counts[b] = bortle_counts.get(b, 0) + 1

        print("\nBortle Distribution:")
        for b in range(1, 10):
            if b in bortle_counts:
                count = bortle_counts[b]
                pct = count / len(valid_results) * 100
                bar = "#" * max(1, int(pct / 2))
                print("   Bortle {}: {} {} ({:.1f}%)".format(b, bar, count, pct))

    if os.path.abspath(os.path.dirname(output_file)) == os.path.abspath(PUBLIC_DATA_DIR):
        rel = os.path.relpath(output_file, REPO_ROOT)
        print("\nReady to use in the web app — picker will list {}".format(rel))
    else:
        print("\nNext step: Copy {} to public/data/ in your FindDarkSite web app.".format(output_file))


if __name__ == "__main__":
    main()
