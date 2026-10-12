package com.thediary

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Plain file I/O for the diary: settings, memories and the log.
 *
 * sn-plugin-lib can copy, rename and delete files but never write one, so
 * this is the whole of the plugin's native code. JS passes absolute paths,
 * normally under PluginManager.getPluginDirPath(), which needs no permission.
 */
class DiaryFilesModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = NAME

  @ReactMethod
  fun readText(path: String, promise: Promise) {
    try {
      val f = File(path)
      promise.resolve(if (f.isFile) f.readText(Charsets.UTF_8) else null)
    } catch (e: Exception) {
      promise.reject("READ_FAILED", e.message ?: "read failed", e)
    }
  }

  /** Write via a temp file and rename, so a crash never leaves half a file. */
  @ReactMethod
  fun writeText(path: String, text: String, promise: Promise) {
    try {
      val f = File(path)
      f.parentFile?.mkdirs()
      val tmp = File(f.parentFile, f.name + ".tmp")
      tmp.writeText(text, Charsets.UTF_8)
      if (!tmp.renameTo(f)) {
        f.writeText(text, Charsets.UTF_8)
        tmp.delete()
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("WRITE_FAILED", e.message ?: "write failed", e)
    }
  }

  /** Append a line, keeping the newest half once the file passes maxBytes. */
  @ReactMethod
  fun appendCapped(path: String, text: String, maxBytes: Double, promise: Promise) {
    try {
      val f = File(path)
      f.parentFile?.mkdirs()
      if (f.exists() && f.length() > maxBytes.toLong()) {
        val kept = f.readText(Charsets.UTF_8).takeLast((maxBytes / 2).toInt())
        f.writeText("[trimmed]\n$kept", Charsets.UTF_8)
      }
      f.appendText(text, Charsets.UTF_8)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("APPEND_FAILED", e.message ?: "append failed", e)
    }
  }

  @ReactMethod
  fun readBase64(path: String, promise: Promise) {
    try {
      val f = File(path)
      promise.resolve(if (f.isFile) Base64.encodeToString(f.readBytes(), Base64.NO_WRAP) else null)
    } catch (e: Exception) {
      promise.reject("READ_FAILED", e.message ?: "read failed", e)
    }
  }

  @ReactMethod
  fun remove(path: String, promise: Promise) {
    try {
      promise.resolve(File(path).delete())
    } catch (e: Exception) {
      promise.reject("DELETE_FAILED", e.message ?: "delete failed", e)
    }
  }

  @ReactMethod
  fun exists(path: String, promise: Promise) {
    promise.resolve(File(path).exists())
  }

  /**
   * POST over plain HTTP on a raw socket. The plugin host targets Android 15
   * and permits no cleartext traffic, so fetch("http://…") is refused before
   * it leaves the tablet. The diary bridge lives on the home network over
   * http, so this small HTTP/1.1 client carries those requests (https URLs
   * keep using fetch). Resolves {status, body}.
   */
  @ReactMethod
  fun httpPost(url: String, headers: ReadableMap, body: String, timeoutMs: Double, promise: Promise) {
    Thread {
      try {
        val u = URL(url)
        require(u.protocol == "http") { "only http:// is handled here" }
        val port = if (u.port > 0) u.port else 80
        val payload = body.toByteArray(Charsets.UTF_8)
        Socket().use { sock ->
          sock.connect(InetSocketAddress(u.host, port), 10_000)
          sock.soTimeout = timeoutMs.toInt()
          val head = StringBuilder()
          head.append("POST ${if (u.file.isNullOrEmpty()) "/" else u.file} HTTP/1.1\r\n")
          head.append("Host: ${u.host}:$port\r\n")
          val it = headers.keySetIterator()
          while (it.hasNextKey()) {
            val k = it.nextKey()
            head.append("$k: ${headers.getString(k)}\r\n")
          }
          head.append("Content-Length: ${payload.size}\r\n")
          head.append("Connection: close\r\n\r\n")
          val out = sock.getOutputStream()
          out.write(head.toString().toByteArray(Charsets.UTF_8))
          out.write(payload)
          out.flush()
          val raw = readAll(sock.getInputStream())
          val split = indexOf(raw, "\r\n\r\n".toByteArray())
          require(split >= 0) { "malformed HTTP response" }
          val headText = String(raw, 0, split, Charsets.ISO_8859_1)
          val status = headText.lineSequence().first().split(" ").getOrNull(1)?.toIntOrNull() ?: 0
          var content = raw.copyOfRange(split + 4, raw.size)
          if (headText.lowercase().contains("transfer-encoding: chunked")) content = dechunk(content)
          val result = WritableNativeMap()
          result.putInt("status", status)
          result.putString("body", String(content, Charsets.UTF_8))
          promise.resolve(result)
        }
      } catch (e: Exception) {
        promise.reject("HTTP_FAILED", e.toString(), e)
      }
    }.start()
  }

  private fun readAll(input: InputStream): ByteArray {
    val buf = ByteArrayOutputStream()
    val chunk = ByteArray(16 * 1024)
    while (true) {
      val n = input.read(chunk)
      if (n < 0) break
      buf.write(chunk, 0, n)
    }
    return buf.toByteArray()
  }

  private fun indexOf(data: ByteArray, pattern: ByteArray): Int {
    outer@ for (i in 0..data.size - pattern.size) {
      for (j in pattern.indices) if (data[i + j] != pattern[j]) continue@outer
      return i
    }
    return -1
  }

  private fun dechunk(data: ByteArray): ByteArray {
    val out = ByteArrayOutputStream()
    var i = 0
    while (i < data.size) {
      val lineEnd = indexOf(data.copyOfRange(i, data.size), "\r\n".toByteArray())
      if (lineEnd < 0) break
      val size = String(data, i, lineEnd, Charsets.ISO_8859_1).substringBefore(';').trim().toIntOrNull(16) ?: break
      if (size == 0) break
      val start = i + lineEnd + 2
      out.write(data, start, minOf(size, data.size - start))
      i = start + size + 2
    }
    return out.toByteArray()
  }

  companion object {
    const val NAME = "DiaryFiles"
  }
}
