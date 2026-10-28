package com.easytier.jni

/** The native EasyTier entry points used by the app. The two libraries load in dependency order. */
object EasyTierJNI {
  init {
    System.loadLibrary("easytier_ffi")
    System.loadLibrary("easytier_android_jni")
  }

  @JvmStatic external fun parseConfig(config: String): Int

  @JvmStatic external fun runNetworkInstance(config: String): Int

  /** Keeps these instances and stops the rest; null or an empty array stops all of them. */
  @JvmStatic external fun retainNetworkInstance(instanceNames: Array<String>?): Int

  @JvmStatic external fun getLastError(): String?
}
