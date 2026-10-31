package com.babeltalk.local

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.*
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.*
import java.util.Locale

/** No inference network calls. Download is a separate explicit setup action. */
class BabelLocalModule(private val app: ReactApplicationContext) : ReactContextBaseJavaModule(app) {
  private val main = Handler(Looper.getMainLooper())
  private val audio = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var tts: TextToSpeech? = null
  private var speechReady = false
  private var speechPromise: Promise? = null
  private var activeUtterance: String? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var previousSpeaker = false
  private var routeActive = false
  private var sessionActive = false
  private var privatePlayback = false
  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) {
      if (privatePlayback && speechPromise != null) { tts?.stop(); finishSpeech("Headphone output changed. Playback stopped to protect privacy.") }
    }
  }
  init { audio.registerAudioDeviceCallback(deviceCallback, main) }
  private val translators = mutableMapOf<String, Translator>()
  override fun getName() = "BabelLocal"
  private fun valid(code: String) = code in setOf("en", "ur", "ar")
  private fun translator(a: String, b: String): Translator {
    require(valid(a) && valid(b) && a != b) { "Unsupported translation pair" }
    return translators.getOrPut("$a:$b") { Translation.getClient(TranslatorOptions.Builder().setSourceLanguage(a).setTargetLanguage(b).build()) }
  }
  @ReactMethod fun preparePair(a: String, b: String, promise: Promise) {
    if (sessionActive) { promise.reject("BUSY", "End the session before downloading models"); return }
    try {
      translator(a,b).downloadModelIfNeeded(DownloadConditions.Builder().requireWifi().build())
        .addOnSuccessListener { promise.resolve(true) }
        .addOnFailureListener { promise.reject("MODEL_DOWNLOAD", it) }
    } catch (e: Exception) { promise.reject("PAIR", e) }
  }
  @ReactMethod fun pairReady(a: String, b: String, promise: Promise) {
    if (!valid(a) || !valid(b)) { promise.resolve(false); return }
    if (a == b) { promise.resolve(true); return }
    RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel::class.java)
      .addOnSuccessListener { models ->
        val downloaded = models.map { it.language }.toSet()
        promise.resolve(listOf(a,b).filter { it != "en" }.all { it in downloaded })
      }.addOnFailureListener { promise.reject("MODEL_STATUS", it) }
  }
  @ReactMethod fun translate(text: String, a: String, b: String, promise: Promise) {
    if (text.length > 8000) { promise.reject("TOO_LONG", "Use a shorter turn"); return }
    if (a == b && valid(a)) { promise.resolve(text); return }
    try {
      // Deliberately no downloadModelIfNeeded call here.
      translator(a,b).translate(text).addOnSuccessListener { promise.resolve(it) }
        .addOnFailureListener { promise.reject("TRANSLATION", "Offline translation failed. Prepare the pair in Models first.", it) }
    } catch (e: Exception) { promise.reject("TRANSLATION", e) }
  }
  @ReactMethod fun setSessionActive(active: Boolean, promise: Promise) { sessionActive = active; promise.resolve(true) }
  @ReactMethod fun initSpeech(promise: Promise) {
    main.post {
      if (speechReady) { promise.resolve(true); return@post }
      if (tts != null) { promise.reject("TTS_BUSY", "Voice engine is still starting"); return@post }
      tts = TextToSpeech(app) { status -> main.post {
        speechReady = status == TextToSpeech.SUCCESS
        if (speechReady) {
          tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { finishSpeech(null, id) }
            @Deprecated("Legacy callback") override fun onError(id: String?) { finishSpeech("Offline voice failed", id) }
            override fun onError(id: String?, errorCode: Int) { finishSpeech("Offline voice failed ($errorCode)", id) }
            override fun onStop(id: String?, interrupted: Boolean) { finishSpeech("Playback stopped", id) }
          })
          promise.resolve(true)
        } else { tts?.shutdown(); tts = null; promise.reject("TTS_INIT", "No speech engine installed. Translated text remains available.") }
      } }
    }
  }
  @ReactMethod fun offlineVoices(promise: Promise) {
    main.post {
      val result = Arguments.createArray()
      tts?.voices?.filter { !it.isNetworkConnectionRequired && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }?.forEach {
        val item = Arguments.createMap(); item.putString("language", it.locale.language); item.putString("name", it.name); result.pushMap(item)
      }
      promise.resolve(result)
    }
  }
  private fun route(destination: String) {
    previousMode = audio.mode; previousSpeaker = audio.isSpeakerphoneOn; routeActive = true
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= 31) {
      val headphones = setOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET)
      val device = audio.availableCommunicationDevices.firstOrNull { if (destination == "speaker") it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else it.type in headphones }
        ?: throw IllegalStateException("Requested output is unavailable. Connect headphones or select phone speaker.")
      check(audio.setCommunicationDevice(device)) { "The operating system rejected the output route" }
    } else {
      if (destination == "headphones" && !audio.isWiredHeadsetOn) { throw IllegalStateException("Use wired headphones on Android 7–11. Explicit Bluetooth routing requires Android 12+.") }
      audio.isSpeakerphoneOn = destination == "speaker"
    }
  }
  private fun restoreRoute() {
    if (!routeActive) return
    if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice()
    audio.isSpeakerphoneOn = previousSpeaker; audio.mode = previousMode; routeActive = false
  }
  private fun finishSpeech(error: String?, id: String? = null) { main.post {
    if (id != null && id != activeUtterance) return@post
    activeUtterance = null
    val pending = speechPromise; speechPromise = null; privatePlayback = false; restoreRoute()
    if (error == null) pending?.resolve(true) else pending?.reject("TTS", error)
  } }
  @ReactMethod fun speak(text: String, lang: String, destination: String, promise: Promise) {
    main.post {
      if (!speechReady || tts == null) { promise.reject("TTS_NOT_READY", "Prepare the voice engine first"); return@post }
      if (speechPromise != null) { promise.reject("TTS_BUSY", "Wait for playback to finish"); return@post }
      if (destination !in setOf("speaker", "headphones") || text.length > 3500) { promise.reject("TTS_INPUT", "Invalid output or text too long"); return@post }
      val language = Locale.forLanguageTag(lang).language
      val voice = tts?.voices?.filter { it.locale.language == language && !it.isNetworkConnectionRequired && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }?.maxByOrNull { it.quality }
      if (voice == null) { promise.reject("VOICE_MISSING", "Install an offline $lang voice in device Settings. Translated text is available."); return@post }
      try {
        route(destination)
        tts?.voice = voice
        tts?.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        privatePlayback = destination == "headphones"
        speechPromise = promise
        activeUtterance = "babel-${System.nanoTime()}"
        if (tts?.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), activeUtterance) != TextToSpeech.SUCCESS) finishSpeech("Speech engine rejected playback")
      } catch (e: Exception) { restoreRoute(); promise.reject("AUDIO_ROUTE", e) }
    }
  }
  @ReactMethod fun stopSpeech(promise: Promise) { main.post { tts?.stop(); finishSpeech("Playback stopped"); promise.resolve(true) } }
  @ReactMethod fun exportTranscript(content: String, format: String, promise: Promise) {
    main.post {
      try {
        require(format in setOf("json", "txt")) { "Unsupported export format" }
        val activity = app.currentActivity ?: throw IllegalStateException("Open BabelTalk to export")
        val directory = File(app.cacheDir, "exports"); directory.mkdirs()
        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach { it.delete() }
        val file = File(directory, "BabelTalk-${System.currentTimeMillis()}.$format"); file.writeText(content, Charsets.UTF_8)
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.exports", file)
        val intent = Intent(Intent.ACTION_SEND).setType(if (format == "json") "application/json" else "text/plain")
          .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.startActivity(Intent.createChooser(intent, "Export BabelTalk session")); promise.resolve(true)
      } catch (e: Exception) { promise.reject("EXPORT", e) }
    }
  }
  override fun invalidate() {
    audio.unregisterAudioDeviceCallback(deviceCallback)
    main.post { tts?.stop(); finishSpeech("App closed"); tts?.shutdown(); tts = null; translators.values.forEach { it.close() }; translators.clear() }
    super.invalidate()
  }
}
