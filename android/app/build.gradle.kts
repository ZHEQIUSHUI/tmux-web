plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.zheqiushui.tmuxweb"
  compileSdk = 35
  buildToolsVersion = "35.0.0"

  defaultConfig {
    applicationId = "com.zheqiushui.tmuxweb"
    minSdk = 26
    targetSdk = 35
    // CI passes the release's version: -PversionName=1.2.0 -PversionCode=10200
    versionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
    versionName = (findProperty("versionName") as String?) ?: "0.1.0"
  }

  // releases are signed with the same key every time (an update must match), kept out of the repo:
  // TW_KEYSTORE (path), TW_KEYSTORE_PASSWORD; without them the debug key is used
  val keystore = System.getenv("TW_KEYSTORE")
  signingConfigs {
    if (keystore != null) create("release") {
      storeFile = file(keystore)
      storePassword = System.getenv("TW_KEYSTORE_PASSWORD")
      keyAlias = System.getenv("TW_KEY_ALIAS") ?: "tmuxweb"
      keyPassword = System.getenv("TW_KEYSTORE_PASSWORD")
    }
  }
  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { buildConfig = true }
  packaging {
    resources {
      excludes += setOf("META-INF/versions/**", "META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/DEPENDENCIES")
    }
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("com.hierynomus:sshj:0.39.0")
  implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
  implementation("org.bouncycastle:bcpkix-jdk18on:1.78.1")
  implementation("org.slf4j:slf4j-nop:2.0.13")
}
