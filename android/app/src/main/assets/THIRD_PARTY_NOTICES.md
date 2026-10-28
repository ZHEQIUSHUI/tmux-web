# Third-party notices

## EasyTier

The Android app bundles the EasyTier v2.6.4 Android JNI libraries:

- Project: https://github.com/EasyTier/EasyTier
- Source for this version: https://github.com/EasyTier/EasyTier/tree/v2.6.4
- License: GNU Lesser General Public License v3.0 (LGPL-3.0)

The libraries are dynamically linked. They are built from the pinned commit
`8428a89d2dabc94c97d370ec607c6ca142473626` with one local change: the JNI logger level is
`Warn` instead of `Debug` so network secrets are not written to Android logcat. The complete
license text is packaged in the APK as `EasyTier-LICENSE`.
