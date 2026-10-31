package com.babeltalk.local

import android.database.sqlite.SQLiteDatabase
import com.facebook.react.bridge.*
import java.util.concurrent.Executors

/** Serial, parameterised SQLite connection in app-private storage. */
class BabelStorageModule(private val app: ReactApplicationContext) : ReactContextBaseJavaModule(app) {
  private val worker = Executors.newSingleThreadExecutor()
  private var db: SQLiteDatabase? = null
  override fun getName() = "BabelStorage"
  private fun database(): SQLiteDatabase {
    if (db == null) {
      db = app.openOrCreateDatabase("babeltalk.sqlite", 0, null)
      db!!.execSQL("PRAGMA foreign_keys=ON")
      db!!.execSQL("PRAGMA secure_delete=ON")
    }
    return db!!
  }
  @ReactMethod fun execute(sql: String, params: ReadableArray, promise: Promise) {
    worker.execute {
      try {
        val connection = database()
        val values = (0 until params.size()).map { i -> when(params.getType(i)) {
          ReadableType.Null -> null
          ReadableType.String -> params.getString(i)
          ReadableType.Number -> params.getDouble(i)
          ReadableType.Boolean -> if (params.getBoolean(i)) 1 else 0
          else -> throw IllegalArgumentException("SQL values must be scalar")
        } }.toTypedArray()
        val rows = Arguments.createArray()
        if (sql.trimStart().startsWith("SELECT", true) || sql.trimStart().startsWith("PRAGMA", true)) {
          connection.rawQuery(sql, values.map { it?.toString() }.toTypedArray()).use { cursor ->
            while (cursor.moveToNext()) {
              val row = Arguments.createMap()
              for (i in 0 until cursor.columnCount) {
                val key = cursor.getColumnName(i)
                when(cursor.getType(i)) {
                  android.database.Cursor.FIELD_TYPE_NULL -> row.putNull(key)
                  android.database.Cursor.FIELD_TYPE_INTEGER, android.database.Cursor.FIELD_TYPE_FLOAT -> row.putDouble(key, cursor.getDouble(i))
                  else -> row.putString(key, cursor.getString(i))
                }
              }
              rows.pushMap(row)
            }
          }
        } else connection.execSQL(sql, values)
        val result = Arguments.createMap(); result.putArray("rows", rows); promise.resolve(result)
      } catch(e: Exception) { promise.reject("SQLITE", e) }
    }
  }
  override fun invalidate() { worker.execute { db?.close(); db = null }; worker.shutdown(); super.invalidate() }
}
