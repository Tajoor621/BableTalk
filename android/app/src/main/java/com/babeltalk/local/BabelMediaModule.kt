package com.babeltalk.local

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import com.facebook.react.bridge.*
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executors

class BabelMediaModule(private val app: ReactApplicationContext) : ReactContextBaseJavaModule(app) {
  private val worker = Executors.newSingleThreadExecutor()
  private var selection: Promise? = null
  private var mode = ""
  private var language = ""
  private var consent: Promise? = null

  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      when (requestCode) {
        6210 -> {
          val promise = selection ?: return
          selection = null
          val uri = data?.data
          if (resultCode != Activity.RESULT_OK || uri == null) {
            promise.resolve(null)
            return
          }
          val operation = mode
          val selectedLanguage = language
          worker.execute {
            try {
              val result = when (operation) {
                "text" -> readText(uri)
                "photo" -> recognisePhoto(uri, selectedLanguage)
                else -> decodeAudio(app, uri)
              }
              promise.resolve(result)
            } catch (error: Exception) {
              promise.reject("MEDIA_IMPORT", error)
            }
          }
        }
        6211 -> {
          val promise = consent ?: return
          consent = null
          if (resultCode != Activity.RESULT_OK || data == null) {
            promise.reject("CAPTURE_CANCELLED", "Screen audio sharing was cancelled.")
            return
          }
          ScreenAudioService.launch(app, resultCode, data, promise)
        }
      }
    }
  }

  init { app.addActivityEventListener(listener) }
  override fun getName() = "BabelMedia"

  private fun choose(type: String, operation: String, code: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = app.currentActivity
      if (activity == null || selection != null || consent != null) {
        promise.reject("PICKER_BUSY", "Return to BabelTalk and close the open picker.")
        return@runOnUiThread
      }
      selection = promise
      mode = operation
      language = code
      try {
        val picker = Intent(Intent.ACTION_OPEN_DOCUMENT)
          .addCategory(Intent.CATEGORY_OPENABLE).setType(type)
        if (operation == "audio") {
          picker.putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "video/*"))
        }
        activity.startActivityForResult(picker, 6210)
      } catch (error: Exception) {
        selection = null
        promise.reject("PICKER", error)
      }
    }
  }

  @ReactMethod fun pickText(promise: Promise) = choose("text/plain", "text", "", promise)
  @ReactMethod fun pickPhoto(code: String, promise: Promise) = choose("image/*", "photo", code, promise)
  @ReactMethod fun pickAudio(promise: Promise) = choose("*/*", "audio", "", promise)

  private fun readText(uri: Uri): String {
    val input = app.contentResolver.openInputStream(uri) ?: error("Could not open the text file.")
    val bytes = input.use { stream ->
      val data = ByteArray(262145)
      var size = 0
      while (size < data.size) {
        val read = stream.read(data, size, data.size - size)
        if (read <= 0) break
        size += read
      }
      require(size < data.size) { "Choose a UTF-8 text file up to 256 KB." }
      data.copyOf(size)
    }
    return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes)).toString().removePrefix("\uFEFF")
  }

  private fun orientPhoto(uri: Uri, bitmap: Bitmap): Bitmap {
    val orientation = runCatching {
      app.contentResolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      }
    }.getOrNull()
    val transform = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> transform.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> transform.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> transform.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        transform.setRotate(90f)
        transform.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> transform.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        transform.setRotate(-90f)
        transform.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> transform.setRotate(-90f)
      else -> return bitmap
    }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, transform, true)
  }

  private fun recognisePhoto(uri: Uri, code: String): String {
    require(code in setOf("eng", "urd", "ara", "pus", "chi_sim", "chi_tra")) { "Choose a supported photo language." }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    app.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Choose a readable image." }
    val options = BitmapFactory.Options()
    while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize.coerceAtLeast(1) > 3200) {
      options.inSampleSize = options.inSampleSize.coerceAtLeast(1) * 2
    }
    val bitmap = app.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
      ?: error("Could not decode the photo.")
    try {
      val oriented = orientPhoto(uri, bitmap)
      try {
        if (code.startsWith("chi_")) {
          val recognised = recogniseChinese(oriented)
          if (recognised != null) return recognised
        }
        return recogniseWithTesseract(oriented, code)
      } finally {
        if (oriented !== bitmap) oriented.recycle()
      }
    } finally {
      bitmap.recycle()
    }
  }

  private fun recogniseChinese(bitmap: Bitmap): String? {
    val engine = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    return try {
      val text = Tasks.await(engine.process(InputImage.fromBitmap(bitmap, 0))).text
      text.takeIf { candidate ->
        candidate.codePoints().anyMatch { Character.UnicodeScript.of(it) == Character.UnicodeScript.HAN }
      }
    } catch (error: java.util.concurrent.ExecutionException) {
      null
    } finally {
      engine.close()
    }
  }

  private fun recogniseWithTesseract(bitmap: Bitmap, code: String): String {
    val root = File(app.filesDir, "ocr-v1")
    val folder = File(root, "tessdata").apply { mkdirs() }
    val model = File(folder, "$code.traineddata")
    if (!model.exists()) {
      val temporary = File(folder, "$code.tmp")
      try {
        app.assets.open("tessdata/$code.traineddata").use { input ->
          temporary.outputStream().use { input.copyTo(it) }
        }
        check(temporary.renameTo(model)) { "Could not install the photo recognition model." }
      } finally {
        temporary.delete()
      }
    }
    val engine = TessBaseAPI()
    try {
      check(engine.init(root.path, code)) { "Could not load the photo recognition model." }
      engine.setImage(bitmap)
      return engine.getUTF8Text().orEmpty()
    } finally {
      engine.recycle()
    }
  }

  @ReactMethod fun startScreenAudio(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = app.currentActivity
      if (Build.VERSION.SDK_INT < 29 || activity == null || consent != null || selection != null) {
        promise.reject("SCREEN_AUDIO", "Screen audio needs Android 10 or later and an open BabelTalk window.")
        return@runOnUiThread
      }
      try {
        consent = promise
        val manager = activity.getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= 34) {
          manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
          manager.createScreenCaptureIntent()
        }
        activity.startActivityForResult(intent, 6211)
      } catch (error: Exception) {
        consent = null
        promise.reject("SCREEN_AUDIO", error)
      }
    }
  }

  @ReactMethod fun stopScreenAudio(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      consent?.reject("CAPTURE_CANCELLED", "Screen audio sharing was stopped.")
      consent = null
      ScreenAudioService.halt()
      promise.resolve(null)
    }
  }

  override fun invalidate() {
    app.removeActivityEventListener(listener)
    ScreenAudioService.halt()
    worker.shutdown()
    super.invalidate()
  }
}
