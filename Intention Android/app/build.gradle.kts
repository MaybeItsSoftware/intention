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
        versionCode = 62
        versionName = "0.23.1"

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
    testOptions {
        // The pure decision functions under test (AppParts.verdict,
        // LeavePolicy.allows, RemovalSurfaceMatcher) never call the framework,
        // but the mockable android.jar still has to answer for the classes
        // they are compiled against. Default values rather than a throw is the
        // only thing that lets a plain JVM test run at all.
        unitTests.isReturnDefaultValues = true
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

    // Local JVM tests for the pure halves of the blocking decisions — the
    // ones a wrong answer in silently unblocks something. org.json is the real
    // implementation, because the one inside the mockable android.jar is a set
    // of stubs that throw.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20180813")
}
