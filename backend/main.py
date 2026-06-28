from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn
import requests
import osmnx as ox
from shapely.geometry import LineString, MultiLineString
import httpx
import os
import random
import hashlib
import tempfile
import asyncio
import json
import time

# ─────────────────────────────────────────────────────
# Google API Key
# ─────────────────────────────────────────────────────
GOOGLE_API_KEY = "PASTE_YOUR_GOOGLE_API_KEY_HERE"
if os.path.exists(".env.py"):
    try:
        with open(".env.py", "r") as f:
            for line in f.readlines():
                if 'GOOGLE_API_KEY="' in line:
                    GOOGLE_API_KEY = line.split('GOOGLE_API_KEY="')[1].split('"')[0]
        if GOOGLE_API_KEY and "PASTE" not in GOOGLE_API_KEY:
            print("✅ Google Street View Active")
        else:
            print("⚠️  No Google API Key — demo mode")
    except Exception as e:
        print(f"Key load error: {e}")

HAS_API_KEY = bool(GOOGLE_API_KEY) and "PASTE" not in GOOGLE_API_KEY

# ─────────────────────────────────────────────────────
# AI Engine
# ─────────────────────────────────────────────────────
MODEL_URL  = "https://huggingface.co/peterhdd/pothole-detection-yolov8/resolve/main/best.pt"
MODEL_PATH = "pothole_model.pt"
ai_model   = None
AI_ENABLED = False

try:
    from ultralytics import YOLO
    if not os.path.exists(MODEL_PATH):
        print("⏳ Downloading AI model…")
        import urllib.request
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    ai_model   = YOLO(MODEL_PATH)
    AI_ENABLED = True
    print("✅ AI Engine ready.")
except Exception as e:
    print(f"❌ AI init: {e}")

# ─────────────────────────────────────────────────────
# FastAPI
# ─────────────────────────────────────────────────────
app = FastAPI(title="Pothole AI — Streaming Scanner")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────
class AreaScan(BaseModel):
    lat:    float
    lng:    float
    radius: int = 400

class Location(BaseModel):
    lat: float
    lng: float

# ─────────────────────────────────────────────────────
# Demo images
# ─────────────────────────────────────────────────────
DEMO_IMAGES = [
    "https://images.unsplash.com/photo-1515162305285-0293e4767cc2?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1599740831464-5cbb14ee8704?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1588614959060-4d144f28b2ee?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1470240731273-7821a6eeb6bd?auto=format&fit=crop&q=80&w=800",
]

# ─────────────────────────────────────────────────────
# SSE helper
# ─────────────────────────────────────────────────────
def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

# ─────────────────────────────────────────────────────
# Async Street View metadata check (NO blocking requests)
# ─────────────────────────────────────────────────────
async def check_sv_coverage_async(client: httpx.AsyncClient, lat: float, lng: float) -> bool:
    """Non-blocking Street View metadata check."""
    if not HAS_API_KEY:
        return True
    try:
        url = (
            f"https://maps.googleapis.com/maps/api/streetview/metadata"
            f"?location={lat},{lng}&radius=50&key={GOOGLE_API_KEY}"
        )
        res  = await client.get(url, timeout=6)
        data = res.json()
        return data.get("status") == "OK"
    except:
        return False

# ─────────────────────────────────────────────────────
# Find covered point — fully async, parallel checks
# ─────────────────────────────────────────────────────
async def find_covered_point_async(client: httpx.AsyncClient, geometry: list):
    if not geometry:
        return None
    n = len(geometry)

    # Phase 1: check 3 priority points simultaneously
    priority = list(dict.fromkeys([n // 4, n // 2, (3 * n) // 4, 0, n - 1]))
    results  = await asyncio.gather(*[
        check_sv_coverage_async(client, geometry[i][0], geometry[i][1])
        for i in priority
    ])
    for idx, covered in zip(priority, results):
        if covered:
            return (geometry[idx][0], geometry[idx][1])

    # Phase 2: remaining nodes in batches of 5
    remaining = [i for i in range(n) if i not in priority]
    for batch_start in range(0, len(remaining), 5):
        batch   = remaining[batch_start:batch_start + 5]
        results = await asyncio.gather(*[
            check_sv_coverage_async(client, geometry[i][0], geometry[i][1])
            for i in batch
        ])
        for idx, covered in zip(batch, results):
            if covered:
                return (geometry[idx][0], geometry[idx][1])

    return None

# ─────────────────────────────────────────────────────
# Street View image URL
# ─────────────────────────────────────────────────────
def sv_url(lat: float, lng: float, heading: int = 0) -> str:
    if HAS_API_KEY:
        return (
            f"https://maps.googleapis.com/maps/api/streetview"
            f"?size=800x450&location={lat},{lng}"
            f"&heading={heading}&fov=90&pitch=-10&key={GOOGLE_API_KEY}"
        )
    return random.choice(DEMO_IMAGES)

# ─────────────────────────────────────────────────────
# YOLO on URL
# ─────────────────────────────────────────────────────
async def run_yolo_url(client: httpx.AsyncClient, image_url: str):
    tmp = None
    try:
        r = await client.get(image_url, timeout=15)
        r.raise_for_status()
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            f.write(r.content)
            tmp = f.name
        loop    = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, lambda: ai_model(tmp, conf=0.15, stream=False))
        return results
    except Exception as e:
        print(f"YOLO URL error: {e}")
        return []
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)

# ─────────────────────────────────────────────────────
# YOLO on bytes
# ─────────────────────────────────────────────────────
async def run_yolo_bytes(image_bytes: bytes):
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            f.write(image_bytes)
            tmp = f.name
        loop    = asyncio.get_event_loop()
        results = await loop.run_in_executor(None, lambda: ai_model(tmp, conf=0.15, stream=False))
        return results
    except Exception as e:
        print(f"YOLO bytes error: {e}")
        return []
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)

# ─────────────────────────────────────────────────────
# OSM road fetch via OSMnx
# ─────────────────────────────────────────────────────
async def fetch_roads_async(lat: float, lng: float, radius: int) -> list:
    """
    Fetch roads using OSMnx instead of the Overpass API.
    Returns the same format as the original code.
    """
    def worker():
        graph = ox.graph_from_point(
            (lat, lng),
            dist=radius,
            network_type="drive",
            simplify=True
        )

        edges = ox.graph_to_gdfs(graph, nodes=False)

        roads = []
        seen = set()

        for _, row in edges.iterrows():
            geometry = row.geometry
            path = []

            if isinstance(geometry, LineString):
                coords = list(geometry.coords)
                for lon, lat_val in coords:
                    path.append([lat_val, lon])

            elif isinstance(geometry, MultiLineString):
                for line in geometry.geoms:
                    for lon, lat_val in line.coords:
                        path.append([lat_val, lon])
            else:
                continue

            if len(path) < 2:
                continue

            name = row.get("name")
            if isinstance(name, list):
                name = name[0]

            if not name:
                highway = row.get("highway", "Road")
                if isinstance(highway, list):
                    highway = highway[0]
                name = str(highway).replace("_", " ").title()

            road_key = (
                tuple(path[0]),
                tuple(path[-1]),
                name
            )

            if road_key in seen:
                continue

            seen.add(road_key)

            # Stable id derived from the road's endpoints + name, NOT from
            # array order. This means the same physical road gets the same
            # id across repeated scans of an overlapping area, which the
            # frontend (and the dedup below) can rely on.
            stable_id = int(
                hashlib.sha1(
                    f"{road_key[0]}|{road_key[1]}|{road_key[2]}".encode()
                ).hexdigest()[:8],
                16,
            )

            roads.append({
                "id": stable_id,
                "name": name,
                "geometry": path
            })

        print(f"OSMnx: {len(roads)} roads found")
        return roads

    return await asyncio.to_thread(worker)

# ─────────────────────────────────────────────────────
# Parse YOLO → potholes
#
# IMPORTANT: coordinates used to be jittered with random.random(), which
# meant the *same* real-world pothole would land at a different lat/lng
# every single time it was detected on a rescan — often by more than the
# frontend's 3m dedup radius. That's what caused potholes to keep
# reappearing as "new" and the count to climb forever.
#
# Fix: derive a deterministic point along the road path from the
# detection's own (stable) attributes, so re-detecting the same real
# pothole on a later scan produces the same coordinate (or close enough
# to land inside the dedup radius), while still spreading multiple
# distinct detections along the road instead of stacking them all at
# one point.
# ─────────────────────────────────────────────────────
def parse_detections(results, scan_lat, scan_lng, path, road_name, road_id, heading):
    out = []
    for r in results:
        for i, box in enumerate(r.boxes):
            conf = float(box.conf)
            sev  = "High" if conf > 0.6 else "Medium" if conf > 0.4 else "Low"

            # Bounding box center fraction (0..1 across the image width)
            # — gives each detection in the same image a distinct but
            # deterministic offset instead of a random one.
            try:
                xywh = box.xywh[0]
                x_frac = float(xywh[0]) / float(r.orig_shape[1])
            except Exception:
                x_frac = 0.5

            # Deterministic index along the road path based on the
            # detection's position in the image + heading, NOT randomness.
            if path and len(path) > 1:
                path_idx = int(x_frac * (len(path) - 1))
                snap = path[path_idx]
            else:
                snap = [scan_lat, scan_lng]

            # Stable id: same road + same snapped path index + same
            # heading bucket => same id, so a rescan recognizes "this is
            # the pothole I already logged" rather than minting a new one.
            stable_key = f"{road_id}|{path_idx if path and len(path) > 1 else 0}|{heading}"
            stable_id = int(hashlib.sha1(stable_key.encode()).hexdigest()[:10], 16)

            out.append({
                "id":        stable_id,
                "lat":       snap[0],
                "lng":       snap[1],
                "severity":  sev,
                "timestamp": f"AI ({int(conf * 100)}%)",
                "road":      road_name,
                "path":      path,
                "conf":      round(conf, 3),
            })
    return out

# ─────────────────────────────────────────────────────
# STREAMING endpoint — /scan-stream
# ─────────────────────────────────────────────────────
@app.get("/scan-stream")
async def scan_stream(lat: float, lng: float, radius: int = 400):
    async def generator():
        yield sse("status", {"msg": "Fetching road network…"})

        roads = await fetch_roads_async(lat, lng, radius)

        if not roads:
            yield sse("done", {"roads_total": 0, "roads_scanned": 0, "potholes_total": 0})
            return

        roads_total  = len(roads)
        roads_scanned = 0
        potholes_total = 0

        yield sse("roads_found", {
            "roads_total": roads_total,
            "roads":       [{"id": r["id"], "name": r["name"], "path": r["geometry"]} for r in roads],
        })

        sem = asyncio.Semaphore(6)

        async def process_road(road):
            nonlocal roads_scanned, potholes_total
            name     = road["name"]
            geometry = road["geometry"]
            road_id  = road["id"]

            async with sem:
                yield_queue.put_nowait(sse("road_scanning", {
                    "road_id":   road_id,
                    "road_name": name,
                    "path":      geometry,
                }))

                async with httpx.AsyncClient(timeout=10) as client:
                    covered = await find_covered_point_async(client, geometry)

                if covered is None:
                    yield_queue.put_nowait(sse("road_skipped", {
                        "road_id":   road_id,
                        "road_name": name,
                        "path":      geometry,
                        "reason":    "no_coverage",
                    }))
                    return

                scan_lat, scan_lng = covered
                url0 = sv_url(scan_lat, scan_lng, heading=0)
                url1 = sv_url(scan_lat, scan_lng, heading=180)

                potholes = []

                if AI_ENABLED:
                    async with httpx.AsyncClient(timeout=20) as client:
                        r0, r1 = await asyncio.gather(
                            run_yolo_url(client, url0),
                            run_yolo_url(client, url1),
                        )
                    potholes += parse_detections(r0, scan_lat, scan_lng, geometry, name, road_id, heading=0)
                    potholes += parse_detections(r1, scan_lat, scan_lng, geometry, name, road_id, heading=180)
                else:
                    # Demo mode: deterministic per-road "coin flip" instead of
                    # random.random(), so the same road consistently does or
                    # doesn't have a demo pothole across rescans, at a fixed
                    # point along its path (no jitter).
                    demo_roll = int(hashlib.sha1(f"demo|{road_id}".encode()).hexdigest()[:4], 16) / 0xFFFF
                    if demo_roll < 0.5:
                        path_idx = len(geometry) // 2
                        snap = geometry[path_idx]
                        stable_id = int(hashlib.sha1(f"{road_id}|{path_idx}|demo".encode()).hexdigest()[:10], 16)
                        potholes.append({
                            "id":        stable_id,
                            "lat":       snap[0],
                            "lng":       snap[1],
                            "severity":  ["High", "Medium", "Medium", "Low"][stable_id % 4],
                            "timestamp": "Demo scan",
                            "road":      name,
                            "path":      geometry,
                            "conf":      None,
                        })

                roads_scanned  += 1
                potholes_total += len(potholes)

                yield_queue.put_nowait(sse("road_scanned", {
                    "road_id":     road_id,
                    "road_name":   name,
                    "path":        geometry,
                    "scan_point":  {"lat": scan_lat, "lng": scan_lng},
                    "sv_image":    url0,
                    "potholes":    potholes,
                    "roads_done":  roads_scanned,
                    "roads_total": roads_total,
                }))

        yield_queue: asyncio.Queue = asyncio.Queue()

        async def run_all():
            await asyncio.gather(*[process_road(r) for r in roads])
            yield_queue.put_nowait(None)

        asyncio.create_task(run_all())

        while True:
            item = await yield_queue.get()
            if item is None:
                break
            yield item

        yield sse("done", {
            "roads_total":   roads_total,
            "roads_scanned": roads_scanned,
            "potholes_total": potholes_total,
        })

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":               "no-cache",
            "X-Accel-Buffering":           "no",
            "Access-Control-Allow-Origin": "*",
        },
    )

# ─────────────────────────────────────────────────────
# Legacy non-streaming endpoint
# ─────────────────────────────────────────────────────
@app.post("/scan-area")
async def scan_area(req: AreaScan):
    roads = await fetch_roads_async(req.lat, req.lng, req.radius)
    if not roads:
        return {"potholes": [], "roads": [], "real_image": None,
                "mode": "NO STREET VIEW COVERAGE", "roads_scanned": 0, "roads_total": 0}

    sem = asyncio.Semaphore(6)

    async def scan_one(road):
        async with sem:
            async with httpx.AsyncClient(timeout=10) as client:
                covered = await find_covered_point_async(client, road["geometry"])
            if not covered:
                return [], None, False
            slat, slng = covered
            u0 = sv_url(slat, slng, 0)
            u1 = sv_url(slat, slng, 180)
            potholes = []
            if AI_ENABLED:
                async with httpx.AsyncClient(timeout=20) as client:
                    r0, r1 = await asyncio.gather(run_yolo_url(client, u0), run_yolo_url(client, u1))
                potholes += parse_detections(r0, slat, slng, road["geometry"], road["name"], road["id"], heading=0)
                potholes += parse_detections(r1, slat, slng, road["geometry"], road["name"], road["id"], heading=180)
            else:
                demo_roll = int(hashlib.sha1(f"demo|{road['id']}".encode()).hexdigest()[:4], 16) / 0xFFFF
                if demo_roll < 0.5:
                    path_idx = len(road["geometry"]) // 2
                    snap = road["geometry"][path_idx]
                    stable_id = int(hashlib.sha1(f"{road['id']}|{path_idx}|demo".encode()).hexdigest()[:10], 16)
                    potholes.append({"id": stable_id,
                        "lat": snap[0], "lng": snap[1],
                        "severity": ["High", "Medium", "Medium", "Low"][stable_id % 4],
                        "timestamp": "Demo", "road": road["name"],
                        "path": road["geometry"], "conf": None})
            return potholes, u0, True

    results       = await asyncio.gather(*[scan_one(r) for r in roads])
    all_potholes  = []
    roads_scanned = 0
    last_img      = None
    for ph, img, ok in results:
        if ok:
            roads_scanned += 1
            if img and not last_img:
                last_img = img
        all_potholes.extend(ph)

    if roads_scanned == 0:
        return {"potholes": [], "roads": [{"id": r["id"], "name": r["name"], "path": r["geometry"]} for r in roads],
                "real_image": None, "mode": "NO STREET VIEW COVERAGE",
                "roads_scanned": 0, "roads_total": len(roads)}

    return {"potholes": all_potholes,
            "roads": [{"id": r["id"], "name": r["name"], "path": r["geometry"]} for r in roads],
            "real_image": last_img,
            "mode": "LIVE AI SCAN" if AI_ENABLED else "STREET SCAN (Demo)",
            "roads_scanned": roads_scanned, "roads_total": len(roads)}

# ─────────────────────────────────────────────────────
# Upload scan
# ─────────────────────────────────────────────────────
@app.post("/scan-upload")
async def scan_upload(file: UploadFile = File(...), lat: float = 0.0, lng: float = 0.0):
    if not AI_ENABLED:
        return {"error": "AI model not loaded", "potholes": [], "mode": "AI DISABLED"}
    image_bytes = await file.read()
    road_path, road_name, road_id = None, "Uploaded image", 0
    if lat and lng:
        roads = await fetch_roads_async(lat, lng, 200)
        if roads:
            road_path = roads[0]["geometry"]
            road_name = roads[0]["name"]
            road_id   = roads[0]["id"]
    try:
        results  = await run_yolo_bytes(image_bytes)
        potholes = parse_detections(results, lat, lng, road_path or [[lat, lng]], road_name, road_id, heading=0)
        return {"potholes": potholes, "total_detected": len(potholes),
                "filename": file.filename, "mode": "UPLOAD AI SCAN"}
    except Exception as e:
        return {"error": str(e), "potholes": [], "mode": "ERROR"}

@app.get("/")
def root():
    return {"status": "✅ Pothole AI running", "ai_enabled": AI_ENABLED,
            "google_sv": HAS_API_KEY,
            "endpoints": ["/scan-stream (GET+SSE)", "/scan-area (POST)", "/scan-upload (POST)"]}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
