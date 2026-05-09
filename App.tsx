import React, {useState, useRef, useEffect, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  ActivityIndicator,
  StatusBar,
  NativeModules,
  Alert,
  Animated,
  Linking,
  AppState,
} from 'react-native';
import {SafeAreaView, SafeAreaProvider} from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCameraFormat,
} from 'react-native-vision-camera';
import RNFS from 'react-native-fs';

// ─── Constants ────────────────────────────────────────────────────────────────
const TARGET_COUNT = 20;
const CAPTURE_INTERVAL_MS = 500; // ms between capture attempts — faster for <3000ms requirement

// ─── Native module accessor ────────────────────────────────────────────────────
function getMarkerDetector() {
  return NativeModules.MarkerDetector ?? null;
}

// ─── Types ─────────────────────────────────────────────────────────────────────
type Screen = 'camera' | 'results';

// ─── Main content ──────────────────────────────────────────────────────────────
function AppContent() {
  const [screen, setScreen] = useState<Screen>('camera');
  const [capturedMarkers, setCapturedMarkers] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [statusText, setStatusText] = useState('Tap ▶ Start Scanning to begin');
  const [foundCount, setFoundCount] = useState(0);

  const cameraRef = useRef<Camera>(null);
  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isBusyRef = useRef(false);         // prevent overlapping captures
  const foundCountRef = useRef(0);         // shadow of foundCount for interval closure
  const capturedListRef = useRef<string[]>([]);

  // Pulse animation for the scan frame
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const device = useCameraDevice('back');
  const {hasPermission, requestPermission} = useCameraPermission();

  // Requirement: live camera feed minimum 2000×2000px, maximum 3000×3000px
  // Pick the format whose photo resolution is closest to 2560×1920 (5MP, both dims ≥ 2000 on most devices)
  const format = useCameraFormat(device, [
    {photoResolution: {width: 2560, height: 1920}},
  ]);

  // ── Request permission on mount + re-check when app foregrounds ────────────
  useEffect(() => {
    // Ask immediately on first launch
    requestPermission();

    // Re-check every time the user comes back from Android Settings
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        requestPermission();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pulse animation loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (isScanning) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {toValue: 1.08, duration: 500, useNativeDriver: true}),
          Animated.timing(pulseAnim, {toValue: 1.00, duration: 500, useNativeDriver: true}),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [isScanning, pulseAnim]);

  // ── Single capture + detect ────────────────────────────────────────────────
  const doCapture = useCallback(async () => {
    if (isBusyRef.current || !cameraRef.current) return;

    isBusyRef.current = true;
    setIsCapturing(true);

    try {
      const photo = await cameraRef.current.takePhoto({flash: 'off'});

      // vision-camera v4: photo.path can be "file:///..." or "/data/..."
      // RNFS.readFile needs an absolute path without scheme
      const rawPath = photo.path;
      const absPath = rawPath.startsWith('file://')
        ? rawPath.replace('file://', '')  // "file:///data/..." → "/data/..."
        : rawPath;

      const base64 = await RNFS.readFile(absPath, 'base64');

      const detector = getMarkerDetector();
      if (!detector) {
        console.warn('MarkerDetector not available');
        isBusyRef.current = false;
        setIsCapturing(false);
        return;
      }

      let result: string | null = null;
      try {
        result = await detector.detectMarker(base64);
      } catch (_e) {
        // NOT_FOUND is normal — no marker in frame
      }

      if (result && result.length > 0) {
        foundCountRef.current += 1;
        const n = foundCountRef.current;
        const uri = `data:image/jpeg;base64,${result}`;
        capturedListRef.current = [...capturedListRef.current, uri];

        setCapturedMarkers([...capturedListRef.current]);
        setFoundCount(n);
        setStatusText(`✓ ${n}/${TARGET_COUNT} markers captured`);

        // Auto-finish when target reached
        if (n >= TARGET_COUNT) {
          stopScanning();
          setScreen('results');
        }
      } else {
        setStatusText(`Scanning… ${foundCountRef.current}/${TARGET_COUNT} found`);
      }

      // Clean up temp photo
      try { await RNFS.unlink(absPath); } catch (_) {}

    } catch (err: any) {
      console.log('Capture error:', err?.message ?? err);
      setStatusText(`Scanning… ${foundCountRef.current}/${TARGET_COUNT} found`);
    } finally {
      isBusyRef.current = false;
      setIsCapturing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start / stop scanning ──────────────────────────────────────────────────
  const startScanning = useCallback(() => {
    const detector = getMarkerDetector();
    if (!detector) {
      Alert.alert(
        'Module Not Ready',
        'The MarkerDetector native module could not be found. Please rebuild the app.',
      );
      return;
    }

    // Reset state
    foundCountRef.current = 0;
    capturedListRef.current = [];
    setCapturedMarkers([]);
    setFoundCount(0);
    setStatusText('Scanning… point at a marker');
    setIsScanning(true);

    // Fire first capture immediately, then on interval
    doCapture();
    scanIntervalRef.current = setInterval(doCapture, CAPTURE_INTERVAL_MS);
  }, [doCapture]);

  const stopScanning = useCallback(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    setIsScanning(false);
    setStatusText(
      foundCountRef.current > 0
        ? `Stopped — ${foundCountRef.current}/${TARGET_COUNT} captured`
        : 'Tap ▶ Start Scanning to begin',
    );
  }, []);

  // Clean up interval on unmount
  useEffect(() => () => {
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
  }, []);

  // ── Permission not granted ─────────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.centered} edges={['top', 'bottom']}>
        <Text style={styles.permIcon}>📷</Text>
        <Text style={styles.permTitle}>Camera Permission Required</Text>
        <Text style={styles.permText}>
          AlemnoMarker needs camera access to scan markers. Please grant the permission to continue.
        </Text>

        {/* Ask again — works if not permanently denied */}
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={requestPermission}>
          <Text style={styles.btnLabel}>Grant Camera Permission</Text>
        </TouchableOpacity>

        {/* Open Settings — works if permanently denied */}
        <TouchableOpacity
          style={[styles.secondaryBtn, {marginTop: 10}]}
          onPress={() => Linking.openSettings()}>
          <Text style={styles.btnLabel}>Open App Settings</Text>
        </TouchableOpacity>

        <Text style={styles.permHint}>
          If the dialog does not appear, tap "Open App Settings" then Permissions then Camera then Allow
        </Text>
      </SafeAreaView>
    );
  }

  // ── Camera device not ready ────────────────────────────────────────────────
  if (!device) {
    return (
      <SafeAreaView style={styles.centered} edges={['top', 'bottom']}>
        <ActivityIndicator size="large" color="#6C63FF" />
        <Text style={styles.permText}>Initialising camera…</Text>
      </SafeAreaView>
    );
  }

  // ── Results screen ─────────────────────────────────────────────────────────
  if (screen === 'results') {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />

        <View style={styles.headerRow}>
          <Text style={styles.title}>📷 Captured Markers</Text>
          <Text style={styles.subtitle}>
            {capturedMarkers.length} / {TARGET_COUNT} collected
          </Text>
        </View>

        <FlatList
          data={capturedMarkers}
          keyExtractor={(_, i) => `m-${i}`}
          numColumns={3}
          contentContainerStyle={styles.grid}
          renderItem={({item, index}) => (
            <View style={styles.card}>
              <Image source={{uri: item}} style={styles.cardImg} resizeMode="contain" />
              <Text style={styles.cardIdx}>#{index + 1}</Text>
            </View>
          )}
        />

        <TouchableOpacity
          style={[styles.primaryBtn, {margin: 16}]}
          onPress={() => {
            capturedListRef.current = [];
            foundCountRef.current = 0;
            setCapturedMarkers([]);
            setFoundCount(0);
            setScreen('camera');
            setStatusText('Tap ▶ Start Scanning to begin');
          }}>
          <Text style={styles.btnLabel}>🔄 Scan Again</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ── Camera / scanning screen ───────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />

      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>🎯 Marker Scanner</Text>
        <Text style={styles.subtitle}>{statusText}</Text>
      </View>

      {/* Camera view — takes all remaining space */}
      <View style={styles.camWrap}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          photo={true}
          {...(format !== undefined ? {format} : {})}
          enableZoomGesture
        />

        {/* Animated targeting frame */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <View style={styles.overlayTop} />
          <View style={styles.overlayMiddle}>
            <View style={styles.overlaySide} />
            <Animated.View
              style={[
                styles.scanFrame,
                {transform: [{scale: pulseAnim}]},
                isScanning && styles.scanFrameActive,
              ]}>
              <View style={[styles.corner, styles.cTL]} />
              <View style={[styles.corner, styles.cTR]} />
              <View style={[styles.corner, styles.cBL]} />
              <View style={[styles.corner, styles.cBR]} />
            </Animated.View>
            <View style={styles.overlaySide} />
          </View>
          <View style={styles.overlayTop} />
        </View>

        {/* Capture spinner */}
        {isCapturing && (
          <View style={styles.spinnerWrap}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
      </View>

      {/* Progress bar */}
      <View style={styles.progressRow}>
        <View style={styles.progressBg}>
          <Animated.View
            style={[
              styles.progressFill,
              {width: `${(foundCount / TARGET_COUNT) * 100}%`},
            ]}
          />
        </View>
        <Text style={styles.progressLabel}>{foundCount}/{TARGET_COUNT}</Text>
      </View>

      {/* Action button */}
      <TouchableOpacity
        style={[styles.primaryBtn, isScanning && styles.stopBtn, styles.actionBtn]}
        onPress={isScanning ? stopScanning : startScanning}
        activeOpacity={0.8}>
        <Text style={styles.btnLabel}>
          {isScanning ? '⏹  Stop Scanning' : '▶  Start Scanning'}
        </Text>
      </TouchableOpacity>

      {/* View results shortcut when some captured */}
      {!isScanning && foundCount > 0 && (
        <TouchableOpacity
          style={[styles.secondaryBtn, styles.actionBtn]}
          onPress={() => setScreen('results')}>
          <Text style={styles.btnLabel}>📋 View {foundCount} Results</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:  {flex: 1, backgroundColor: '#1a1a2e'},
  centered:   {flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a1a2e', padding: 24},
  permIcon:   {fontSize: 52, marginBottom: 12},
  permTitle:  {color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 10, textAlign: 'center'},
  permText:   {color: '#a0a0c0', fontSize: 14, marginBottom: 24, textAlign: 'center', lineHeight: 22},
  permHint:   {color: '#606080', fontSize: 12, marginTop: 16, textAlign: 'center', lineHeight: 18},

  headerRow:  {paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center'},
  title:      {fontSize: 22, fontWeight: '800', color: '#fff'},
  subtitle:   {fontSize: 13, color: '#a0a0c0', marginTop: 4, textAlign: 'center'},

  // ── Camera ──
  camWrap: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#6C63FF',
    backgroundColor: '#000',
  },

  // ── Overlay vignette ──
  overlayTop:    {flex: 1, backgroundColor: 'rgba(0,0,0,0.25)'},
  overlayMiddle: {flexDirection: 'row', alignItems: 'center'},
  overlaySide:   {flex: 1, height: 220, backgroundColor: 'rgba(0,0,0,0.25)'},

  // ── Scan frame ──
  scanFrame: {
    width: 220,
    height: 220,
    position: 'relative',
  },
  scanFrameActive: {
    // slightly brighter when active — via corner colour
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
  },
  cTL: {top: 0, left: 0,  borderTopWidth: 4, borderLeftWidth: 4,   borderColor: '#6C63FF'},
  cTR: {top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4,  borderColor: '#6C63FF'},
  cBL: {bottom: 0, left: 0,  borderBottomWidth: 4, borderLeftWidth: 4,   borderColor: '#6C63FF'},
  cBR: {bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4,  borderColor: '#6C63FF'},

  // ── Spinner ──
  spinnerWrap: {
    position: 'absolute', top: 12, right: 12,
    backgroundColor: 'rgba(108,99,255,0.8)',
    padding: 8, borderRadius: 20,
  },

  // ── Progress ──
  progressRow:   {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 10},
  progressBg:    {flex: 1, height: 8, backgroundColor: '#2a2a4a', borderRadius: 4, overflow: 'hidden'},
  progressFill:  {height: '100%', backgroundColor: '#6C63FF', borderRadius: 4},
  progressLabel: {color: '#fff', fontSize: 13, fontWeight: '700', minWidth: 48, textAlign: 'right'},

  // ── Buttons ──
  primaryBtn:   {backgroundColor: '#6C63FF', padding: 16, borderRadius: 14, alignItems: 'center'},
  stopBtn:      {backgroundColor: '#e74c3c'},
  secondaryBtn: {backgroundColor: '#2a2a4a', padding: 14, borderRadius: 14, alignItems: 'center'},
  actionBtn:    {marginHorizontal: 16, marginBottom: 8},
  btnLabel:     {color: '#fff', fontSize: 16, fontWeight: '700'},

  // ── Results grid ──
  grid:    {padding: 8},
  card:    {flex: 1, margin: 4, alignItems: 'center', backgroundColor: '#2a2a4a', borderRadius: 10, padding: 6},
  cardImg: {width: 96, height: 96},
  cardIdx: {color: '#a0a0c0', fontSize: 11, marginTop: 4},
});
