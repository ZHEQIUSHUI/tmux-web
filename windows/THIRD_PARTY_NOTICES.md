# Third-party notices

## EasyTier

This app bundles the unmodified `easytier-core.exe`, `Packet.dll` and `wintun.dll` from the
EasyTier v2.6.4 Windows release (`easytier-windows-x86_64-v2.6.4.zip`):

- Project: https://github.com/EasyTier/EasyTier
- Source for this version: https://github.com/EasyTier/EasyTier/tree/v2.6.4
- License: GNU Lesser General Public License v3.0 (LGPL-3.0)

The full license text is included in the app at `EasyTier\LICENSE.txt`, and in this repository at
`mac/ThirdParty/EasyTier-LICENSE`.

EasyTier is run as a separate process; it is not linked into the tmux-web app. `Packet.dll` and
`wintun.dll` come with that release under their own licenses (Npcap / WireGuard LLC); the app runs
EasyTier without a TUN device and does not install drivers.

## Microsoft Edge WebView2

`Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll` and `WebView2Loader.dll`
are from the `Microsoft.Web.WebView2` NuGet package, redistributed under its license
(https://www.nuget.org/packages/Microsoft.Web.WebView2/). The WebView2 runtime itself is part of
Windows and is not bundled.
