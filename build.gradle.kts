plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.autofarm.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.autofarm.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // เว็บ Dashboard (โฟลเดอร์ /web ที่ราก repo) ถูกแพ็กเป็น assets และเสิร์ฟโดย LocalServer ในแอป
    sourceSets {
        getByName("main") {
            assets.srcDir(rootProject.projectDir.resolve("../web"))
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
