import Combine
import Foundation

/// The outgoing share, kept alive after its sheet closes until stopped or the app exits.
final class ConfigShareService: ObservableObject {
  static let shared = ConfigShareService()

  @Published private(set) var running: ShareRunningInfo?
  @Published private(set) var starting = false
  @Published var error: String?
  /// for the QR code; holds the password, in memory only
  @Published private(set) var link: ShareLink?

  private var server: ConfigShareServer?
  private var generation = 0

  private init() {}

  func start(payload: SharedPayload, password: String, port: Int) {
    guard (1024...65535).contains(port) else { error = "端口在 1024–65535 之间"; return }
    do { try ShareProtocol.checkPassword(password) } catch { self.error = error.localizedDescription; return }
    stop()
    error = nil
    starting = true
    generation += 1
    let run = generation
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let sealed = try ShareProtocol.seal(payload, password: password)
        DispatchQueue.main.async {
          guard run == self.generation else { return }
          let server = ConfigShareServer(sealed: sealed, profileCount: payload.profiles.count, keyCount: payload.keys.count, port: port)
          server.onReady = { [weak self] info in
            guard let self, run == self.generation else { return }
            self.starting = false
            self.running = info
            self.link = info.addresses.isEmpty ? nil : ShareLink(hosts: info.addresses, port: info.port, password: password)
            self.error = nil
          }
          server.onFailure = { [weak self] message in
            guard let self, run == self.generation else { return }
            self.starting = false
            self.running = nil
            self.server = nil
            self.error = "共享服务启动失败：\(message)"
          }
          do {
            try server.start()
            self.server = server
          } catch {
            self.starting = false
            self.error = "共享服务启动失败：\(error.localizedDescription)"
          }
        }
      } catch {
        DispatchQueue.main.async {
          guard run == self.generation else { return }
          self.starting = false
          self.error = error.localizedDescription
        }
      }
    }
  }

  func stop() {
    generation += 1
    server?.stop()
    server = nil
    running = nil
    link = nil
    starting = false
  }
}
