package com.babeltalk.local

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule

class ScreenAudioService : Service() {
  companion object {
    private const val CHANNEL = "babeltalk_screen_audio"
    private const val STOP = "com.babeltalk.STOP_SCREEN_AUDIO"
    private var pending: Promise? = null
    @Volatile private var bridge: ReactApplicationContext? = null
    private var captureRequested = false
    private var active: ScreenAudioService? = null

    fun launch(context: ReactApplicationContext, result: Int, token: Intent, promise: Promise) {
      if (captureRequested || active != null) {
        promise.reject("CAPTURE_BUSY", "Stop the active screen audio session first.")
        return
      }
      pending = promise
      bridge = context
      captureRequested = true
      try {
        context.startForegroundService(Intent(context, ScreenAudioService::class.java)
          .putExtra("result", result).putExtra("consent", token))
      } catch (error: Exception) {
        captureRequested = false
        pending = null
        bridge = null
        promise.reject("SCREEN_AUDIO", error)
      }
    }

    fun halt() {
      captureRequested = false
      pending?.reject("CAPTURE_CANCELLED", "Screen audio sharing was stopped.")
      pending = null
      active?.stopCapture(null)
      bridge = null
      // A queued service start must still enter foreground before it stops.
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private var projection: MediaProjection? = null
  private var recorder: AudioRecord? = null
  @Volatile private var running = false
  private var stopping = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) {
      stopCapture("Screen audio sharing stopped.")
      return START_NOT_STICKY
    }
    val notificationManager = getSystemService(NotificationManager::class.java)
    notificationManager.createNotificationChannel(NotificationChannel(CHANNEL, "Screen audio capture", NotificationManager.IMPORTANCE_LOW))
    val stop = PendingIntent.getService(this, 0, Intent(this, ScreenAudioService::class.java).setAction(STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val reopen = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val notice = Notification.Builder(this, CHANNEL)
      .setContentTitle("BabelTalk screen audio")
      .setContentText("Translating permitted playback audio")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentIntent(reopen)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
    try {
      startForeground(6212, notice)
      if (Build.VERSION.SDK_INT < 29 || !captureRequested || intent == null) {
        stopCapture(null)
        return START_NOT_STICKY
      }
      active = this
      @Suppress("DEPRECATION")
      val consent = intent.getParcelableExtra<Intent>("consent") ?: error("Screen capture consent is missing.")
      val manager = getSystemService(MediaProjectionManager::class.java)
      val session = manager.getMediaProjection(intent.getIntExtra("result", 0), consent)
        ?: error("Android refused the screen capture session.")
      projection = session
      session.registerCallback(object : MediaProjection.Callback() {
        override fun onStop() { stopCapture("Android ended screen audio sharing.") }
      }, main)
      val configuration = AudioPlaybackCaptureConfiguration.Builder(session)
        .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
        .addMatchingUsage(AudioAttributes.USAGE_GAME)
        .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
        .excludeUid(applicationInfo.uid)
        .build()
      val format = AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
      val minimum = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val audio = AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(maxOf(minimum, 12288))
        .setAudioPlaybackCaptureConfig(configuration).build()
      recorder = audio
      audio.startRecording()
      check(audio.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Android could not start playback capture." }
      running = true
      Thread({ forwardAudio(audio) }, "BabelScreenAudio").start()
      pending?.resolve(null)
      pending = null
    } catch (error: Exception) {
      pending?.reject("SCREEN_AUDIO", error)
      pending = null
      stopCapture(null)
    }
    return START_NOT_STICKY
  }

  private fun forwardAudio(audio: AudioRecord) {
    val input = ShortArray(3072)
    val output = ByteArray(2048)
    var sum = 0
    var count = 0
    try {
      while (running) {
        val read = audio.read(input, 0, input.size)
        if (!running) break
        check(read >= 0) { "Android interrupted playback capture." }
        var offset = 0
        for (i in 0 until read) {
          sum += input[i]
          count++
          if (count == 3) {
            val sample = sum / 3
            output[offset++] = sample.toByte()
            output[offset++] = (sample shr 8).toByte()
            sum = 0
            count = 0
          }
        }
        if (offset > 0 && running) {
          bridge?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit("BabelScreenPcm", Base64.encodeToString(output, 0, offset, Base64.NO_WRAP))
        }
      }
    } catch (error: Exception) {
      main.post { stopCapture(error.message ?: "Screen audio capture ended.") }
    } finally {
      audio.release()
    }
  }

  private fun stopCapture(message: String?) {
    if (stopping) return
    stopping = true
    val wasRunning = running
    running = false
    val audio = recorder
    recorder = null
    if (audio != null) {
      runCatching { audio.stop() }
      if (!wasRunning) audio.release()
    }
    projection?.stop()
    projection = null
    if (message != null) {
      bridge?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("BabelScreenEnded", message)
    }
    pending?.reject("CAPTURE_STOPPED", message ?: "Screen audio sharing stopped.")
    pending = null
    captureRequested = false
    bridge = null
    if (active === this) active = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    stopCapture("Screen audio sharing ended.")
    super.onDestroy()
  }
}
