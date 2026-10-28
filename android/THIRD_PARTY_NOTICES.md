# Third-party notices

## EasyTier

The Android app bundles EasyTier v2.6.4 as dynamically linked Android JNI libraries.

- Project: https://github.com/EasyTier/EasyTier
- Source for this version: https://github.com/EasyTier/EasyTier/tree/v2.6.4
- License: GNU Lesser General Public License v3.0 (LGPL-3.0)

The build is pinned to commit `8428a89d2dabc94c97d370ec607c6ca142473626`. The only source change
is lowering the JNI logger from `Debug` to `Warn` so EasyTier cannot print `network_secret` to
logcat. The full license text is taken from `mac/ThirdParty/EasyTier-LICENSE` and packaged in the
APK as `EasyTier-LICENSE`.
