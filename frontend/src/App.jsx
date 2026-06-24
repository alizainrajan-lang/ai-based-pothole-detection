import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Circle, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
    Activity,
    ShieldAlert,
    Navigation,
    Info,
    Zap,
    LocateFixed
} from 'lucide-react';
import { motion } from 'framer-motion';
import L from 'leaflet';

// Fix Leaflet marker icons
delete L.Icon.Default.prototype._getIconUrl;

const createMarkerIcon = (color) => new L.Icon({
    iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
});

const icons = {
    High: createMarkerIcon('red'),
    Medium: createMarkerIcon('orange'),
    Low: createMarkerIcon('yellow'),
    User: createMarkerIcon('blue'),
};

function MapRecenter({ center, zoom }) {
    const map = useMap();
    useEffect(() => {
        if (center) map.setView(center, zoom, { animate: true });
    }, [center, zoom]);
    return null;
}

const App = () => {
    const [location, setLocation] = useState([24.8607, 67.0011]); // Default Karachi
    const [isScanning, setIsScanning] = useState(false);
    const [zoom, setZoom] = useState(15);
    const [potholes, setPotholes] = useState([
        { id: 1, pos: [24.8615, 67.0020], severity: 'High', timestamp: '18:22:01' },
        { id: 2, pos: [24.8590, 66.9990], severity: 'Medium', timestamp: '18:25:30' },
    ]);
    const [realImage, setRealImage] = useState(null);
    const [scanMode, setScanMode] = useState('Simulation');
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [suggestions, setSuggestions] = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);

    useEffect(() => {
        if (isScanning) {
            setZoom(18); // Focus on monitoring area
        } else {
            setZoom(15); // Standard view
        }
    }, [isScanning]);

    useEffect(() => {
        const delayDebounceFn = setTimeout(() => {
            if (searchQuery.length > 2) {
                fetchSuggestions();
            } else {
                setSuggestions([]);
                setShowSuggestions(false);
            }
        }, 500);

        return () => clearTimeout(delayDebounceFn);
    }, [searchQuery]);

    const fetchSuggestions = async () => {
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5`);
            const data = await response.json();
            setSuggestions(data);
            setShowSuggestions(data.length > 0);
        } catch (err) {
            console.error("Suggestions fetch failed");
        }
    };

    const handleLocate = () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const newLoc = [pos.coords.latitude, pos.coords.longitude];
                    handlePositionChange(newLoc);
                },
                () => alert("Location access denied or unavailable.")
            );
        }
    };

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        try {
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`);
            const data = await response.json();
            if (data && data.length > 0) {
                const newLoc = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
                handlePositionChange(newLoc);
            } else {
                alert("Location not found.");
            }
        } catch (err) {
            alert("Search failed. Check your internet connection.");
        }
        setIsSearching(false);
    };

    const handlePositionChange = (newLoc) => {
        setLocation(newLoc);
        if (isScanning) triggerScan(newLoc[0], newLoc[1]);
    };

    const triggerScan = async (lat, lng) => {
        try {
            const response = await fetch('http://localhost:8000/scan-nearby', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lat, lng }),
            });
            const data = await response.json();
            if (data.potholes) {
                setPotholes(data.potholes.map(p => ({
                    id: p.id,
                    pos: [p.lat, p.lng],
                    severity: p.severity,
                    timestamp: p.timestamp,
                    path: p.path // Store the real road geometry
                })));
            }
            if (data.real_image) setRealImage(data.real_image);
            if (data.mode) setScanMode(data.mode);
        } catch (err) {
            console.log("Backend simulation active");
        }
    };

    useEffect(() => {
        let watchId = null;
        if (isScanning && navigator.geolocation) {
            watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const newLoc = [pos.coords.latitude, pos.coords.longitude];
                    handlePositionChange(newLoc);
                },
                (err) => console.error("Tracking error:", err),
                { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
            );
        }
        return () => {
            if (watchId) navigator.geolocation.clearWatch(watchId);
        };
    }, [isScanning]);

    return (
        <div className="app-container">

            {/* Sidebar */}
            <aside className="sidebar">
                <div className="sidebar-header">
                    <h1 className="font-display neon-text" style={{ fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <ShieldAlert size={28} />
                        AI Pothole
                    </h1>
                    <p style={{ fontSize: '10px', color: '#64748b', marginTop: '5px', letterSpacing: '1px' }}>DETECTION SYSTEM v1.0</p>
                </div>

                <div className="scan-feed">
                    <p style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '15px', fontWeight: 'bold' }}>LIVE SCAN FEED</p>

                    {[1, 2, 3].map((i) => (
                        <div key={i} className="scan-item">
                            <div className="scan-image-container">
                                <img
                                    src={realImage || `https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&q=80&w=400`}
                                    alt="Road View"
                                    className="scan-image"
                                />
                                <div className="scan-overlay">
                                    {isScanning && <div className="scanner-line"></div>}
                                </div>
                                <div style={{ position: 'absolute', top: '5px', left: '5px', fontSize: '10px', background: 'rgba(0,0,0,0.5)', padding: '2px 6px', borderRadius: '4px' }}>
                                    CAM_0{i}
                                </div>
                            </div>
                            <div style={{ padding: '8px', fontSize: '10px', color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
                                <span>LOC: {location[0].toFixed(2)}, {location[1].toFixed(2)}</span>
                                <span style={{ color: scanMode === 'Simulation Mode' ? '#ff3c3c' : '#00f2ff' }}>{scanMode}</span>
                            </div>
                        </div>
                    ))}
                </div>

                <div style={{ padding: '20px', background: 'rgba(0,0,0,0.4)', borderTop: '1px solid var(--glass-border)' }}>
                    <button
                        onClick={() => setIsScanning(!isScanning)}
                        className={`scan-btn ${isScanning ? 'scan-btn-active' : 'scan-btn-idle'}`}
                    >
                        {isScanning ? <Zap size={18} fill="currentColor" /> : <Activity size={18} />}
                        {isScanning ? 'STOP MONITORING' : 'START MONITORING'}
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="main-view">
                <div className="top-telemetry" style={{ display: 'flex', alignItems: 'center', gap: '20px', padding: '10px 20px', borderRadius: '12px' }}>
                    <div className="search-container">
                        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px' }}>
                            <input
                                type="text"
                                placeholder="Search Location (e.g. Karachi)..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                                style={{
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid var(--glass-border)',
                                    color: 'white',
                                    padding: '8px 15px',
                                    borderRadius: '8px',
                                    outline: 'none',
                                    fontSize: '12px',
                                    width: '200px'
                                }}
                            />
                            <button
                                type="submit"
                                style={{
                                    background: 'var(--accent-blue)',
                                    border: 'none',
                                    color: 'white',
                                    padding: '8px 15px',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    fontWeight: 'bold'
                                }}
                                disabled={isSearching}
                            >
                                {isSearching ? '...' : <Navigation size={14} style={{ transform: 'rotate(45deg)' }} />}
                            </button>
                        </form>

                        {showSuggestions && (
                            <div className="search-suggestions">
                                {suggestions.map((item, idx) => (
                                    <div
                                        key={idx}
                                        className="suggestion-item"
                                        onClick={() => {
                                            const newLoc = [parseFloat(item.lat), parseFloat(item.lon)];
                                            setSearchQuery(item.display_name);
                                            handlePositionChange(newLoc);
                                            setShowSuggestions(false);
                                        }}
                                    >
                                        {item.display_name}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div style={{ width: '1px', height: '30px', background: 'rgba(255,255,255,0.1)' }}></div>
                    <div style={{ textAlign: 'center' }}>
                        <p style={{ fontSize: '10px', color: '#94a3b8' }}>SCANNED AREA</p>
                        <p className="neon-text" style={{ fontWeight: 'bold', fontSize: '12px' }}>150.4 km²</p>
                    </div>
                    <div style={{ width: '1px', height: '30px', background: 'rgba(255,255,255,0.1)' }}></div>
                    <div style={{ textAlign: 'center' }}>
                        <p style={{ fontSize: '10px', color: '#94a3b8' }}>ACTIVE SCANNERS</p>
                        <p style={{ fontWeight: 'bold', color: '#ff9d00', fontSize: '12px' }}>12 UNITS</p>
                    </div>
                </div>

                <div className="map-wrapper">
                    <MapContainer
                        center={location}
                        zoom={zoom}
                        zoomControl={false}
                        style={{ width: '100%', height: '100%' }}
                    >
                        <TileLayer
                            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                        />
                        <MapRecenter center={location} zoom={zoom} />

                        <Circle
                            center={location}
                            radius={400}
                            pathOptions={{ color: '#00f2ff', fillColor: '#00f2ff', fillOpacity: 0.1 }}
                        />

                        <Marker position={location} icon={icons.User}>
                            <Popup>Operator Location</Popup>
                        </Marker>

                        {potholes.map(p => (
                            <Polyline
                                key={p.id}
                                positions={p.path || [[p.pos[0], p.pos[1] - 0.0003], [p.pos[0], p.pos[1] + 0.0003]]}
                                pathOptions={{
                                    color: p.severity === 'High' ? '#ff3c3c' : p.severity === 'Medium' ? '#ff9d00' : '#eab308',
                                    weight: 8,
                                    lineCap: 'round',
                                    opacity: 0.9,
                                    dashArray: '1, 10' // Neon track style
                                }}
                            >
                                <Popup>
                                    <div style={{ color: 'black' }}>
                                        <p style={{ fontWeight: 'bold' }}>Pothole Detected</p>
                                        <p style={{ color: p.severity === 'High' ? '#ff3c3c' : p.severity === 'Medium' ? '#ff9d00' : '#eab308' }}>
                                            Severity: {p.severity}
                                        </p>
                                        <p style={{ fontSize: '10px' }}>Loc: {p.road || 'Active Road'}</p>
                                        <p style={{ fontSize: '10px' }}>TS: {p.timestamp}</p>
                                    </div>
                                </Popup>
                            </Polyline>
                        ))}
                    </MapContainer>
                </div>

                {/* Legend Overlay */}
                <div style={{ position: 'absolute', top: '80px', right: '20px', zIndex: 10, background: 'rgba(15, 23, 42, 0.9)', padding: '15px', borderRadius: '12px', border: '1px solid var(--glass-border)', backdropFilter: 'blur(10px)', width: '160px' }}>
                    <p style={{ fontWeight: 'bold', marginBottom: '12px', color: '#94a3b8', fontSize: '11px', letterSpacing: '1px' }}>HAZARD LEGEND</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ff3c3c', boxShadow: '0 0 10px #ff3c3c' }}></div>
                            <span style={{ color: '#ff3c3c', fontWeight: 'bold', fontSize: '10px' }}>CRITICAL (HIGH)</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ff9d00', boxShadow: '0 0 10px #ff9d00' }}></div>
                            <span style={{ color: '#ff9d00', fontWeight: 'bold', fontSize: '10px' }}>WARNING (MED)</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#eab308', boxShadow: '0 0 10px #eab308' }}></div>
                            <span style={{ color: '#eab308', fontWeight: 'bold', fontSize: '10px' }}>CAUTION (LOW)</span>
                        </div>
                    </div>
                </div>

                <div className="bottom-info">
                    <div style={{ display: 'flex', gap: '20px' }}>
                        <div className="risk-card">
                            <h3 style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                                ROUTE RISK <Info size={12} />
                            </h3>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                                <span className="font-display" style={{ color: potholes.length > 5 ? '#ff3c3c' : '#ff9d00', fontSize: '1.2rem' }}>
                                    {potholes.length > 5 ? 'CRITICAL' : 'CAUTION'}
                                </span>
                                <span style={{ fontSize: '10px', color: '#64748b' }}>{Math.min(100, Math.round((potholes.length / 10) * 100))}%</span>
                            </div>
                            <div style={{ height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', marginTop: '10px', overflow: 'hidden' }}>
                                <div style={{ height: '100%', background: 'linear-gradient(90deg, #00f2ff, #ff9d00)', width: `${Math.min(100, Math.round((potholes.length / 10) * 100))}%` }}></div>
                            </div>
                        </div>

                        <div className="risk-card" style={{ width: '250px' }}>
                            <h3 style={{ fontSize: '10px', color: '#94a3b8', marginBottom: '8px' }}>DETECTION SUMMARY</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '10px' }}>
                                <div>
                                    <p style={{ color: '#64748b' }}>Potholes Found</p>
                                    <p style={{ fontSize: '14px', fontWeight: 'bold' }}>{potholes.length}</p>
                                </div>
                                <div>
                                    <p style={{ color: '#64748b' }}>Avg. Severity</p>
                                    <p style={{ fontSize: '14px', fontWeight: 'bold', color: '#ff9d00' }}>MED</p>
                                </div>
                                <div style={{ gridColumn: 'span 2' }}>
                                    <p style={{ color: '#64748b' }}>Nearest Defect</p>
                                    <p style={{ fontSize: '14px', fontWeight: 'bold', color: '#00f2ff' }}>140m / 459ft</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="nav-controls">
                        <button
                            className="control-btn"
                            onClick={() => {
                                setLocation([51.5074, -0.1278]); // London
                                if (isScanning) triggerScan(51.5074, -0.1278);
                                alert("Teleporting to London (High Data Zone) to verify Live Feed...");
                            }}
                            title="Verify Live Feed"
                        >
                            <Zap size={20} color="#ff9d00" />
                        </button>
                        <button className="control-btn" onClick={handleLocate}>
                            <LocateFixed size={20} color="#00f2ff" />
                        </button>
                        <button className="control-btn">
                            <Navigation size={20} />
                        </button>
                    </div>
                </div>
            </main >

        </div >
    );
};

export default App;
