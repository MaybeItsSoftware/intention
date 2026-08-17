import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    namespace = "uk.co.maybeitssoftware.intention"
    compileSdk = 36

    defaultConfig {
        applicationId = "uk.co.maybeitssoftware.intention"
        minSdk = 26
        targetSdk = 36
        versionCode = 46
        versionName = "0.22.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            } else {
                // CI path: decode ANDROID_KEYSTORE_BASE64 to a file and point ANDROID_KEYSTORE_PATH at it.
                System.getenv("ANDROID_KEYSTORE_PATH")?.let { storeFile = file(it) }
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Pulled in explicitly (over appcompat's transitive version) for enableEdgeToEdge(),
    // required for correct edge-to-edge behaviour on Android 15+ (targetSdk 35+).
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    // Google Play Billing — Intention Pro, the subscription that powers the
    // built-in coach (BillingManager.kt).
    implementation("com.android.billingclient:billing-ktx:8.0.0")
}
