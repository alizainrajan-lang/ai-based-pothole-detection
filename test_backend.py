import requests
import json
import time

print("Testing Backend API (/scan-nearby)")
url = "http://localhost:8000/scan-nearby"
data = {"lat": 24.8607, "lng": 67.0011}
try:
    response = requests.post(url, json=data)
    print(f"Status Code: {response.status_code}")
    print("Response JSON:")
    print(json.dumps(response.json(), indent=2))
except Exception as e:
    print(f"Failed to connect to backend: {e}")

print("\n--- Testing External Nominatim API ---")
try:
    search_query = "Karachi"
    res = requests.get(f"https://nominatim.openstreetmap.org/search?format=json&q={search_query}&limit=1")
    print(f"Nominatim Status: {res.status_code}")
    if res.status_code == 200:
        print(f"Found: {res.json()[0]['display_name']}")
except Exception as e:
    print(f"Nominatim Error: {e}")

print("\n--- Testing Overpass API ---")
try:
    overpass_url = "http://overpass-api.de/api/interpreter"
    overpass_query = f"[out:json];way(around:120, 24.8607, 67.0011)[highway];out geom;"
    res = requests.get(overpass_url, params={'data': overpass_query}, timeout=5)
    print(f"Overpass Status: {res.status_code}")
    if res.status_code == 200:
        print(f"Found {len(res.json().get('elements', []))} road elements")
except Exception as e:
    print(f"Overpass Error: {e}")
