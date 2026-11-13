package com.babeltalk.local

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteOrder

private const val SAMPLE_RATE = 16000
private const val MAX_SAMPLES = SAMPLE_RATE * 600

internal fun decodeAudio(context: Context, uri: Uri): String {
  val extractor = MediaExtractor()
  val output = File.createTempFile("babel-audio-", ".wav", context.cacheDir)
  try {
    extractor.setDataSource(context, uri, null)
    val track = (0 until extractor.trackCount).firstOrNull {
      extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
    } ?: error("The selected file has no decodable audio track.")
    extractor.selectTrack(track)
    val format = extractor.getTrackFormat(track)
    if (format.containsKey(MediaFormat.KEY_DURATION)) {
      require(format.getLong(MediaFormat.KEY_DURATION) <= 600_000_000L) {
        "Choose a recording up to 10 minutes."
      }
    }
    val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
    try {
      codec.configure(format, null, null, 0)
      codec.start()
      RandomAccessFile(output, "rw").use { wave ->
        wave.setLength(44)
        wave.seek(44)
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false
        var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        var encoding = AudioFormat.ENCODING_PCM_16BIT
        var phase = 0
        var total = 0
        var sum = 0.0
        var count = 0
        var lastProgress = android.os.SystemClock.elapsedRealtime()
        val pcm = ByteArray(8192)
        var offset = 0
        while (!outputDone) {
          if (!inputDone) {
            val index = codec.dequeueInputBuffer(10_000)
            if (index >= 0) {
              val size = extractor.readSampleData(codec.getInputBuffer(index)!!, 0)
              inputDone = size < 0
              codec.queueInputBuffer(index, 0, size.coerceAtLeast(0),
                if (inputDone) 0 else extractor.sampleTime,
                if (inputDone) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
              if (!inputDone) extractor.advance()
            }
          }
          val index = codec.dequeueOutputBuffer(info, 10_000)
          if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            val actual = codec.outputFormat
            rate = actual.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            channels = actual.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            encoding = if (actual.containsKey(MediaFormat.KEY_PCM_ENCODING))
              actual.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
          }
          if (index >= 0 && info.size > 0) {
            require(rate > 0 && channels in 1..32 &&
              encoding in setOf(AudioFormat.ENCODING_PCM_16BIT, AudioFormat.ENCODING_PCM_FLOAT)) {
              "This decoder returned an unsupported audio format."
            }
            val buffer = codec.getOutputBuffer(index)!!.order(ByteOrder.LITTLE_ENDIAN)
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            val floating = encoding == AudioFormat.ENCODING_PCM_FLOAT
            val frameBytes = channels * if (floating) 4 else 2
            while (buffer.remaining() >= frameBytes) {
              var mono = 0.0
              repeat(channels) { mono += if (floating) buffer.float * 32768.0 else buffer.short.toDouble() }
              sum += mono / channels
              count++
              phase += SAMPLE_RATE
              while (phase >= rate) {
                val sample = (sum / count).toInt().coerceIn(-32768, 32767)
                require(total < MAX_SAMPLES) { "Choose a recording up to 10 minutes." }
                pcm[offset++] = sample.toByte()
                pcm[offset++] = (sample shr 8).toByte()
                total++
                if (offset == pcm.size) { wave.write(pcm); offset = 0 }
                phase -= rate
              }
              if (phase < SAMPLE_RATE) { sum = 0.0; count = 0 }
            }
          }
          if (index >= 0) {
            outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            codec.releaseOutputBuffer(index, false)
            lastProgress = android.os.SystemClock.elapsedRealtime()
          }
          check(android.os.SystemClock.elapsedRealtime() - lastProgress < 15000) { "The audio decoder stalled." }
        }
        wave.write(pcm, 0, offset)
        require(total > 0) { "The recording contains no decoded samples." }
        wave.seek(0)
        wave.writeBytes("RIFF")
        wave.writeInt(Integer.reverseBytes(36 + total * 2))
        wave.writeBytes("WAVEfmt ")
        wave.writeInt(Integer.reverseBytes(16))
        wave.write(byteArrayOf(1, 0, 1, 0))
        wave.writeInt(Integer.reverseBytes(SAMPLE_RATE))
        wave.writeInt(Integer.reverseBytes(SAMPLE_RATE * 2))
        wave.write(byteArrayOf(2, 0, 16, 0))
        wave.writeBytes("data")
        wave.writeInt(Integer.reverseBytes(total * 2))
      }
    } finally {
      codec.release()
    }
    return output.path
  } catch (error: Exception) {
    output.delete()
    throw error
  } finally {
    extractor.release()
  }
}
