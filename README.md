# AI-Based Pothole Detection System (FYP)

This project is an automated road condition monitoring system that uses AI to detect potholes from street-level imagery and visualizes them on an interactive map.

## 🚀 Key Features
- **Live Location Tracking**: Uses browser GPS to track your movement.
- **AI Scanning**: Utilizes a dual-model approach with R-CNN employed during the training phase, while a highly optimized YOLOv8 (You Only Look Once) model is deployed for real-time detection of potholes in images.
- **Dynamic Risk Assessment**: Calculates route safety based on pothole density.
- **Premium Dashboard**: Futuristic UI with real-time telemetry and 3D maps.

## 🛠️ Tech Stack
- **Frontend**: React, Vite, Leaflet.js, Framer Motion, Tailwind CSS.
- **Backend**: Python, FastAPI, R-CNN, YOLOv8 (Ultralytics), OpenCV.

## 🏗️ Project Structure
```text
ai-pothole-detection/
├── backend/
│   ├── main.py            # FastAPI server with AI logic
│   └── requirements.txt    # Python dependencies
└── frontend/
    ├── src/
    │   ├── App.jsx        # Main Dashboard UI
    │   └── index.css      # Custom styles and glassmorphism
    └── package.json
```

## 🚥 How to Run

### 1. Backend Setup
Make sure you have Python installed.
```bash
cd backend
pip install -r requirements.txt
python main.py
```

### 2. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

## 📖 Scanning Logic
In this demonstration, clicking **"Start Monitoring"** triggers the backend to find road coordinates around your GPS position. The system incorporates knowledge derived from initial R-CNN training, while leveraging an optimized YOLOv8 model to process real-time images for potholes. For the prototype, we simulate the detection markers to showcase how the mapping integration works seamlessly with the AI predictions.
