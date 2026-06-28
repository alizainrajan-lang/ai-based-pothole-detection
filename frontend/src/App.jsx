import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Circle, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
    ShieldAlert, Activity, Navigation, LocateFixed,
    Camera, X, AlertTriangle, Moon, Sun, MapPin,
    Maximize, Minimize,
} from 'lucide-react';
import L from 'leaflet';
import potholeLogo from "/logo.png";

delete L.Icon.Default.prototype._getIconUrl;

/* ─── Icons ── */
const mkIcon = (color) => new L.Icon({
    iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
    iconSize: [25,41], iconAnchor: [12,41], popupAnchor: [1,-34], shadowSize: [41,41],
});
const ICONS = { High: mkIcon('red'), Medium: mkIcon('orange'), Low: mkIcon('green'), User: mkIcon('blue') };

function MapRecenter({ center, zoom, suspend }) {
    const map = useMap();
    useEffect(() => {
        // suspend covers two cases: mid-transition (container size is
        // momentarily wrong) AND fully in fullscreen mode (the view is
        // owned by FullscreenMapSync's fitBounds, not by zoom state, which
        // still holds the pre-fullscreen value).
        if (center && !suspend) {
            map.setView(center, zoom, { animate: true });
        }
    }, [center, zoom, suspend, map]);
    return null;
}

// Whenever fullscreen toggles, the map container's pixel size changes
// (sidebar sliding in/out over a .25s CSS transition). Leaflet caches its
// container size internally and needs invalidateSize() to notice the
// change, and fitBounds() needs that corrected size to compute a sane
// zoom/pan.
//
// Previously this was split across two separate effects (one calling
// invalidateSize() immediately, another fitBounds() also immediately, plus
// a third one re-invalidating 80ms later) that fired independently and
// raced each other. Because the sidebar transition takes 250ms, the
// immediate calls measured the container mid-transition — a partially
// collapsed, transitional width — and fitBounds() then computed a zoom/pan
// for that bogus size. That's what produced the blank/black map: Leaflet
// ended up requesting tiles for a nonsensical viewport.
//
// Fix: a single effect, gated behind a timeout long enough for the CSS
// transition to actually finish, that invalidates size and (only when
// entering fullscreen) fits bounds — once, in the right order, with no
// other effect able to interleave and stomp on it. A second, separate
// effect keeps the fitted view following `center` if the scan location
// changes while already in fullscreen (e.g. GPS movement re-triggering a
// scan at a new origin) — no invalidateSize delay needed there since the
// container size is already stable at that point, just a re-fit.
const SIDEBAR_TRANSITION_MS = 250;

function FullscreenMapSync({ isFullscreen, center, radiusMeters }) {
    const map = useMap();

    // Handles the toggle itself: wait for the sidebar transition to finish,
    // then resync size and (if entering) fit to the circle.
    useEffect(() => {
        const t = setTimeout(() => {
            map.invalidateSize();
            if (isFullscreen && center) {
                const circle = L.circle(center, { radius: radiusMeters });
                map.fitBounds(circle.getBounds(), { padding: [24, 24], animate: true });
            }
        }, SIDEBAR_TRANSITION_MS + 30);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFullscreen, map]);

    // Handles staying centered while already fullscreen, if `center` moves.
    // Skipped on the render where isFullscreen itself just changed — the
    // effect above already owns that transition.
    const wasFullscreenRef = useRef(isFullscreen);
    useEffect(() => {
        const justToggled = wasFullscreenRef.current !== isFullscreen;
        wasFullscreenRef.current = isFullscreen;
        if (justToggled || !isFullscreen || !center) return;
        const circle = L.circle(center, { radius: radiusMeters });
        map.fitBounds(circle.getBounds(), { padding: [24, 24], animate: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [center, radiusMeters]);

    return null;
}

const BACKEND = 'http://localhost:8000';

// How far (meters) the GPS has to drift from the last scan origin before
// we treat it as "the user actually moved" and kick off a new scan.
// Anything smaller is just GPS jitter and should NOT restart scanning.
const RESCAN_DISTANCE_THRESHOLD_M = 120;

// The scan radius requested from the backend, and the radius of the dashed
// circle drawn on the map. Kept as one constant so the fullscreen zoom-fit
// calculation and the actual scan request never drift out of sync.
const SCAN_RADIUS_M = 400;

/* ─── Themes ── */
const THEMES = {
    dark: {
        bg: '#0d1117', surface: '#161b22', panel: '#1c2333', panelHover: '#21293a',
        border: 'rgba(255,255,255,0.08)', borderMd: 'rgba(255,255,255,0.13)',
        text: '#e6edf3', textSub: '#8b949e', textMuted: '#484f58',
        accent: '#1f6feb', accentBg: 'rgba(31,111,235,0.12)', accentBorder: 'rgba(31,111,235,0.3)',
        tileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    },
    light: {
        bg: '#f6f8fa', surface: '#ffffff', panel: '#f0f2f5', panelHover: '#e8eaed',
        border: 'rgba(0,0,0,0.09)', borderMd: 'rgba(0,0,0,0.14)',
        text: '#1c2128', textSub: '#57606a', textMuted: '#afb8c1',
        accent: '#0969da', accentBg: 'rgba(9,105,218,0.08)', accentBorder: 'rgba(9,105,218,0.25)',
        tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    },
};

/* ─── Severity ── */
const SEV = {
    High:   { color: '#e53e3e', bg: 'rgba(229,62,62,0.1)',  border: 'rgba(229,62,62,0.25)',  label: 'Critical', poly: '#e53e3e' },
    Medium: { color: '#dd6b20', bg: 'rgba(221,107,32,0.1)', border: 'rgba(221,107,32,0.25)', label: 'Warning',  poly: '#dd6b20' },
    Low:    { color: '#38a169', bg: 'rgba(56,161,105,0.1)', border: 'rgba(56,161,105,0.25)', label: 'Minor',    poly: '#38a169' },
};

/* ─── Road highlight states ──
   "skipped" used to mean "no Street View coverage" only, and roads that
   simply hadn't been scanned yet *also* defaulted into that same bucket,
   so the whole network looked grey/dashed until each road's turn came up.
   Now we distinguish "not yet scanned" (idle teal, per the requested key
   color) from "scanned but no coverage" (grey/dashed) so the map reads
   correctly at every stage of the scan. ── */
const ROAD_COLORS = {
    idle:            '#2dd4bf', // teal — discovered, not scanned yet (or session reset)
    scanning:        '#f59e0b', // amber — actively being scanned right now
    scanned_clean:   '#2dd4bf', // teal — scanned, no potholes found
    scanned_pothole: '#e53e3e', // red  — scanned, potholes found
    no_coverage:     '#4b5563', // grey/dashed — scanned, but no Street View available
};

/* ─── Helper: Distance between two GPS points in meters ── */
const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
};

/* ─── CSS ── */
const buildCSS = (t) => `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:${t.bg};color:${t.text};height:100vh;overflow:hidden;transition:background .2s,color .2s}
  .app{display:flex;height:100vh}
  .fullscreen-btn-active{background:${t.accent}!important;color:#fff!important;border-color:${t.accent}!important}

  /* sidebar */
  .sidebar{width:292px;flex-shrink:0;display:flex;flex-direction:column;background:${t.surface};border-right:1px solid ${t.border};overflow-y:auto;overflow-x:hidden;transition:margin-left .25s ease,opacity .2s ease}
  .sidebar.sidebar-hidden{margin-left:-292px;opacity:0;pointer-events:none}
  .sidebar::-webkit-scrollbar{width:4px}
  .sidebar::-webkit-scrollbar-thumb{background:${t.borderMd};border-radius:4px}

  /* header */
  .s-header{padding:18px 16px 14px;border-bottom:1px solid ${t.border};display:flex;align-items:center;justify-content:space-between}
  .s-brand{display:flex;align-items:center;gap:10px}
  .s-logo{width:34px;height:34px;border-radius:9px;background:${t.accentBg};border:1px solid ${t.accentBorder};display:flex;align-items:center;justify-content:center;color:${t.accent};flex-shrink:0}
  .s-title{font-size:14px;font-weight:600;color:${t.text};letter-spacing:-.01em}
  .s-sub{font-size:11px;color:${t.textSub};margin-top:1px}
  .theme-btn{width:30px;height:30px;border-radius:7px;background:${t.panel};border:1px solid ${t.border};color:${t.textSub};cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
  .theme-btn:hover{background:${t.panelHover};color:${t.text}}

  .s-label{padding:14px 16px 6px;font-size:10px;font-weight:600;color:${t.textMuted};letter-spacing:.08em;text-transform:uppercase}

  /* actions */
  .s-actions{padding:12px 12px 12px;display:flex;flex-direction:column;gap:8px}
  .btn-primary{width:100%;padding:11px 14px;border-radius:10px;border:none;cursor:pointer;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .15s;font-family:'Inter',sans-serif}
  .btn-start{background:${t.accentBg};color:${t.accent};border:1px solid ${t.accentBorder}}
  .btn-start:hover{background:${t.accent};color:#fff}
  .btn-stop{background:rgba(56,161,105,0.1);color:#38a169;border:1px solid rgba(56,161,105,0.28)}
  .btn-stop:hover{background:#38a169;color:#fff}

  /* progress bar */
  .scan-progress-wrap{margin:0 12px 10px;background:${t.panel};border:1px solid ${t.border};border-radius:9px;overflow:hidden}
  .scan-progress-bar{height:4px;background:${t.accent};transition:width .4s ease;border-radius:9px}
  .scan-progress-label{padding:7px 11px;font-size:10px;color:${t.textSub};display:flex;justify-content:space-between}

  /* status */
  .s-status{padding:8px 12px 12px}
  .status-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;font-size:11px;font-weight:500}
  .pill-active{background:rgba(56,161,105,0.1);color:#38a169;border:1px solid rgba(56,161,105,0.28)}
  .pill-scan{background:rgba(139,92,246,0.1);color:#8b5cf6;border:1px solid rgba(139,92,246,0.28)}
  .pill-idle{background:${t.panel};color:${t.textSub};border:1px solid ${t.border}}
  .pill-err{background:rgba(229,62,62,0.08);color:#e53e3e;border:1px solid rgba(229,62,62,0.2)}
  .pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .pill-dot.pulse{animation:blink 1.4s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}

  .divider{height:1px;background:${t.border};margin:4px 12px}

  /* feed */
  .feed-card{margin:0 12px 12px;border-radius:10px;overflow:hidden;border:1px solid ${t.borderMd};background:${t.panel};flex-shrink:0}
  .feed-img-wrap{position:relative;height:148px;min-height:148px;max-height:148px;overflow:hidden;background:${t.panel}}
  .feed-img{width:100%;height:100%;object-fit:cover;object-position:center;display:block;animation:fadein .25s ease}
  @keyframes fadein{from{opacity:0}to{opacity:1}}
  .feed-img-placeholder{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:${t.textMuted};font-size:11px}
  .feed-scan-line{position:absolute;left:0;right:0;height:2px;background:rgba(31,111,235,0.5);animation:scanline 2.4s linear infinite;pointer-events:none}
  .feed-bar{padding:7px 11px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid ${t.border}}
  .feed-cam{font-size:10px;font-weight:600;color:${t.textMuted};font-family:'JetBrains Mono',monospace;letter-spacing:.04em}
  .feed-coords{font-size:10px;color:${t.textMuted};font-family:'JetBrains Mono',monospace}
  @keyframes scanline{0%{top:0%}100%{top:100%}}

  /* no coverage */
  .no-cov{margin:0 12px 10px;padding:10px 12px;background:rgba(229,62,62,0.07);border:1px solid rgba(229,62,62,0.2);border-radius:9px;display:flex;gap:8px;align-items:flex-start}
  .no-cov p{font-size:11px;color:#fca5a5;line-height:1.5}

  /* stats */
  .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 12px 12px}
  .stat-card{background:${t.panel};border-radius:9px;padding:11px 13px;border:1px solid ${t.border}}
  .stat-label{font-size:10px;font-weight:600;color:${t.textMuted};letter-spacing:.07em;text-transform:uppercase;margin-bottom:5px}
  .stat-val{font-size:22px;font-weight:600;font-family:'JetBrains Mono',monospace;line-height:1}

  /* severity */
  .sev-grid{display:flex;flex-direction:column;gap:6px;padding:0 12px 14px}
  .sev-row{display:flex;align-items:center;gap:10px;padding:8px 11px;border-radius:9px;border:1px solid transparent}
  .sev-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
  .sev-name{font-size:12px;font-weight:500;flex:1}
  .sev-count{font-size:13px;font-weight:600;font-family:'JetBrains Mono',monospace}

  /* road list */
  .road-list{padding:0 12px 14px;display:flex;flex-direction:column;gap:5px}
  .road-item{padding:9px 11px;border-radius:9px;background:${t.panel};border:1px solid ${t.border};transition:all .12s}
  .road-item:hover{background:${t.panelHover};border-color:${t.borderMd}}
  .road-item-name{font-size:12px;font-weight:500;color:${t.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .road-item-meta{font-size:10px;color:${t.textSub};margin-top:3px;display:flex;gap:6px}
  .road-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:600}

  /* map */
  .map-area{flex:1;position:relative;overflow:hidden}
  .map-search{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:900;display:flex;gap:6px}
  .search-wrap{position:relative}
  .search-input{background:${t.surface}cc;border:1px solid ${t.borderMd};color:${t.text};padding:9px 14px;border-radius:9px;font-size:13px;width:270px;outline:none;backdrop-filter:blur(16px);font-family:'Inter',sans-serif;transition:border-color .15s}
  .search-input:focus{border-color:${t.accent}88}
  .search-input::placeholder{color:${t.textMuted}}
  .search-go{background:${t.accent};border:none;color:#fff;padding:9px 13px;border-radius:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
  .search-go:hover{filter:brightness(1.12)}
  .suggestions{position:absolute;top:calc(100% + 5px);left:0;right:0;background:${t.surface}f5;border:1px solid ${t.borderMd};border-radius:9px;backdrop-filter:blur(16px);z-index:901;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.3)}
  .suggestion-item{padding:9px 14px;font-size:12px;cursor:pointer;border-bottom:1px solid ${t.border};color:${t.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .1s}
  .suggestion-item:last-child{border-bottom:none}
  .suggestion-item:hover{background:${t.accentBg};color:${t.accent}}

  /* map controls */
  .loc-controls{position:absolute;bottom:24px;right:14px;z-index:900;display:flex;flex-direction:column;gap:7px}
  .map-btn{width:42px;height:42px;border-radius:9px;background:${t.surface}ee;border:1px solid ${t.borderMd};color:${t.text};cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(12px);transition:all .15s}
  .map-btn:hover{background:${t.surface};border-color:${t.text}44}
  .clear-btn{position:absolute;bottom:24px;left:14px;z-index:900;display:flex;align-items:center;gap:6px;padding:9px 14px;border-radius:9px;background:${t.surface}ee;border:1px solid ${t.borderMd};color:${t.textSub};font-size:12px;font-weight:500;cursor:pointer;backdrop-filter:blur(12px);transition:all .15s;font-family:'Inter',sans-serif}
  .clear-btn:hover{color:${t.text};border-color:${t.text}33}

  /* legend */
  .legend{position:absolute;top:70px;right:14px;z-index:900;background:${t.surface}ee;border:1px solid ${t.borderMd};border-radius:11px;padding:13px 15px;backdrop-filter:blur(12px);min-width:170px}
  .legend-title{font-size:10px;font-weight:600;color:${t.textMuted};letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px}
  .legend-row{display:flex;align-items:center;gap:9px;margin-bottom:7px}
  .legend-row:last-child{margin-bottom:0}
  .legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .legend-line{width:18px;height:3px;border-radius:2px;flex-shrink:0}
  .legend-text{font-size:12px;color:${t.text}}

  /* risk bar */
  .risk-bar{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);z-index:900;background:${t.surface}ee;border:1px solid ${t.borderMd};border-radius:11px;padding:11px 18px;backdrop-filter:blur(12px);display:flex;align-items:center;gap:16px;min-width:240px}
  .risk-track{height:4px;background:${t.panel};border-radius:2px;flex:1;overflow:hidden;min-width:80px}
  .risk-fill{height:100%;border-radius:2px;transition:width .5s ease}

  .leaflet-popup-content-wrapper{border-radius:11px!important;font-family:'Inter',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.25)!important}
  .leaflet-popup-tip{display:none}
`;

/* ─── Main App ── */
export default function App() {
    const [theme, setTheme]           = useState('dark');
    const [location, setLocation]     = useState([24.8607, 67.0011]);
    const [isScanning, setIsScanning] = useState(false);
    const [isTrackingLive, setIsTrackingLive] = useState(false);
    const [zoom, setZoom]             = useState(14);
    const [isFullscreen, setIsFullscreen] = useState(false);
    // True for the brief window while the sidebar is sliding in/out after a
    // fullscreen toggle. MapRecenter suspends its own setView calls during
    // this window so it can never race FullscreenMapSync's post-transition
    // invalidateSize()/fitBounds() — only one thing drives the map view
    // during a transition, instead of two effects fighting over it.
    const [isViewTransitioning, setIsViewTransitioning] = useState(false);
    useEffect(() => {
        setIsViewTransitioning(true);
        const t = setTimeout(() => setIsViewTransitioning(false), SIDEBAR_TRANSITION_MS + 60);
        return () => clearTimeout(t);
    }, [isFullscreen]);

    // Pothole markers (deduped, accumulated across the whole session)
    const [potholes, setPotholes]     = useState([]);
    // Ids we've already accepted, for O(1) duplicate checks alongside the
    // distance-based check (covers cases where the backend's stable id
    // matches exactly, e.g. an unmoved rescan of the same road).
    const seenPotholeIdsRef = useRef(new Set());

    // Road states
    const [roadStates, setRoadStates] = useState({});

    const [realImage, setRealImage]   = useState(null);
    // Why the feed kept shrinking / eventually went blank:
    // `realImage` is a raw Google Street View URL. Every road_scanned event
    // points it at a brand-new lat/lng, so the browser has to make a fresh
    // network request to Google for every single road — often several per
    // second during a fast scan. When that request hits a rate limit, an
    // invalid/missing API key, or a location Google has no real imagery
    // for, Google still responds 200 OK, but with a tiny placeholder/error
    // graphic instead of an 800x450 photo. The browser's onload event
    // fires successfully for that tiny image too — there's nothing wrong
    // with the *request* — so the old code happily promoted it, and
    // `object-fit:cover` rendering of a much-smaller-than-container image
    // is exactly what produced the "shrinking, then totally blank" feed.
    // Fix: after preloading, check the image's actual decoded pixel size
    // and reject anything implausibly small as a placeholder/error, rather
    // than trusting that onload firing means it's a real photo.
    const MIN_VALID_IMAGE_DIM = 300; // real Street View photos are 800x450
    const pendingImageRef = useRef(null);
    const setRealImageQueued = useCallback((url) => {
        if (!url) return;
        pendingImageRef.current = url;
        const img = new Image();
        img.onload = () => {
            // Only promote if this is still the most recently requested
            // image — an even newer one may have superseded it while loading.
            if (pendingImageRef.current !== url) return;
            const looksReal = img.naturalWidth >= MIN_VALID_IMAGE_DIM && img.naturalHeight >= 150;
            if (looksReal) {
                setRealImage(url);
            }
            // If it doesn't look real, silently keep showing whatever the
            // feed currently has — never replace a good photo with a
            // placeholder/error graphic.
        };
        img.onerror = () => {
            // Network failure / non-image response: drop silently, keep
            // showing the last good image.
        };
        img.src = url;
    }, []);
    const [scanMode, setScanMode]     = useState('Idle');
    const [noCoverage, setNoCoverage] = useState(false);

    // Progress
    const [progress, setProgress]     = useState({ done: 0, total: 0, scanning: '' });

    // Search
    const [searchQuery, setSearchQuery]         = useState('');
    const [isSearching, setIsSearching]         = useState(false);
    const [suggestions, setSuggestions]         = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);

    const evtRef          = useRef(null);
    const scanIntervalRef = useRef(null);
    // Where the *current* scan was launched from. Distinct from `location`,
    // which can move continuously with GPS. Only meaningful movement away
    // from this point should ever trigger a new scan.
    const scanOriginRef   = useRef(null);
    // True while an EventSource stream is actively open. Prevents a second
    // triggerScan() call from stomping an in-flight scan.
    const isScanActiveRef = useRef(false);
    // Always-current location, readable from the interval callback without
    // needing `location` in that effect's dependency array.
    const locationRef     = useRef(location);
    useEffect(() => { locationRef.current = location; }, [location]);

    const t = THEMES[theme];

    // Zoom level 16 securely fits the 400m radius diameter inside common desktop display boundaries
    useEffect(() => { setZoom(isScanning ? 16 : 14); }, [isScanning]);

    /* suggestions debounce */
    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchQuery.length > 2) fetchSuggestions();
            else { setSuggestions([]); setShowSuggestions(false); }
        }, 400);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    /* ── Monitoring session lifecycle ──
       This effect only depends on isScanning now. It does NOT depend on
       `location`, so GPS jitter (location updates) can no longer restart
       it. Starting a session kicks off the first scan from wherever
       `location` is *at that moment*, then sets up a periodic rescan timer
       that always reads the *current* location via a ref. */
    useEffect(() => {
        if (isScanning) {
            triggerScan(locationRef.current[0], locationRef.current[1]);
            scanIntervalRef.current = setInterval(() => {
                const [curLat, curLng] = locationRef.current;
                triggerScan(curLat, curLng);
            }, 60000);
        } else {
            clearInterval(scanIntervalRef.current);
            evtRef.current?.close();
            isScanActiveRef.current = false;
        }
        return () => {
            clearInterval(scanIntervalRef.current);
            evtRef.current?.close();
            isScanActiveRef.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isScanning]);

    /* GPS watch — updates the live marker position on every tick (so the
       blue dot tracks smoothly), but only calls triggerScan when the user
       has actually moved RESCAN_DISTANCE_THRESHOLD_M away from where the
       last scan was centered. Small GPS jitter just moves the marker. */
    useEffect(() => {
        let watchId = null;
        if (isScanning && isTrackingLive && navigator.geolocation) {
            watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const loc = [pos.coords.latitude, pos.coords.longitude];
                    setLocation(loc);

                    const origin = scanOriginRef.current;
                    if (!origin) return;
                    const moved = getDistanceMeters(origin[0], origin[1], loc[0], loc[1]);
                    if (moved >= RESCAN_DISTANCE_THRESHOLD_M) {
                        triggerScan(loc[0], loc[1]);
                    }
                },
                (err) => console.error('GPS error:', err),
                { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 }
            );
        }
        return () => { if (watchId) navigator.geolocation.clearWatch(watchId); };
    }, [isScanning, isTrackingLive]);

    const fetchSuggestions = async () => {
        try {
            const res  = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5`);
            const data = await res.json();
            setSuggestions(data);
            setShowSuggestions(data.length > 0);
        } catch {}
    };

    const handleLocate = () => {
        setIsTrackingLive(true);
        setZoom(16);
        navigator.geolocation?.getCurrentPosition(
            (pos) => {
                const loc = [pos.coords.latitude, pos.coords.longitude];
                setLocation(loc);
                triggerScan(loc[0], loc[1]);
            },
            () => alert('Location access denied.')
        );
    };

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        setIsTrackingLive(false);
        try {
            const res  = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`);
            const data = await res.json();
            if (data?.length > 0) {
                const loc = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
                setZoom(16);
                setLocation(loc);
                setShowSuggestions(false);
                triggerScan(loc[0], loc[1]);
            } else alert('Location not found.');
        } catch { alert('Search failed.'); }
        setIsSearching(false);
    };

    /* ── Core: open SSE stream ──
       Guarded two ways:
       1) Only runs while monitoring is actively turned on. Locate/search/
          preset buttons used to call this unconditionally, which meant
          tapping a preset location silently started scanning even if you
          had never pressed "Start monitoring" — only the Start button
          should ever begin a scan session.
       2) Can't interrupt a scan already in flight for the current origin —
          if one is genuinely running, this just returns; the periodic
          timer or next deliberate action gets a fresh chance once the
          current one finishes. */
    const triggerScan = (lat, lng) => {
        if (!isScanning) {
            return;
        }
        if (isScanActiveRef.current) {
            return;
        }
        isScanActiveRef.current = true;
        scanOriginRef.current = [lat, lng];

        evtRef.current?.close();

        setNoCoverage(false);
        setScanMode('Scanning…');
        setProgress({ done: 0, total: 0, scanning: 'Connecting…' });

        // Reset road highlight state for the new scan area only — accumulated
        // pothole markers (and their dedup-id set) are deliberately left
        // alone, per the "accumulate across the session" choice.
        setRoadStates({});

        const url = `${BACKEND}/scan-stream?lat=${lat}&lng=${lng}&radius=${SCAN_RADIUS_M}`;
        const es  = new EventSource(url);
        evtRef.current = es;

        es.addEventListener('status', (e) => {
            const d = JSON.parse(e.data);
            setProgress(p => ({ ...p, scanning: d.msg }));
        });

        es.addEventListener('roads_found', (e) => {
            const d = JSON.parse(e.data);
            setProgress({ done: 0, total: d.roads_total, scanning: `Found ${d.roads_total} roads` });

            // Register all discovered geometry tracks as "idle" (teal) so the
            // whole network is visible immediately, before each road's turn
            // to be scanned comes up.
            const initialStates = {};
            d.roads.forEach((road) => {
                initialStates[road.id] = { path: road.path, state: 'idle', name: road.name };
            });
            setRoadStates(initialStates);
        });

        es.addEventListener('road_scanning', (e) => {
            const d = JSON.parse(e.data);
            setProgress(p => ({ ...p, scanning: `Scanning ${d.road_name}…` }));
            setRoadStates(prev => ({
                ...prev,
                [d.road_id]: { path: d.path, state: 'scanning', name: d.road_name },
            }));
        });

        es.addEventListener('road_scanned', (e) => {
            const d = JSON.parse(e.data);

            setProgress({ done: d.roads_done, total: d.roads_total, scanning: `Scanned ${d.road_name}` });

            // Defer setting road color until we know how many detections
            // actually SURVIVE dedup. Marking the road red based on the raw
            // backend count (before dedup) is what caused roads to show red
            // with no marker on them: the backend reported a detection, but
            // the frontend recognized it as a duplicate of a marker already
            // placed (e.g. from a rescan, or an adjacent road sharing a
            // snapped point near an intersection) and dropped it — leaving
            // the road painted red for a marker that was never added.
            if (d.sv_image) setRealImageQueued(d.sv_image);

            const rawPotholes = d.potholes || [];
            let survivorCount = 0;

            if (rawPotholes.length > 0) {
                const normed = rawPotholes.map(p => ({
                    id: p.id, pos: [p.lat, p.lng], severity: p.severity,
                    timestamp: p.timestamp, road: p.road, path: p.path, conf: p.conf,
                }));

                setPotholes(prev => {
                    const fresh = [];
                    for (const item of normed) {
                        // 1) Exact id match (backend now derives a stable id
                        //    from road + path position + heading, so the same
                        //    real pothole detected on a rescan reuses the same
                        //    id) — cheapest and most reliable check.
                        if (seenPotholeIdsRef.current.has(item.id)) continue;

                        // 2) Distance fallback, in case two nearby detections
                        //    land on different path indices but are clearly
                        //    the same physical pothole.
                        const isDuplicate = prev.some(existing =>
                            getDistanceMeters(existing.pos[0], existing.pos[1], item.pos[0], item.pos[1]) < 5.0
                        ) || fresh.some(addedThisBatch =>
                            getDistanceMeters(addedThisBatch.pos[0], addedThisBatch.pos[1], item.pos[0], item.pos[1]) < 5.0
                        );
                        if (isDuplicate) continue;

                        seenPotholeIdsRef.current.add(item.id);
                        fresh.push(item);
                    }
                    survivorCount = fresh.length;
                    return fresh.length ? [...prev, ...fresh] : prev;
                });
            }

            // Road only turns red if at least one detection on it actually
            // survived dedup and got a marker placed. Otherwise (no raw
            // detections, or all were duplicates of existing markers) it's
            // treated as clean/teal — never red without a corresponding pin.
            setRoadStates(prev => ({
                ...prev,
                [d.road_id]: {
                    path:  d.path,
                    state: survivorCount > 0 ? 'scanned_pothole' : 'scanned_clean',
                    name:  d.road_name,
                },
            }));
        });

        es.addEventListener('road_skipped', (e) => {
            const d = JSON.parse(e.data);
            setRoadStates(prev => ({
                ...prev,
                [d.road_id]: { path: d.path, state: 'no_coverage', name: d.road_name },
            }));
        });

        es.addEventListener('done', (e) => {
            const d = JSON.parse(e.data);
            setScanMode(d.roads_scanned === 0 ? 'No coverage' : 'STREET SCAN');
            if (d.roads_scanned === 0) setNoCoverage(true);
            setProgress({ done: d.roads_total, total: d.roads_total, scanning: `Done — ${d.potholes_total} pothole(s) found` });
            isScanActiveRef.current = false;
            es.close();
        });

        es.onerror = () => {
            setScanMode('Offline');
            setProgress(p => ({ ...p, scanning: 'Backend unreachable' }));
            isScanActiveRef.current = false;
            es.close();
        };
    };

    /* ── Derived ── */
    const highCount   = potholes.filter(p => p.severity === 'High').length;
    const medCount    = potholes.filter(p => p.severity === 'Medium').length;
    const lowCount    = potholes.filter(p => p.severity === 'Low').length;
    const riskPercent = Math.min(100, Math.round((potholes.length / 12) * 100));
    const riskLabel   = highCount > 0 ? 'Critical' : potholes.length > 0 ? 'Caution' : 'Clear';
    const riskColor   = highCount > 0 ? SEV.High.color : potholes.length > 0 ? SEV.Medium.color : SEV.Low.color;

    const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

    const pillClass =
        isScanning                ? 'pill-active' :
        scanMode === 'Scanning…'  ? 'pill-scan'   :
        scanMode === 'Offline'    ? 'pill-err'     : 'pill-idle';

    const roadGroups = potholes.reduce((acc, p) => {
        const key = p.road || 'Unknown';
        if (!acc[key]) acc[key] = { name: key, potholes: [] };
        acc[key].potholes.push(p);
        return acc;
    }, {});
    const roadList = Object.values(roadGroups).sort((a, b) => {
        const w = r => r.potholes.some(p => p.severity === 'High') ? 0 : r.potholes.some(p => p.severity === 'Medium') ? 1 : 2;
        return w(a) - w(b);
    });
    const worstSev = g => {
        if (g.potholes.some(p => p.severity === 'High'))   return 'High';
        if (g.potholes.some(p => p.severity === 'Medium')) return 'Medium';
        return 'Low';
    };

    const clearAll = () => {
        evtRef.current?.close();
        isScanActiveRef.current = false;
        scanOriginRef.current = null;
        seenPotholeIdsRef.current = new Set();
        pendingImageRef.current = null;
        setPotholes([]); setRoadStates({}); setScanMode('Idle');
        setRealImage(null); setNoCoverage(false);
        setProgress({ done: 0, total: 0, scanning: '' });
        setIsScanning(false);
        setIsTrackingLive(false);
    };

    return (
        <>
            <style>{buildCSS(t)}</style>
            <div className="app">

                {/* ── Sidebar ── */}
                <aside className={`sidebar ${isFullscreen ? 'sidebar-hidden' : ''}`}>
                    <div className="s-header">
                        <div className="s-brand">
                            <div className="s-logo"><ShieldAlert size={16} /></div>
                            <div>
                                <div className="s-title">AI Based Pothole Detection</div>
                                <div className="s-sub">WorldWide </div>
                            </div>
                        </div>
                        <button className="theme-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
                            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                        </button>
                    </div>

                    <div className="s-actions">
                        <button
                            onClick={() => {
                                const nextState = !isScanning;
                                setIsScanning(nextState);
                                if (nextState) {
                                    // Don't force isTrackingLive on here. It
                                    // used to always flip to true, which
                                    // turned on the GPS watcher regardless of
                                    // whether you'd just picked a preset or
                                    // searched location — the first GPS fix
                                    // would then immediately snap `location`
                                    // back to your real device position. Now
                                    // we only zoom in; live GPS tracking stays
                                    // off unless you explicitly press the GPS
                                    // locate button, so a manually chosen spot
                                    // sticks until you ask to go back to
                                    // your current location.
                                    setZoom(16);
                                }
                            }}
                            className={`btn-primary ${isScanning ? 'btn-stop' : 'btn-start'}`}
                        >
                            <Activity size={15} />
                            {isScanning ? 'Stop monitoring' : 'Start monitoring'}
                        </button>
                    </div>

                    <div className="s-status">
                        <span className={`status-pill ${pillClass}`}>
                            <span className={`pill-dot ${isScanning ? 'pulse' : ''}`} />
                            {isScanning ? 'Monitoring' : scanMode}
                        </span>
                    </div>

                    {progress.total > 0 && (
                        <div className="scan-progress-wrap">
                            <div className="scan-progress-label">
                                <span style={{ color: THEMES[theme].textSub }}>{progress.scanning}</span>
                                <span style={{ fontFamily: 'JetBrains Mono', color: THEMES[theme].accent }}>
                                    {progress.done}/{progress.total}
                                </span>
                            </div>
                            <div className="scan-progress-bar" style={{ width: `${progressPct}%` }} />
                        </div>
                    )}

                    {noCoverage && (
                        <div className="no-cov">
                            <AlertTriangle size={13} style={{ color: '#e53e3e', flexShrink: 0, marginTop: 1 }} />
                            <p>No Street View coverage here.</p>
                        </div>
                    )}

                    <div className="s-label">Street view feed</div>
                    <div className="feed-card">
                        <div className="feed-img-wrap">
                            {realImage ? (
                                <>
                                    <img key={realImage} src={realImage} alt="Street View" className="feed-img" />
                                    {isScanning && <div className="feed-scan-line" />}
                                </>
                            ) : (
                                <div className="feed-img-placeholder">
                                    <Camera size={22} style={{ opacity: 0.3 }} />
                                    <span>{noCoverage ? 'No Street View coverage' : 'Scan to load street view'}</span>
                                </div>
                            )}
                        </div>
                        <div className="feed-bar">
                            <span className="feed-cam">CAM_01</span>
                            <span className="feed-coords">{location[0].toFixed(4)}, {location[1].toFixed(4)}</span>
                        </div>
                    </div>

                    <div className="divider" />

                    <div className="s-label">Detection summary</div>
                    <div className="stats-grid">
                        <div className="stat-card">
                            <div className="stat-label">Total</div>
                            <div className="stat-val" style={{ color: potholes.length > 0 ? SEV.Medium.color : SEV.Low.color }}>{potholes.length}</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Critical</div>
                            <div className="stat-val" style={{ color: highCount > 0 ? SEV.High.color : THEMES[theme].textMuted }}>{highCount}</div>
                        </div>
                    </div>

                    <div className="sev-grid">
                        {[{ key: 'High', count: highCount }, { key: 'Medium', count: medCount }, { key: 'Low', count: lowCount }].map(({ key, count }) => (
                            <div key={key} className="sev-row" style={{ background: SEV[key].bg, border: `1px solid ${SEV[key].border}` }}>
                                <span className="sev-dot" style={{ background: SEV[key].color }} />
                                <span className="sev-name" style={{ color: SEV[key].color }}>{SEV[key].label}</span>
                                <span className="sev-count" style={{ color: SEV[key].color }}>{count}</span>
                            </div>
                        ))}
                    </div>

                    {roadList.length > 0 && (
                        <>
                            <div className="divider" />
                            <div className="s-label">Affected roads</div>
                            <div className="road-list">
                                {roadList.map(r => {
                                    const ws = worstSev(r);
                                    return (
                                        <div key={r.name} className="road-item">
                                            <div className="road-item-name">{r.name}</div>
                                            <div className="road-item-meta">
                                                <span className="road-badge" style={{ background: SEV[ws].bg, color: SEV[ws].color }}>
                                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: SEV[ws].color, display: 'inline-block' }} />
                                                    {SEV[ws].label}
                                                </span>
                                                <span>{r.potholes.length} found</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </aside>

                {/* ── Map ── */}
                <main className="map-area">
                    <div className="map-search">
                        <div className="search-wrap">
                            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6 }}>
                                <input
                                    type="text" placeholder="Search location…"
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                                    className="search-input"
                                />
                                <button type="submit" disabled={isSearching} className="search-go">
                                    {isSearching ? <span style={{ fontSize: 12, color: '#fff' }}>…</span>
                                        : <Navigation size={14} style={{ transform: 'rotate(45deg)' }} />}
                                </button>
                            </form>
                            {showSuggestions && (
                                <div className="suggestions">
                                    {suggestions.map((item, i) => (
                                        <div key={i} className="suggestion-item" onMouseDown={() => {
                                            const loc = [parseFloat(item.lat), parseFloat(item.lon)];
                                            setIsTrackingLive(false);
                                            setZoom(16);
                                            setSearchQuery(item.display_name);
                                            setLocation(loc);
                                            triggerScan(loc[0], loc[1]);
                                            setShowSuggestions(false);
                                        }}>{item.display_name}</div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="legend">
                        <div className="legend-title">Severity</div>
                        {Object.entries(SEV).map(([k, s]) => (
                            <div key={k} className="legend-row">
                                <div className="legend-dot" style={{ background: s.color }} />
                                <span className="legend-text">{s.label}</span>
                            </div>
                        ))}
                        <div style={{ height: 1, background: THEMES[theme].border, margin: '8px 0' }} />
                        <div className="legend-title" style={{ marginTop: 2 }}>Road status</div>
                        {[
                            { color: ROAD_COLORS.scanning,        label: 'Scanning now' },
                            { color: ROAD_COLORS.scanned_pothole, label: 'Potholes found' },
                            { color: ROAD_COLORS.idle,            label: 'Clear' },
                            { color: ROAD_COLORS.no_coverage,     label: 'No coverage' },
                        ].map(({ color, label }) => (
                            <div key={label} className="legend-row">
                                <div className="legend-line" style={{ background: color }} />
                                <span className="legend-text">{label}</span>
                            </div>
                        ))}
                    </div>

                    <MapContainer center={location} zoom={zoom} zoomControl={false} style={{ width: '100%', height: '100%' }}>
                        <TileLayer url={THEMES[theme].tileUrl} />
                        <FullscreenMapSync isFullscreen={isFullscreen} center={location} radiusMeters={SCAN_RADIUS_M} />
                        <MapRecenter center={location} zoom={zoom} suspend={isViewTransitioning || isFullscreen} />

                        <Circle
                            center={location} radius={SCAN_RADIUS_M}
                            pathOptions={{ color: THEMES[theme].accent, fillColor: THEMES[theme].accent, fillOpacity: 0.03, weight: 1.5, dashArray: '4 6' }}
                        />

                        {Object.entries(roadStates).map(([id, rs]) => {
                            if (!rs.path) return null;
                            const color = ROAD_COLORS[rs.state] || ROAD_COLORS.idle;
                            return (
                                <Polyline
                                    key={`road-${id}`}
                                    positions={rs.path}
                                    pathOptions={{
                                        color,
                                        weight:    rs.state === 'scanning' ? 6 : rs.state === 'scanned_pothole' ? 5 : 3,
                                        opacity:   rs.state === 'no_coverage' ? 0.35 : 0.85,
                                        dashArray: rs.state === 'no_coverage' ? '6 6' : undefined,
                                    }}
                                >
                                    <Popup>
                                        <div style={{ fontFamily: 'Inter', fontSize: 12, padding: 2 }}>
                                            <strong>{rs.name}</strong>
                                            <div style={{ color: '#888', marginTop: 4, fontSize: 11 }}>
                                                {rs.state === 'scanning'        ? '🔍 Scanning now…'     :
                                                 rs.state === 'scanned_pothole'  ? '⚠️ Potholes detected' :
                                                 rs.state === 'scanned_clean'    ? '✅ No potholes'        :
                                                 rs.state === 'no_coverage'      ? '📷 No Street View'    :
                                                                                   '⏳ Not yet scanned'}
                                            </div>
                                        </div>
                                    </Popup>
                                </Polyline>
                            );
                        })}

                        <Marker position={location} icon={ICONS.User}>
                            <Popup><strong>Scan Target Position</strong></Popup>
                        </Marker>

                        {potholes.map(p => (
                            <Marker key={p.id} position={p.pos} icon={ICONS[p.severity] || ICONS.Low}>
                                <Popup>
                                    <div style={{ fontFamily: 'Inter', minWidth: 160, padding: 2 }}>
                                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV[p.severity]?.color, display: 'inline-block' }} />
                                            {SEV[p.severity]?.label} severity
                                        </div>
                                        <table style={{ fontSize: 11, width: '100%', borderCollapse: 'collapse' }}>
                                            <tbody>
                                                {[
                                                    ['Road',       p.road || 'Unknown'],
                                                    ['Confidence', p.conf ? `${Math.round(p.conf * 100)}%` : 'N/A'],
                                                    ['Location',   `${p.pos[0].toFixed(5)}, ${p.pos[1].toFixed(5)}`],
                                                ].map(([k, v]) => (
                                                    <tr key={k}>
                                                        <td style={{ color: '#888', paddingRight: 10, paddingBottom: 3, whiteSpace: 'nowrap' }}>{k}</td>
                                                        <td style={{ fontWeight: 500, paddingBottom: 3 }}>{v}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </Popup>
                            </Marker>
                        ))}
                    </MapContainer>

                    {/* Location controls */}
                    <div className="loc-controls">
                        <button
                            className={`map-btn ${isFullscreen ? 'fullscreen-btn-active' : ''}`}
                            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen map'}
                            onClick={() => setIsFullscreen(f => !f)}
                        >
                            {isFullscreen ? <Minimize size={17} /> : <Maximize size={17} style={{ color: THEMES[theme].text }} />}
                        </button>
                        <button className="map-btn" title="GPS location" onClick={handleLocate}>
                            <LocateFixed size={17} style={{ color: THEMES[theme].accent }} />
                        </button>
                        <button className="map-btn" title="DHA Phase 2" onClick={() => {
                            const loc = [24.8334636, 67.0695634];
                            setIsTrackingLive(false);
                            setZoom(16);
                            setLocation(loc);
                            triggerScan(loc[0], loc[1]);
                        }}>
                            <MapPin size={17} style={{ color: SEV.Low.color }} />
                        </button>
                        <button className="map-btn" title="London" onClick={() => {
                            const loc = [51.5074, -0.1278];
                            setIsTrackingLive(false);
                            setZoom(16);
                            setLocation(loc);
                            triggerScan(loc[0], loc[1]);
                        }}>
                            <MapPin size={17} style={{ color: SEV.Medium.color }} />
                        </button>
                    </div>

                    {/* Clear */}
                    <button className="clear-btn" onClick={clearAll}>
                        <X size={13} /> Clear results
                    </button>

                    {/* Risk bar
                    {potholes.length > 0 && (
                        <div className="risk-bar">
                            <div>
                                <div style={{ fontSize: 10, color: THEMES[theme].textSub, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Route risk</div>
                                <div style={{ fontSize: 16, fontWeight: 600, color: riskColor, lineHeight: 1 }}>{riskLabel}</div>
                            </div>
                            <div className="risk-track">
                                <div className="risk-fill" style={{ width: `${riskPercent}%`, background: riskColor }} />
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'JetBrains Mono', color: riskColor }}>{riskPercent}%</div>
                        </div>
                    )} */}
                </main>
            </div>
        </>
    );
}
