package com.alemnomarker

import android.graphics.*
import com.facebook.react.bridge.*
import kotlin.math.*

class MarkerDetectorModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "MarkerDetector"

    @ReactMethod
    fun detectMarker(base64Image: String, promise: Promise) {
        try {
            val imageBytes = android.util.Base64.decode(base64Image, android.util.Base64.DEFAULT)
            val original = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
                ?: run { promise.reject("ERROR", "Failed to decode image"); return }

            // Downscale for speed — 650px is plenty for detecting large bordered squares
            val working = scaleBitmap(original, 650)

            // Prioritise straight / upside-down first (resolve in 1-2 tries),
            // then the diagonal orientations
            val angles = floatArrayOf(0f, 180f, 90f, 270f, 45f, 135f, 225f, 315f)
            for (angle in angles) {
                val rotated = if (angle == 0f) working else rotateBitmap(working, angle)
                val result = processMarker(rotated)
                if (result.isNotEmpty()) {
                    promise.resolve(result)
                    return
                }
            }
            promise.reject("NOT_FOUND", "No marker detected")
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private fun scaleBitmap(bm: Bitmap, maxDim: Int): Bitmap {
        val w = bm.width; val h = bm.height
        if (w <= maxDim && h <= maxDim) return bm
        val scale = maxDim.toFloat() / maxOf(w, h)
        return Bitmap.createScaledBitmap(bm, (w * scale).toInt(), (h * scale).toInt(), true)
    }

    private fun rotateBitmap(bm: Bitmap, angle: Float): Bitmap {
        val m = Matrix().also { it.postRotate(angle) }
        return Bitmap.createBitmap(bm, 0, 0, bm.width, bm.height, m, true)
    }

    // ── Core detection (unchanged logic, relaxed fill ratio for tilted frames) ─

    private fun processMarker(bitmap: Bitmap): String {
        val width = bitmap.width
        val height = bitmap.height

        // Step 1: Grayscale binary — batch getPixels() avoids per-pixel JNI overhead
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val binary = Array(height) { y ->
            BooleanArray(width) { x ->
                val pixel = pixels[y * width + x]
                val gray = (0.299 * Color.red(pixel) + 0.587 * Color.green(pixel) + 0.114 * Color.blue(pixel)).toInt()
                gray < 128
            }
        }

        // Step 2: Connected components
        val visited = Array(height) { BooleanArray(width) }
        val components = mutableListOf<BoundingBox>()
        for (y in 0 until height) {
            for (x in 0 until width) {
                if (binary[y][x] && !visited[y][x]) {
                    val box = floodFillBBox(binary, visited, x, y, width, height)
                    if (box != null) components.add(box)
                }
            }
        }

        // Step 3: Find outer square border (strict original thresholds — no false positives)
        var outerBorder: BoundingBox? = null
        var bestScore = 0.0

        for (box in components) {
            val bboxW = (box.maxX - box.minX).toDouble()
            val bboxH = (box.maxY - box.minY).toDouble()
            if (bboxW < 80 || bboxH < 80) continue
            val ar = bboxW / bboxH
            if (ar < 0.75 || ar > 1.25) continue          // strict square
            val fillRatio = box.pixelCount.toDouble() / (bboxW * bboxH)
            if (fillRatio < 0.12 || fillRatio > 0.60) continue  // hollow frame only
            val score = bboxW * bboxH * (1.0 - abs(1.0 - ar))
            if (score > bestScore) { bestScore = score; outerBorder = box }
        }

        if (outerBorder == null) return ""

        val markerW = outerBorder.maxX - outerBorder.minX
        val markerH = outerBorder.maxY - outerBorder.minY

        // Step 4: Corner square detection
        val expectedCornerSize = (minOf(markerW, markerH) * 0.143).toInt()
        val borderThickness    = (minOf(markerW, markerH) * 0.15).toInt()
        val tolerance          = maxOf(5, (expectedCornerSize * 0.65).toInt())

        val cornerResult = findCornerSquare(
            outerBorder.minX, outerBorder.minY,
            outerBorder.maxX, outerBorder.maxY,
            borderThickness, expectedCornerSize, tolerance, components
        )
        if (!cornerResult.found) return ""

        // Step 5: Crop + orient + resize to 300×300
        // padding = 0 as required: "tightly cropped with no surrounding padding"
        val cropX = maxOf(0, outerBorder.minX)
        val cropY = maxOf(0, outerBorder.minY)
        val cropW = minOf(width  - cropX, markerW)
        val cropH = minOf(height - cropY, markerH)
        if (cropW <= 0 || cropH <= 0) return ""

        val cropped = Bitmap.createBitmap(bitmap, cropX, cropY, cropW, cropH)
        val oriented = if (cornerResult.rotationNeeded != 0f) {
            val m = Matrix().also { it.postRotate(cornerResult.rotationNeeded) }
            Bitmap.createBitmap(cropped, 0, 0, cropped.width, cropped.height, m, true)
        } else cropped

        val resized = Bitmap.createScaledBitmap(oriented, 300, 300, true)
        val stream  = java.io.ByteArrayOutputStream()
        resized.compress(Bitmap.CompressFormat.JPEG, 92, stream)
        return android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.DEFAULT)
    }

    // ── Data classes ───────────────────────────────────────────────────────────

    data class BoundingBox(val minX: Int, val minY: Int, val maxX: Int, val maxY: Int, val pixelCount: Int)
    data class CornerResult(val found: Boolean, val rotationNeeded: Float = 0f)
    data class Quad(val x1: Int, val y1: Int, val x2: Int, val y2: Int, val rotation: Float)

    // ── Flood fill ─────────────────────────────────────────────────────────────

    private fun floodFillBBox(
        binary: Array<BooleanArray>, visited: Array<BooleanArray>,
        startX: Int, startY: Int, width: Int, height: Int
    ): BoundingBox? {
        var minX = startX; var maxX = startX
        var minY = startY; var maxY = startY
        var count = 0
        val stack = ArrayDeque<Pair<Int, Int>>()
        stack.add(Pair(startX, startY))
        visited[startY][startX] = true
        val dx = intArrayOf(0, 0, 1, -1)
        val dy = intArrayOf(1, -1, 0, 0)
        while (stack.isNotEmpty()) {
            val (x, y) = stack.removeLast()
            count++
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
            for (i in 0..3) {
                val nx = x + dx[i]; val ny = y + dy[i]
                if (nx in 0 until width && ny in 0 until height && !visited[ny][nx] && binary[ny][nx]) {
                    visited[ny][nx] = true
                    stack.add(Pair(nx, ny))
                }
            }
        }
        return if (count > 50) BoundingBox(minX, minY, maxX, maxY, count) else null
    }

    // ── Corner square finder ───────────────────────────────────────────────────

    private fun findCornerSquare(
        minX: Int, minY: Int, maxX: Int, maxY: Int,
        borderThickness: Int, expectedSize: Int, tolerance: Int,
        components: List<BoundingBox>
    ): CornerResult {
        val markerW = maxX - minX
        val markerH = maxY - minY
        val searchZone = (minOf(markerW, markerH) * 0.40).toInt()
        val minDist    = borderThickness / 2

        val corners = listOf(
            Quad(minX + minDist, minY + minDist, minX + searchZone, minY + searchZone, 0f),
            Quad(maxX - searchZone, minY + minDist, maxX - minDist, minY + searchZone, 270f),
            Quad(minX + minDist, maxY - searchZone, minX + searchZone, maxY - minDist, 90f),
            Quad(maxX - searchZone, maxY - searchZone, maxX - minDist, maxY - minDist, 180f)
        )

        for (corner in corners) {
            for (comp in components) {
                val compW = comp.maxX - comp.minX
                val compH = comp.maxY - comp.minY
                if (abs(compW - expectedSize) > tolerance) continue
                if (abs(compH - expectedSize) > tolerance) continue
                val ar = compW.toDouble() / maxOf(compH, 1).toDouble()
                if (ar < 0.45 || ar > 2.2) continue         // restored strict AR
                val fillRatio = comp.pixelCount.toDouble() / maxOf(compW * compH, 1)
                if (fillRatio < 0.60) continue               // restored: must be solid square
                val cx = (comp.minX + comp.maxX) / 2
                val cy = (comp.minY + comp.maxY) / 2
                if (cx < corner.x1 || cx > corner.x2) continue
                if (cy < corner.y1 || cy > corner.y2) continue
                if (comp.minX <= minX + 2 && corner.rotation == 0f) continue
                if (comp.minY <= minY + 2 && corner.rotation == 0f) continue
                return CornerResult(found = true, rotationNeeded = corner.rotation)
            }
        }
        return CornerResult(found = false)
    }
}
