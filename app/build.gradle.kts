plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "io.github.simpleciki.firetvprobe"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "io.github.simpleciki.firetvprobe"
        // Fire OS 6 is Android 7.1 (API 25); everything newer is covered.
        minSdk = 25
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }

    // Two builds of the same app that differ in one line of the manifest: whether it declares
    // Amazon's voice permission for media sessions. Install both side by side and run the same
    // voice step in each to see how Alexa reaches an app with and without it.
    flavorDimensions += "voice"
    productFlavors {
        create("withVoicePermission") {
            dimension = "voice"
            applicationIdSuffix = ".voice"
        }
        create("withoutVoicePermission") {
            dimension = "voice"
            applicationIdSuffix = ".novoice"
        }
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.webkit)
}
