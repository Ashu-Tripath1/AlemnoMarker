# AlemnoMarker

A React Native Android application that detects, extracts, and displays 20 custom visual markers captured via the device camera — built without any ML dependencies using a fast, deterministic native Kotlin detection pipeline.

---

## 📱 Demo

> Download the latest APK from the [Releases](../../releases) section and install it directly on any Android device.

---

## 📋 Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Custom Marker Design](#custom-marker-design)
- [Detection Algorithm](#detection-algorithm)
- [Orientation Correction](#orientation-correction)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Approach Document](#approach-document)

---

## Overview

AlemnoMarker uses a fully custom detection pipeline — no ML, no third-party vision libraries. The app:

- Opens the rear camera at full resolution (2560×1920 / 5MP)
- Scans every 500ms using a non-blocking `setInterval` loop
- Detects a custom hollow-square marker using native Kotlin (flood fill + corner validation)
- Corrects orientation automatically based on a corner indicator square
- Displays the detected marker cropped, oriented, and resized to exactly 300×300px

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | React Native 0.75 | Required by problem statement |
| Architecture | New Architecture (TurboModules) | Required for react-native-vision-camera v4 |
| Camera | react-native-vision-camera v4 | Most capable RN camera library; supports `takePhoto()` with full resolution |
| JS Engine | Hermes | Faster startup, lower memory, required for New Arch |
| File I/O | react-native-fs | Read captured photo bytes for base64 encoding |
| Detection | Custom native Kotlin module | Pure Java/Kotlin, no ML dependencies, deterministic and fast |

---

## Custom Marker Design

The marker used is **Marker 1** from the Alemno provided set.

### Specifications

- **Overall size:** 140×140 pixels (physical print dimensions)
- **Border:** Thick black outer frame (~20px on each side = 14.3% of total width)
- **Interior:** White/empty (>60% of total area)
- **Orientation indicator:** A solid 20×20 black square placed in the **top-left inner corner**
- **Color:** Black and white only

### Why This Design Works

1. **High contrast** — black border on white background is trivially thresholded
2. **Unique shape** — a hollow square frame with a single filled corner square is very unlikely to appear naturally in any environment
3. **Orientation-unambiguous** — the corner square's position uniquely identifies rotation (0°, 90°, 180°, 270°)

### Test Images

Test images of the marker in different orientations are available in the [`/test-images`](./test-images) folder.

---

## Detection Algorithm

The entire detection pipeline runs inside a native Kotlin module (`MarkerDetectorModule.kt`) to avoid JavaScript bridge overhead.

### Pipeline

```
Input Photo → Downscale to 650px max → Grayscale binary threshold
           → Flood Fill (Connected Component Analysis)
           → Outer Border Candidate Selection
           → Corner Square Validation
           → Multi-Rotation Detection
           → Crop → Orient → Resize → Encode (Base64)
```

### Key Steps

**Pre-processing**
- Downscales from ~2560×1920 to 650px max — makes flood fill ~20× faster with no accuracy loss
- Batch pixel read via `bitmap.getPixels()` instead of per-pixel `getPixel(x,y)` (~3–5× faster)
- Binary threshold: Gray < 128 = black (1), else white (0)

**Connected Component Analysis**
- 4-connected flood fill finds all black pixel regions
- Computes axis-aligned bounding boxes and pixel counts
- Components with fewer than 50 pixels are discarded

**Outer Border Candidate Selection**

| Criterion | Value | Rationale |
|---|---|---|
| Minimum size | 80×80 px | Marker must be reasonably large in frame |
| Aspect ratio | 0.75 – 1.25 | Bounding box must be nearly square |
| Fill ratio | 0.12 – 0.60 | Must be hollow (frame only), not solid |

**Corner Square Validation**
- Searches for the orientation indicator in each of the 4 corner zones (40% of marker size from each corner)
- Valid corner square must: match expected size (~14.3% of marker), be mostly filled (fill ratio ≥ 0.60), have its center within the corner zone, and not be part of the outer border

**Multi-Rotation Detection**
- Tries 8 rotation angles: 0°, 180°, 90°, 270°, 45°, 135°, 225°, 315°
- Returns on the first match
- Straight and upside-down markers are tried first (most common in practice) — typically resolves in 1–2 attempts

---

## Orientation Correction

The corner square acts as a compass. Based on its detected position, a `Matrix.postRotate()` correction is applied:

| Corner Square Position | Rotation Applied |
|---|---|
| Top-left (canonical) | 0° (no rotation) |
| Top-right | 270° clockwise |
| Bottom-left | 90° clockwise |
| Bottom-right | 180° |

Combined with multi-rotation pre-processing, the system correctly handles **any physical orientation** of the marker in the camera frame.

---

## Project Structure

```
AlemnoMarker/
├── android/
│   └── app/src/main/java/.../MarkerDetectorModule.kt   # Native detection pipeline
├── src/
│   ├── App.tsx                                          # Root component
│   ├── screens/
│   │   └── CameraScreen.tsx                            # Camera + scanning loop
│   └── components/
│       └── MarkerResult.tsx                            # Detected marker display
├── test-images/                                        # Marker test images (4 orientations)
├── approach.pdf                                        # Full technical approach document
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- React Native CLI (not Expo)
- Android Studio with Android SDK
- A physical Android device (camera required) or Android emulator with camera support

### Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/AlemnoMarker.git
cd AlemnoMarker

# Install dependencies
npm install

# Install Android dependencies
cd android && ./gradlew clean && cd ..

# Run on connected Android device
npx react-native run-android
```

### Building the APK

```bash
cd android
./gradlew assembleRelease
```

The APK will be at `android/app/build/outputs/apk/release/app-release.apk`

> **Or just download the pre-built APK** from the [Releases](../../releases) page.

---

## Approach Document

The full technical approach — including design decisions, algorithm details, performance optimisations, and camera configuration — is available as [`approach.pdf`](./approach.pdf) in this repository.

---

## Camera Configuration

- **Library:** react-native-vision-camera v4
- **Resolution:** `useCameraFormat` targets 2560×1920 (≥2000px minimum); falls back to device default
- **Photo capture:** `takePhoto({ flash: 'off' })` — synchronous high-res JPEG
- **Capture interval:** 500ms between attempts
- **Zoom:** User-controllable via pinch gesture

---

## Performance

| Metric | Value |
|---|---|
| Downscaled resolution | 650px max |
| Flood fill speedup | ~20× vs full resolution |
| Pixel read speedup | ~3–5× (batch vs per-pixel) |
| Rotation attempts (typical) | 1–2 |
| Capture interval | 500ms |
| Output size | 300×300px JPEG at quality 92 |
