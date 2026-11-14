import java.util.Properties

plugins { id("com.android.application") }

// Signing: android/keystore.properties (not in git) points at the release keystore. Keep that
// keystore: every update of the app must be signed with the same key, or the TV refuses it.
val keys = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.driveshare.tv"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.driveshare.tv"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "1.1"
        // The site the app opens (your own deployment: change it here).
        buildConfigField("String", "SITE", "\"https://driveshare-p977.web.app\"")
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        if (keys.getProperty("storeFile") != null) create("release") {
            storeFile = rootProject.file(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
