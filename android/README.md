# DriveShare for Android TV / Google TV

A ~150-line app that opens the DriveShare site full screen in a WebView. The TV remote's D-pad
reaches the page as arrow keys (a TV browser would turn it into a mouse pointer), Back goes up a
level and closes the app at the top, and the app sits on the TV home screen with its banner.
Every screen is the website: deploying the site updates the app.

The page knows it runs in the app from `DriveShareTV/<version>` in the user agent: it shows the TV
layout and signs in with the QR code (Google's sign-in page is not allowed in apps' web views).

## Build

Needs JDK 17 and the Android SDK (`local.properties`: `sdk.dir=…`).

```sh
cd android
./gradlew assembleRelease     # app/build/outputs/apk/release/app-release.apk
```

Release signing reads `keystore.properties` (not in git):

```
storeFile=release.jks
storePassword=…
keyAlias=driveshare
keyPassword=…
```

Keep that keystore: an update must be signed with the same key or the TV refuses to install it.
Your own deployment? Change `SITE` in `app/build.gradle.kts`.

## Install on the TV (no store)

1. On the TV: Settings › Privacy (or Apps) › Security › allow unknown apps for **Downloader**
   (install Downloader from the Play Store first).
2. In Downloader, type `driveshare-p977.web.app/apk` and install.
3. Open DriveShare from the apps row; scan the QR code with your phone to sign in.
