# AlemnoMarker — Technical Approach Document

## Overview

AlemnoMarker is a React Native Android application that detects, extracts, and displays 20 custom visual markers captured via the device camera. This document explains the design decisions, detection algorithm, orientation correction strategy, and performance optimisations made throughout the project.

---

## 1. Technology Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | React Native 0.75 | Required by problem statement |
| Architecture | New Architecture (TurboModules) | Required for vision-camera v4 |
| Camera | react-native-vision-camera v4 | Most capable RN camera library; supports takePhoto() with full resolution |
| JS Engine | Hermes | Faster startup, lower memory, required for New Arch |
| File I/O | react-native-fs | Read captured photo bytes for base64 encoding |
| Detection | Custom native Kotlin module | Pure Java/Kotlin, no ML dependencies, deterministic and fast |

---

## 2. Custom Marker Design

The marker used is **Marker 1** from the Alemno provided set.

### Marker Specifications
- **Overall size**: 140×140 pixels (physical print dimensions)
- **Border**: Thick black outer frame (~20px on each side = 14.3% of total width)
- **Interior**: White/empty (>60% of total area, satisfying constraint 3c)
- **Orientation indicator**: A solid 20×20 black square placed in the **top-left inner corner** of the border frame
- **Color**: Black and white only

### Why This Marker Works Well for Detection
1. **High contrast** — black border on white background is trivially thresholded
2. **Unique shape** — a hollow square frame with a single filled corner square is very unlikely to appear naturally in an environment
3. **Orientation-unambiguous** — the corner square's position uniquely identifies rotation (0°, 90°, 180°, 270°)

---

## 3. Detection Algorithm (Native Kotlin)

The entire detection pipeline runs in a native Kotlin module (`MarkerDetectorModule.kt`) to avoid JavaScript bridge overhead.

### 3.1 Pre-processing
```
Input photo → Downscale to 650px max → Grayscale binary threshold
```
- **Downscale**: Camera captures at ~2560×1920 (5MP). We downscale to 650px max before processing — this makes flood fill ~20× faster with no loss of detection accuracy, since markers are large geometric shapes
- **Batch pixel read**: `bitmap.getPixels()` reads all pixels in one JNI call instead of `getPixel(x,y)` per pixel (~3-5× faster)
- **Binary threshold**: Gray < 128 = black (1), else white (0)

### 3.2 Connected Component Analysis (Flood Fill)
A 4-connected flood fill finds all black pixel regions and computes their axis-aligned bounding boxes and pixel counts. Components with fewer than 50 pixels are discarded.

### 3.3 Outer Border Candidate Selection
For each component, we apply strict criteria to match the marker's hollow square frame:

| Criterion | Value | Rationale |
|---|---|---|
| Minimum size | 80×80 px | Marker must be reasonably large in frame |
| Aspect ratio | 0.75 – 1.25 | Border bounding box must be nearly square |
| Fill ratio | 0.12 – 0.60 | Must be hollow (frame only), not solid |

The component with the highest `size × squareness` score is chosen as the outer border candidate.

### 3.4 Corner Square Validation
The algorithm then searches for the orientation-indicator square in each of the 4 corner zones (each zone = 40% of marker size from each corner). A valid corner square must:
- Match the expected size (~14.3% of marker size) within tolerance
- Be mostly filled (fill ratio ≥ 0.60) — it's a solid square, not a frame
- Have its center within the corner search zone
- Not be part of the outer border itself

This two-stage validation (frame + corner square) is what prevents false positives. Random objects rarely have a hollow square frame **with** a correctly-sized solid square in exactly one corner.

### 3.5 Multi-Rotation Detection
A marker tilted at an arbitrary angle will have its corner square outside the expected corner zones. To handle this, the algorithm tries **8 rotation angles** (0°, 180°, 90°, 270°, 45°, 135°, 225°, 315°) and returns on the first match.

The angle order is optimised: straight and upside-down markers (most common in practice) are tried first, so they resolve in 1–2 attempts.

### 3.6 Crop, Orient, and Encode
- **Crop**: Exact bounding box of the detected outer border (zero padding)
- **Orient**: The corner square position determines which rotation is needed to bring the marker to canonical top-left orientation. A `Matrix.postRotate()` corrects it
- **Resize**: `Bitmap.createScaledBitmap(oriented, 300, 300, true)` — exactly 300×300px as required
- **Encode**: JPEG at quality 92, returned as Base64 string to JavaScript

---

## 4. Orientation Correction

The corner square acts as a compass:

| Corner square position | Rotation applied |
|---|---|
| Top-left (canonical) | 0° (no rotation) |
| Top-right | 270° clockwise |
| Bottom-left | 90° clockwise |
| Bottom-right | 180° |

Combined with the multi-rotation pre-processing, the system correctly handles **any physical orientation** of the marker in the camera frame.

---

## 5. Camera Configuration

- **Library**: react-native-vision-camera v4
- **Resolution**: `useCameraFormat` targets 2560×1920 (≥2000px minimum as required). Falls back to device default if format unavailable
- **Photo capture**: `takePhoto({flash: 'off'})` — synchronous high-res JPEG
- **Capture interval**: 500ms between attempts
- **Zoom**: User-controllable via pinch gesture

---

## 6. JavaScript Scanning Loop

Instead of a `while` loop (which blocks React re-renders), scanning uses `setInterval`:

```
startScanning() → setInterval(doCapture, 500ms)
doCapture() → takePhoto() → readFile(base64) → detectMarker() → update UI
stopScanning() → clearInterval()
```

This allows React to re-render the progress bar, status text, and button state between every capture attempt.

---

## 7. Performance Summary

| Step | Time (estimated) |
|---|---|
| Downscale to 650px | ~5ms |
| Batch pixel read + binary | ~10ms |
| Flood fill (650px image) | ~30–60ms |
| Component scoring | ~5ms |
| Corner search | ~5ms |
| Crop + rotate + resize + encode | ~15ms |
| **Total per attempt (no match)** | **~75–100ms** |
| **Total per attempt (match found)** | **~90–120ms** |

Straight markers (matched at 0° attempt): **~100ms detection latency**
Tilted markers at 45° (matched at 5th attempt after 0°, 180°, 90°, 270°): **~400–500ms**

Well within the 3000ms requirement.

---

## 8. False Positive Prevention

The detection is strict by design:

1. **Two-stage validation**: Both the outer frame AND the corner square must be present
2. **Strict fill ratios**: Frame must be hollow (0.12–0.60); corner must be solid (≥0.60)
3. **Size matching**: Corner square must be exactly ~14.3% of marker size (±65% tolerance)
4. **Aspect ratio**: Frame bounding box must be within 25% of square

In testing, the algorithm correctly ignores:
- QR codes (no matching corner square)
- Rectangular frames (aspect ratio fails)
- Solid squares (fill ratio fails)
- Animal stickers / images (no black frame component)
- Keyboard keys (too small, wrong fill ratio)

---

## 9. App Architecture

```
App.tsx (React Native)
├── SafeAreaProvider / SafeAreaView
├── useCameraPermission → permission screen if denied
├── useCameraDevice('back') → loading screen if null
├── useCameraFormat → target 2560×1920
├── Camera (vision-camera v4) → live preview
├── setInterval scanning loop
│   ├── takePhoto() → JPEG
│   ├── RNFS.readFile() → base64
│   └── MarkerDetector.detectMarker() → native Kotlin
└── Results screen → FlatList of 20 × 300×300px images

MarkerDetectorModule.kt (Native)
├── detectMarker(base64) → try 8 rotations
│   ├── scaleBitmap(650px)
│   ├── rotateBitmap(angle)
│   └── processMarker()
│       ├── getPixels() batch read
│       ├── floodFillBBox() connected components
│       ├── findOuterBorder() with fill ratio check
│       ├── findCornerSquare() in 4 zones
│       └── crop → orient → resize 300×300 → base64
└── resolve(base64) or reject("NOT_FOUND")
```

---

## 10. Build & Setup Instructions

### Prerequisites
- Node.js 18+
- JDK 17
- Android SDK (API 34)
- React Native CLI

### Run in Development
```bash
npm install
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
npx react-native start
```

### Build Standalone Release APK
```bash
cd android
./gradlew assembleRelease
# APK at: android/app/build/outputs/apk/release/app-release.apk
```

---

*Built for the Alemno Pvt Ltd Android React Native assignment.*
