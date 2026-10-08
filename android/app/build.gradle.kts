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

  // Releases are signed with the same key every time (an update has to match the installed app).
  // The key is public, in the repository (android/release.jks): anyone can sign with it, so install
  // only from this project's GitHub releases. TW_KEYSTORE / TW_KEYSTORE_PASSWORD use another key.
  signingConfigs {
    create("release") {
      storeFile = file(System.getenv("TW_KEYSTORE") ?: "../release.jks")
      storePassword = System.getenv("TW_KEYSTORE_PASSWORD") ?: "OewNWntWQdrLHFE8aoF9SOJTIUOF"
      keyAlias = System.getenv("TW_KEY_ALIAS") ?: "tmuxweb"
      keyPassword = System.getenv("TW_KEYSTORE_PASSWORD") ?: "OewNWntWQdrLHFE8aoF9SOJTIUOF"
    }
  }
  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("release")
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
